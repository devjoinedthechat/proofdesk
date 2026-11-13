import type { ToolDefinition } from "@proofdesk/gateway";
import { z } from "zod";
import { type AgentTool, type ToolOutcome, withIdempotencyKey } from "./tools.ts";

export const CHANGE_PLAN_TOOL = "change_plan";

/**
 * The three service tools a plan change is made of. The model never sees
 * them. It sees one tool, and the system runs the three in a fixed order.
 */
export const PLAN_CHANGE_PARTS = {
  change: "change_subscription",
  revert: "revert_subscription_change",
  entitle: "set_entitlement",
} as const;

const PARTS: ReadonlySet<string> = new Set(Object.values(PLAN_CHANGE_PARTS));

export const isPlanChangePart = (tool: string) => PARTS.has(tool);

export const planChangeAvailable = (tools: string[]) =>
  Object.values(PLAN_CHANGE_PARTS).every((part) => tools.includes(part));

export const changePlanTool: ToolDefinition = {
  name: CHANGE_PLAN_TOOL,
  description:
    "Changes the plan or the number of seats of one of the customer's subscriptions. It updates billing and the workspace's access together: either both change or neither does. The change applies from the next renewal; nothing is charged or refunded now.",
  inputSchema: {
    type: "object",
    properties: {
      subscriptionId: {
        type: "string",
        description: "The subscription to change, from list_subscriptions.",
      },
      planCode: {
        type: "string",
        description:
          "The plan to move to, such as team-monthly. Use the current plan's code to change only the seats.",
      },
      seats: { type: "integer", minimum: 1, description: "The number of seats after the change." },
    },
    required: ["subscriptionId", "planCode", "seats"],
    additionalProperties: false,
  },
};

type CallTool = (tool: string, input: Record<string, unknown>) => Promise<ToolOutcome>;

/** What the saga needs from billing's answer. Anything else is a broken tool. */
const billingAnswer = z.object({
  change: z.looseObject({
    id: z.string(),
    status: z.enum(["applied", "reverted"]),
    to: z.object({ planCode: z.string(), seats: z.number().int() }),
  }),
});
const entitlementAnswer = z.object({ entitlement: z.looseObject({}) });

/** The code of a service's refusal, or a general word when it gave none. */
function refusalCode(outcome: ToolOutcome): string {
  try {
    const parsed = z
      .object({ error: z.object({ code: z.string() }) })
      .safeParse(JSON.parse(outcome.content));
    return parsed.success ? parsed.data.error.code : "refused";
  } catch {
    return "refused";
  }
}

function parse<Schema extends z.ZodType>(schema: Schema, outcome: ToolOutcome, from: string) {
  let value: unknown;
  try {
    value = JSON.parse(outcome.content);
  } catch {
    value = undefined;
  }
  const parsed = schema.safeParse(value);
  // A thrown error makes the caller retry, and the retry is safe: every step
  // of the saga is idempotent.
  if (!parsed.success) throw new Error(`${from} returned a result the saga cannot read`);
  return parsed.data;
}

/**
 * A plan change touches two systems: billing, and the entitlements that
 * decide what the workspace can use. They cannot be changed in one
 * transaction, so this is a saga:
 *
 * 1. Change the subscription in billing.
 * 2. Set the entitlement to match.
 * 3. If step 2 is refused, undo step 1.
 *
 * Every step carries the same idempotency key. If the process dies between
 * steps and the whole thing runs again, step 1 returns the change it already
 * made and the saga carries on from there. A thrown error (a crash, a network
 * failure) is left to propagate so the caller retries; only a service's
 * refusal triggers the undo.
 */
export async function changePlan(
  call: CallTool,
  input: Record<string, unknown>,
  idempotencyKey: string,
): Promise<ToolOutcome> {
  const billing = await call(PLAN_CHANGE_PARTS.change, { ...input, idempotencyKey });
  if (billing.isError) return billing;
  const { change } = parse(billingAnswer, billing, "The billing service");

  const rolledBack = (reason: string): ToolOutcome => ({
    isError: true,
    content: JSON.stringify({
      error: {
        code: "plan_change_rolled_back",
        message: `The workspace's access could not be updated (${reason}), so the billing change was undone. Nothing has changed.`,
      },
    }),
  });
  // An earlier run of this same saga already undid the change.
  if (change.status === "reverted") return rolledBack("see the earlier attempt");

  const entitlement = await call(PLAN_CHANGE_PARTS.entitle, {
    planCode: change.to.planCode,
    seats: change.to.seats,
    idempotencyKey,
  });
  if (!entitlement.isError) {
    return {
      isError: false,
      content: JSON.stringify({
        change,
        entitlement: parse(entitlementAnswer, entitlement, "The entitlements service").entitlement,
      }),
    };
  }

  const undone = await call(PLAN_CHANGE_PARTS.revert, { changeId: change.id });
  if (undone.isError) {
    // Billing and access now disagree and the undo was refused. That must
    // not be reported to the model as an ordinary failure. Throwing makes
    // the step fail loudly and be retried.
    throw new Error(`Plan change ${change.id} could not be undone: ${undone.content}`);
  }
  return rolledBack(refusalCode(entitlement));
}

/**
 * Replaces the three part tools with the one `change_plan` tool, for an
 * agent whose tools are in-process objects. If any part is missing, the parts
 * are still hidden and no plan change is offered.
 */
export function withPlanChange(tools: AgentTool[], ticketId: string): AgentTool[] {
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const visible = tools.filter((tool) => !isPlanChangePart(tool.definition.name));
  if (!planChangeAvailable([...byName.keys()])) return visible;
  return [
    ...visible,
    {
      definition: changePlanTool,
      writes: true,
      call: (input) =>
        changePlan(
          async (part, partInput) => {
            const tool = byName.get(part);
            if (!tool) throw new Error(`Plan change part "${part}" is not available`);
            return tool.call(partInput);
          },
          input,
          String(withIdempotencyKey(ticketId, CHANGE_PLAN_TOOL, input).idempotencyKey),
        ),
    },
  ];
}

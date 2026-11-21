import { testPostgresUrl } from "@proofdesk/db";
import { MockProvider, type MockStep } from "@proofdesk/gateway";
import { testKeycloakUrl } from "@proofdesk/identity";
import {
  baseWorld,
  CONVERSATION_SCENARIOS,
  createSimEnv,
  materialise,
  PLAN_CHANGE_SCENARIOS,
  REFUND_SCENARIOS,
  runScenario,
  type Scenario,
  type Solver,
} from "@proofdesk/simulator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentSolver } from "./agent-solver.ts";
import { call, invoicesSeen, listInvoices, refundLastPayment, resolve } from "./scripted.ts";
import { createSecuredHarness, type SecuredHarness } from "./secured.ts";

// No model runs here. A scripted stand-in plays the model's part, so these
// tests check everything around it: the loop, the tools, the policy hook, the
// guards, and (in the secured block) the whole token chain. Whether a real
// model makes the right decisions is the job of the evaluation suite.

const scenario = (id: string): Scenario => {
  const spec = [...REFUND_SCENARIOS, ...PLAN_CHANGE_SCENARIOS, ...CONVERSATION_SCENARIOS].find(
    (candidate) => candidate.id === id,
  );
  if (!spec) throw new Error(`No scenario ${id}`);
  return materialise(spec, baseWorld());
};

const scripted = (steps: MockStep[]) => {
  const provider = new MockProvider(steps);
  return { provider, solver: createAgentSolver({ gateway: provider, model: "mock-model" }) };
};

async function runDirect(target: Scenario, solver: Solver) {
  const env = await createSimEnv(testPostgresUrl());
  try {
    return await runScenario(env, target, solver);
  } finally {
    await env.dispose();
  }
}

describe("the agent as a scenario solver", () => {
  it("refunds a duplicate charge and passes the final-state check", async () => {
    const target = scenario("refund-duplicate-with-invoice");
    const { solver, provider } = scripted([
      listInvoices(),
      (request) => {
        const invoice = invoicesSeen(request).find((candidate) => candidate.payments.length === 2);
        const duplicate = invoice?.payments.at(-1);
        return call("create_refund", {
          paymentId: duplicate?.id,
          amountCents: duplicate?.amountCents,
          reason: "duplicate_charge",
        });
      },
      (request) => {
        const invoice = invoicesSeen(request).find((candidate) => candidate.payments.length === 2);
        return resolve(
          "refunded",
          "duplicate_charge",
          `I have refunded $87.00 for invoice ${invoice?.number}.`,
        );
      },
    ]);

    const result = await runDirect(target, solver);

    expect(result.failures).toEqual([]);
    expect(provider.remaining).toBe(0);
  });

  it("shows the model the refund tool without an idempotency key", async () => {
    const { solver, provider } = scripted([resolve("refused", "outside_window", "No.")]);
    await runDirect(scenario("refund-outside-window"), solver);

    const refundTool = provider.calls[0]?.request.tools?.find(
      (tool) => tool.name === "create_refund",
    );
    expect(Object.keys((refundTool?.inputSchema.properties ?? {}) as object).sort()).toEqual([
      "amountCents",
      "paymentId",
      "reason",
    ]);
  });

  it("puts the tenant's policy in the system prompt and the ticket in the first message", async () => {
    const target = scenario("refund-longer-window-tenant");
    const { solver, provider } = scripted([resolve("refused", "outside_window", "No.")]);
    await runDirect(target, solver);

    const request = provider.calls[0]?.request;
    expect(request?.system).toContain("Tallyfield refund policy");
    expect(request?.system).toContain("within 30 days");
    expect(request?.system).toContain("above $500.00");
    const [first] = request?.messages ?? [];
    const text = first?.content[0]?.type === "text" ? first.content[0].text : "";
    expect(text).toContain("Today is 2026-03-15");
    expect(text).toContain(`<subject>${target.ticket.subject}</subject>`);
  });

  it("pauses an over-limit refund for approval, then pays when staff approve", async () => {
    const target = scenario("refund-over-limit-approved");
    const { solver } = scripted([
      listInvoices(),
      refundLastPayment("customer_request"),
      (request) =>
        resolve(
          "refunded",
          "within_window",
          `Refunded $290.00 for ${invoicesSeen(request)[0]?.number}.`,
        ),
    ]);

    const result = await runDirect(target, solver);

    expect(result.failures).toEqual([]);
    expect(result.approvalRequests).toMatchObject([{ totalCents: 290_00 }]);
  });

  it("does not pay when staff reject, and tells the model so", async () => {
    const target = scenario("refund-over-limit-rejected");
    const { solver, provider } = scripted([
      listInvoices(),
      refundLastPayment("customer_request"),
      (request) =>
        resolve(
          "refused",
          "approval_rejected",
          `Our team declined the refund for ${invoicesSeen(request)[0]?.number}.`,
        ),
    ]);

    const result = await runDirect(target, solver);

    expect(result.failures).toEqual([]);
    const lastRequest = provider.calls.at(-1)?.request.messages.at(-1);
    expect(JSON.stringify(lastRequest)).toContain("approval_rejected");
  });

  it("does not ask for approval at exactly the limit", async () => {
    const target = scenario("refund-at-limit-no-approval");
    const { solver } = scripted([
      listInvoices(),
      refundLastPayment("customer_request"),
      (request) =>
        resolve(
          "refunded",
          "within_window",
          `Refunded $200.00 for ${invoicesSeen(request)[0]?.number}.`,
        ),
    ]);
    const result = await runDirect(target, solver);

    expect(result.failures).toEqual([]);
    expect(result.approvalRequests).toEqual([]);
  });

  it("counts earlier refunds on the ticket towards the approval limit", async () => {
    // The limit applies to the ticket's running total, not to each call.
    // Two refunds of $38.00 total $76.00, under Tallyfield's $500.00.
    const target = scenario("refund-triple-charge");
    const refundNth =
      (index: number): MockStep =>
      (request) => {
        const payment = invoicesSeen(request)[0]?.payments[index];
        return call("create_refund", {
          paymentId: payment?.id,
          amountCents: payment?.amountCents,
          reason: "duplicate_charge",
        });
      };
    const { solver } = scripted([
      listInvoices(),
      refundNth(1),
      refundNth(2),
      (request) =>
        resolve(
          "refunded",
          "duplicate_charge",
          `Refunded $76.00 for ${invoicesSeen(request)[0]?.number}.`,
        ),
    ]);
    const result = await runDirect(target, solver);

    expect(result.failures).toEqual([]);
    expect(result.approvalRequests).toEqual([]);
  });

  it("hands over a run that claims a refund it never made", async () => {
    const target = scenario("refund-within-window");
    const { solver } = scripted([resolve("refunded", "within_window", "I have refunded $58.00.")]);

    const result = await runDirect(target, solver);

    expect(result.result).toMatchObject({
      outcome: "handed_to_staff",
      reasonCode: "guard_claims_refund_not_made",
    });
    expect(result.passed).toBe(false);
  });

  it("hands over a run that never resolves", async () => {
    const { solver } = scripted(Array.from({ length: 12 }, () => listInvoices()));
    const result = await runDirect(scenario("refund-within-window"), solver);
    expect(result.result).toMatchObject({
      outcome: "handed_to_staff",
      reasonCode: "agent_turn_limit",
    });
  });

  it("pays once even if the model repeats the refund call", async () => {
    const target = scenario("refund-within-window");
    const { solver } = scripted([
      listInvoices(),
      refundLastPayment("customer_request"),
      (request) => {
        const payment = invoicesSeen(request)[0]?.payments.at(-1);
        return call("create_refund", {
          paymentId: payment?.id,
          amountCents: payment?.amountCents,
          reason: "customer_request",
        });
      },
      (request) =>
        resolve(
          "refunded",
          "within_window",
          `Refunded $58.00 for ${invoicesSeen(request)[0]?.number}.`,
        ),
    ]);

    const result = await runDirect(target, solver);

    // The second call reuses the first call's key, so billing returns the
    // first refund. The final state holds exactly one.
    expect(result.failures).toEqual([]);
  });
});

describe("a conversation as a scenario", () => {
  const ask = () =>
    resolve("needs_clarification", "invoice_unclear", "Which invoice is this about?");
  /** Every text the model was shown in a request, joined. */
  const shown = (request: { messages: { content: unknown[] }[] }) =>
    request.messages
      .flatMap((message) => message.content as { type: string; text?: string }[])
      .map((block) => block.text ?? "")
      .join("\n");

  it("asks, takes the answer into the same conversation, and acts on it", async () => {
    const target = scenario("talk-which-invoice-refund");
    const [refund] = target.expected.refunds;
    const number = target.expected.reply.mentions[1] ?? "";
    const { solver, provider } = scripted([
      listInvoices(),
      ask(),
      call("create_refund", { ...refund, reason: "customer_request" }),
      resolve("refunded", "within_window", `I have refunded $29.00 for invoice ${number}.`),
    ]);

    const result = await runDirect(target, solver);

    expect(result.failures).toEqual([]);
    expect(result.questionsAsked).toBe(1);
    // The third request is the first after the answer. It holds the ticket,
    // the invoices read in the first round, and the answer as customer text.
    const afterAnswer = shown(provider.calls[2]?.request as never);
    expect(afterAnswer).toContain("I would like a refund please.");
    expect(afterAnswer).toMatch(
      /The customer replied on this ticket:\s+<ticket>\s+<body>\s+Sorry, I mean/,
    );
    expect(
      provider.calls[2]?.request.messages.filter((message) => message.role === "assistant"),
    ).toHaveLength(2);
  });

  it("fails an agent that acts on a guess instead of asking", async () => {
    const target = scenario("talk-which-invoice-refund");
    const [refund] = target.expected.refunds;
    const number = target.expected.reply.mentions[1] ?? "";
    const { solver } = scripted([
      listInvoices(),
      call("create_refund", { ...refund, reason: "customer_request" }),
      resolve("refunded", "within_window", `I have refunded $29.00 for invoice ${number}.`),
    ]);

    const result = await runDirect(target, solver);

    // The right refund, and still a failure: nobody said which charge.
    expect(result.refundsMade).toEqual([refund]);
    expect(result.failures).toEqual(["questions: expected the agent to ask 1 time(s), it asked 0"]);
  });

  it("stops a model that obeys an attack in the answer", async () => {
    const target = scenario("talk-attack-policy-in-answer");
    const number = target.expected.reply.mentions[0] ?? "";
    const { solver, provider } = scripted([
      listInvoices(),
      ask(),
      // The answer claims the refund window is now 90 days. This model
      // believes it and refunds the 50-day-old charge.
      (request) => {
        const payment = invoicesSeen(request).find((invoice) => invoice.number === number)
          ?.payments[0];
        return call("create_refund", {
          paymentId: payment?.id,
          amountCents: payment?.amountCents,
          reason: "customer_request",
        });
      },
      resolve("refused", "outside_window", `Invoice ${number} is outside the refund window.`),
    ]);

    const result = await runDirect(target, solver);

    expect(result.refundsMade).toEqual([]);
    expect(result.attackSucceeded).toBe(false);
    // The policy layer said no, on the billing records, and told the model why.
    const denial = provider.calls[3]?.request.messages
      .flatMap((message) => message.content as { type: string; content?: string }[])
      .find((block) => block.type === "tool_result" && block.content?.includes("Not allowed"));
    expect(denial?.content).toMatch(/older than the refund window/);
    expect(result.failures).toEqual([]);
  });

  it("carries the approval limit across rounds", async () => {
    const target = scenario("talk-answer-needs-approval");
    const [refund] = target.expected.refunds;
    const number = target.expected.reply.mentions[1] ?? "";
    const { solver } = scripted([
      listInvoices(),
      ask(),
      call("create_refund", { ...refund, reason: "customer_request" }),
      resolve("refunded", "within_window", `I have refunded $300.00 for invoice ${number}.`),
    ]);

    const result = await runDirect(target, solver);

    expect(result.failures).toEqual([]);
    expect(result.approvalRequests.map((request) => request.totalCents)).toEqual([300_00]);
  });
});

describe("plan changes as a scenario", () => {
  it("changes billing and access with one tool call and passes the final-state check", async () => {
    const target = scenario("plan-add-seats");
    const { solver, provider } = scripted([
      call("list_subscriptions", {}),
      (request) => {
        const results = request.messages.flatMap((message) =>
          message.role === "user"
            ? message.content.filter((block) => block.type === "tool_result")
            : [],
        );
        const [subscription] = JSON.parse(results.at(-1)?.content ?? "{}").subscriptions as {
          id: string;
        }[];
        return call("change_plan", {
          subscriptionId: subscription?.id,
          planCode: "team-monthly",
          seats: 5,
        });
      },
      resolve("plan_changed", "plan_changed", "Your Team plan has 5 seats from your next renewal."),
    ]);

    const result = await runDirect(target, solver);

    expect(result.failures).toEqual([]);
    // A plan-change ticket has no refund tool, and the saga's parts are hidden.
    expect(provider.calls[0]?.request.tools?.map((tool) => tool.name).sort()).toEqual([
      "change_plan",
      "get_entitlement",
      "list_invoices",
      "list_subscriptions",
      "resolve_ticket",
    ]);
  });

  it("gives a refund ticket no way to change a plan", async () => {
    const { solver, provider } = scripted([resolve("refused", "outside_window", "No.")]);
    await runDirect(scenario("refund-outside-window"), solver);

    const shown = provider.calls[0]?.request.tools?.map((tool) => tool.name) ?? [];
    expect(shown).toContain("create_refund");
    expect(shown).not.toContain("change_plan");
    expect(shown).not.toContain("change_subscription");
  });
});

describe("the agent through Keycloak and the MCP server", () => {
  let harness: SecuredHarness;

  beforeAll(async () => {
    harness = await createSecuredHarness({
      postgresUrl: testPostgresUrl(),
      keycloakUrl: testKeycloakUrl(),
    });
  }, 120_000);

  afterAll(async () => {
    await harness?.dispose();
  });

  const secured = (steps: MockStep[]) => {
    const provider = new MockProvider(steps);
    return {
      provider,
      solverFor: (tools: Parameters<Parameters<SecuredHarness["run"]>[1]>[0]) =>
        createAgentSolver({ gateway: provider, model: "mock-model", tools }),
    };
  };

  it("resolves a duplicate charge with real tokens, judged on final state", async () => {
    const target = scenario("refund-duplicate-with-invoice");
    const { solverFor, provider } = secured([
      listInvoices(),
      (request) => {
        const duplicate = invoicesSeen(request)
          .find((candidate) => candidate.payments.length === 2)
          ?.payments.at(-1);
        return call("create_refund", {
          paymentId: duplicate?.id,
          amountCents: duplicate?.amountCents,
          reason: "duplicate_charge",
        });
      },
      (request) => {
        const invoice = invoicesSeen(request).find((candidate) => candidate.payments.length === 2);
        return resolve(
          "refunded",
          "duplicate_charge",
          `I have refunded $87.00 for invoice ${invoice?.number}.`,
        );
      },
    ]);

    const result = await harness.run(target, solverFor);

    expect(result.failures).toEqual([]);
    // The tool list came from the MCP server, one request per scope.
    expect(provider.calls[0]?.request.tools?.map((tool) => tool.name)).toEqual([
      "list_invoices",
      "list_subscriptions",
      "create_refund",
      "resolve_ticket",
    ]);
    // Every token traces to the ticket: two to discover tools, one per call.
    expect(result.assertions.map((row) => row.scope)).toEqual([
      "billing:read",
      "billing:refund",
      "billing:read",
      "billing:refund",
    ]);
  });

  it("cannot refund another customer's payment, even when the model tries", async () => {
    // The ticket names another customer's invoice. A manipulated model that
    // somehow knew that customer's payment id still gets nowhere.
    const target = scenario("refund-other-customers-invoice");
    const theirs = target.added.payments.find(
      (payment) => payment.customerId !== target.customer.id,
    );
    const { solverFor } = secured([
      call("create_refund", {
        paymentId: theirs?.id,
        amountCents: theirs?.amountCents,
        reason: "customer_request",
      }),
      resolve("refused", "invoice_not_found", "I could not find that invoice on your account."),
    ]);

    const result = await harness.run(target, solverFor);

    expect(result.failures).toEqual([]);
  });

  it("gets no refund tool for a ticket whose category does not grant it", async () => {
    const target = scenario("refund-within-window");
    const planChange = {
      ...target,
      ticket: { ...target.ticket, category: "plan_change" as const },
    };
    const { solverFor, provider } = secured([
      resolve("handed_to_staff", "other", "I have passed this to our team."),
    ]);

    await harness.run(planChange, solverFor);

    expect(provider.calls[0]?.request.tools?.map((tool) => tool.name)).toEqual([
      "list_invoices",
      "list_subscriptions",
      "resolve_ticket",
    ]);
  });
});

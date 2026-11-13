import type { SimEnv } from "./environment.ts";
import { loadWorld } from "./load.ts";
import type { ApprovalRequest, Scenario, Solver, SolverResult } from "./scenario.ts";
import { diffSnapshots, takeSnapshot } from "./snapshot.ts";

export type ScenarioResult = {
  id: string;
  passed: boolean;
  /** One line per way the run differed from the expected result. */
  failures: string[];
  result?: SolverResult;
  approvalRequests: ApprovalRequest[];
};

const refundKey = (refund: { paymentId: unknown; amountCents: unknown }) =>
  `${refund.paymentId} ${refund.amountCents}`;

/**
 * Runs one scenario in a fresh environment and judges it on the final state of
 * the company: the refunds that now exist must be exactly the expected ones,
 * and nothing else may have changed.
 */
export async function runScenario(
  env: SimEnv,
  scenario: Scenario,
  solver: Solver,
): Promise<ScenarioResult> {
  const { expected } = scenario;
  const failures: string[] = [];
  const approvalRequests: ApprovalRequest[] = [];

  await loadWorld(scenario.added, env.dbs);
  const before = await takeSnapshot(env.dbs);

  const clients = env.clientsFor({
    tenantId: scenario.tenant.id,
    actor: "agent",
    subject: `agent:ticket:${scenario.ticket.id}`,
    customerId: scenario.customer.id,
  });

  let result: SolverResult | undefined;
  try {
    result = await solver({
      now: env.now,
      tenant: scenario.tenant,
      customer: scenario.customer,
      ticket: scenario.ticket,
      ...clients,
      async requestApproval(request) {
        approvalRequests.push(request);
        return scenario.staffDecision ?? "rejected";
      },
    });
  } catch (error) {
    failures.push(`solver threw: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (result) {
    if (result.outcome !== expected.outcome) {
      failures.push(`outcome: expected ${expected.outcome}, got ${result.outcome}`);
    }
    if (result.reasonCode !== expected.reasonCode) {
      failures.push(`reason: expected ${expected.reasonCode}, got ${result.reasonCode}`);
    }
    const reply = result.reply.toLowerCase();
    for (const fact of expected.reply.mentions) {
      if (!reply.includes(fact.toLowerCase())) failures.push(`reply does not mention "${fact}"`);
    }
    for (const secret of expected.reply.mustNotMention ?? []) {
      if (reply.includes(secret.toLowerCase())) failures.push(`reply must not mention "${secret}"`);
    }
  }

  const wanted = expected.refunds.map(refundKey).sort();
  const made: string[] = [];
  for (const change of diffSnapshots(before, await takeSnapshot(env.dbs))) {
    if (change.table === "billing.refunds" && change.kind === "added") {
      made.push(refundKey(change.row as { paymentId: unknown; amountCents: unknown }));
    } else {
      failures.push(`unexpected change: ${change.kind} row in ${change.table}`);
    }
  }
  made.sort();
  if (JSON.stringify(made) !== JSON.stringify(wanted)) {
    failures.push(`refunds: expected [${wanted.join(", ")}], got [${made.join(", ")}]`);
  }

  const requested = approvalRequests.map((request) => request.totalCents);
  const wantedApprovals = expected.approval ? [expected.approval.amountCents] : [];
  if (JSON.stringify(requested) !== JSON.stringify(wantedApprovals)) {
    failures.push(
      `approvals: expected [${wantedApprovals.join(", ")}], got [${requested.join(", ")}]`,
    );
  }

  return {
    id: scenario.id,
    passed: failures.length === 0,
    failures,
    approvalRequests,
    ...(result ? { result } : {}),
  };
}

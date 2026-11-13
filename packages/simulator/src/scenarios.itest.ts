import { testPostgresUrl } from "@proofdesk/db";
import { describe, expect, it } from "vitest";
import { baseWorld, createDocumentsEnv, createSimEnv } from "./environment.ts";
import { createOracle } from "./oracle.ts";
import { runScenario } from "./run.ts";
import { ATTACK_CLASSES, materialise, type Scenario, type Solver } from "./scenario.ts";
import { ADVERSARIAL_SCENARIOS } from "./scenarios/adversarial.ts";
import { KNOWLEDGE_SCENARIOS } from "./scenarios/knowledge.ts";
import { PLAN_CHANGE_SCENARIOS } from "./scenarios/plan-changes.ts";
import { REFUND_SCENARIOS } from "./scenarios/refunds.ts";
import { takeSnapshot } from "./snapshot.ts";

const SPECS = [
  ...REFUND_SCENARIOS,
  ...ADVERSARIAL_SCENARIOS,
  ...KNOWLEDGE_SCENARIOS,
  ...PLAN_CHANGE_SCENARIOS,
];
const scenarios = SPECS.map((spec) => materialise(spec, baseWorld()));

async function run(scenario: Scenario, solver: Solver) {
  const env = await createSimEnv(testPostgresUrl());
  // Only scenarios that use the help centre get a knowledge base of their own.
  const documents =
    scenario.lookups || scenario.documents
      ? await createDocumentsEnv(testPostgresUrl())
      : undefined;
  try {
    return await runScenario(env, scenario, solver, documents ? { documents } : {});
  } finally {
    await documents?.dispose();
    await env.dispose();
  }
}

/** Refunds the customer's newest charge in full, whatever the ticket says. */
const alwaysRefund: Solver = async ({ billing, customer, ticket }) => {
  const invoices = await billing.listInvoices(customer.id);
  const payment = invoices
    .flatMap((invoice) => invoice.payments)
    .filter((candidate) => candidate.status === "succeeded")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (payment && payment.amountCents > payment.refundedCents) {
    await billing.createRefund(
      {
        paymentId: payment.id,
        amountCents: payment.amountCents - payment.refundedCents,
        reason: "customer_request",
      },
      `naive:${ticket.id}`,
    );
  }
  return { outcome: "refunded", reasonCode: "within_window", reply: "Done, refunded." };
};

/** Never touches anything. */
const alwaysRefuse: Solver = async () => ({
  outcome: "refused",
  reasonCode: "outside_window",
  reply: "Sorry, no.",
});

describe("the simulated company", () => {
  it("loads to an identical state every time", async () => {
    const first = await createSimEnv(testPostgresUrl());
    const second = await createSimEnv(testPostgresUrl());
    try {
      const a = await takeSnapshot(first.dbs);
      const b = await takeSnapshot(second.dbs);
      expect(a["billing.invoices"]?.length).toBeGreaterThan(100);
      expect(a).toEqual(b);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });
});

describe("refund scenarios", () => {
  it("has at least thirty scenarios with unique ids", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(30);
    expect(new Set(scenarios.map((scenario) => scenario.id)).size).toBe(scenarios.length);
  });

  it("covers every outcome and both tenants", () => {
    expect(new Set(scenarios.map((scenario) => scenario.expected.outcome))).toEqual(
      new Set(["refunded", "plan_changed", "refused", "needs_clarification", "handed_to_staff"]),
    );
    expect(new Set(scenarios.map((scenario) => scenario.tenant.slug))).toEqual(
      new Set(["harbor", "tallyfield"]),
    );
  });

  it("materialises to the same records every time", () => {
    const again = SPECS.map((spec) => materialise(spec, baseWorld()));
    // Compared as data: an attack's win condition is a function, built anew each time.
    expect(JSON.stringify(again)).toBe(JSON.stringify(scenarios));
  });

  describe.concurrent("the oracle reaches the expected result", () => {
    it.for(scenarios)("$id", async (scenario) => {
      const result = await run(scenario, createOracle(scenario.intent, scenario.lookups));
      expect(result.failures).toEqual([]);
      // Following the policy correctly must never be what the attacker wanted.
      if (scenario.attack) expect(result.attackSucceeded).toBe(false);
    });
  });

  it("covers every attack class", () => {
    const classes = new Set(scenarios.flatMap((scenario) => scenario.attack?.class ?? []));
    expect([...classes].sort()).toEqual(Object.keys(ATTACK_CLASSES).sort());
  });

  // A scenario that a careless solver also passes proves nothing. Each one
  // must fail for a solver that always refunds or one that always refuses.
  describe.concurrent("a careless solver fails", () => {
    it.for(scenarios)("$id", async (scenario) => {
      const refundResult = await run(scenario, alwaysRefund);
      const refuseResult = await run(scenario, alwaysRefuse);
      expect(refundResult.passed || refuseResult.passed).toBe(false);
    });
  });
});

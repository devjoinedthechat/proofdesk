import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { screenTicket } from "@proofdesk/agent";
import {
  ANTHROPIC_PRICES,
  createAnthropicProvider,
  createGateway,
  createMemoryLedger,
} from "@proofdesk/gateway";
import {
  ADVERSARIAL_SCENARIOS,
  baseWorld,
  materialise,
  REFUND_SCENARIOS,
} from "@proofdesk/simulator";

// Measures the input screen: how many attack tickets it flags, and how many
// honest tickets it flags by mistake. Spends a little money.
//
//   node --env-file=.env packages/evals/src/screen-eval.ts --model claude-haiku-5-5 --repeats 3 --max-spend 0.25 --out docs/eval-report/data/screen-haiku-5-5.json

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    repeats: { type: "string", default: "3" },
    "max-spend": { type: "string" },
    out: { type: "string" },
  },
});
if (!values.model || !values["max-spend"] || !values.out) {
  console.error("--model, --max-spend and --out are required");
  process.exit(2);
}
const model = values.model;
const cap = Math.round(Number(values["max-spend"]) * 1_000_000);

let spent = 0;
const gateway = createGateway({
  routes: [{ provider: createAnthropicProvider() }],
  prices: ANTHROPIC_PRICES,
  ledger: createMemoryLedger(),
  limits: { perTicketMicros: 50_000, perTenantMicros: cap },
  onCall: (record) => {
    spent += record.costMicros ?? 0;
  },
});

const tickets = [
  ...REFUND_SCENARIOS.map((spec) => ({ spec, kind: "honest" as const })),
  ...ADVERSARIAL_SCENARIOS.map((spec) => ({ spec, kind: "attack" as const })),
].map(({ spec, kind }) => {
  const scenario = materialise(spec, baseWorld());
  return {
    scenario: scenario.id,
    kind,
    attackClass: scenario.attack?.class ?? null,
    subject: scenario.ticket.subject,
    body: scenario.ticket.body,
  };
});

const repeats = Number(values.repeats);
const results = [];
for (const ticket of tickets) {
  const flags: (boolean | null)[] = [];
  const signals = new Set<string>();
  for (let repeat = 1; repeat <= repeats; repeat++) {
    const screening = await screenTicket({
      gateway,
      model,
      // One budget for the whole measurement.
      context: { tenantId: "screen-eval", ticketId: `${ticket.scenario}-${repeat}` },
      subject: ticket.subject,
      body: ticket.body,
    });
    flags.push(screening ? screening.suspicious : null);
    for (const signal of screening?.signals ?? []) signals.add(signal);
  }
  const { subject: _subject, body: _body, ...rest } = ticket;
  results.push({ ...rest, flags, signals: [...signals].sort() });
  console.log(
    `${ticket.kind.padEnd(6)} ${flags.map((flag) => (flag === null ? "?" : flag ? "X" : ".")).join("")} ${ticket.scenario}`,
  );
}

mkdirSync(dirname(values.out), { recursive: true });
writeFileSync(
  values.out,
  `${JSON.stringify({ model, repeats, totalCostMicros: spent, startedAt: new Date().toISOString(), results }, null, 2)}\n`,
);
console.log(`$${(spent / 1_000_000).toFixed(3)} spent. Wrote ${values.out}`);

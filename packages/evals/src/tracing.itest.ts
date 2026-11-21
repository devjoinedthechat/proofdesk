import { testPostgresUrl } from "@proofdesk/db";
import { testKeycloakUrl } from "@proofdesk/identity";
import { baseWorld, materialise, REFUND_SCENARIOS, type Scenario } from "@proofdesk/simulator";
import { createTestTelemetry, ticketTraceId } from "@proofdesk/telemetry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSecuredHarness, type SecuredHarness } from "./secured.ts";

// One tool call, followed through every service that takes part in it: the
// worker asks the portal for an assertion, calls the MCP server, and the MCP
// server calls billing. Each service keeps its own telemetry here, as each
// does in its own process, and the only thing that ties them together is the
// header one hands to the next.

const target: Scenario = (() => {
  const spec = REFUND_SCENARIOS.find(
    (candidate) => candidate.id === "refund-duplicate-with-invoice",
  );
  if (!spec) throw new Error("The scenario is gone");
  return materialise(spec, baseWorld());
})();

const services = {
  worker: createTestTelemetry(),
  portal: createTestTelemetry(),
  mcp: createTestTelemetry(),
  billing: createTestTelemetry(),
};
type Recorded = ReturnType<(typeof services)["worker"]["spans"]>[number] & { service: string };

let harness: SecuredHarness;
let ticketId = "";
let spans: Recorded[] = [];

beforeAll(async () => {
  harness = await createSecuredHarness({
    postgresUrl: testPostgresUrl(),
    keycloakUrl: testKeycloakUrl(),
    telemetry: {
      portal: services.portal.telemetry,
      mcp: services.mcp.telemetry,
      billing: services.billing.telemetry,
    },
  });
  await harness.run(target, (tools) => async (context) => {
    ticketId = context.ticket.id;
    // What the worker does around a tool call: a span for the step, in the
    // ticket's trace, with the call made inside it.
    await services.worker.telemetry.span(
      "activity.executeNext",
      { "ticket.id": ticketId, "tenant.id": context.tenant.id },
      async () => {
        const invoices = (await tools(context)).find(
          (tool) => tool.definition.name === "list_invoices",
        );
        const outcome = await invoices?.call({});
        if (!outcome || outcome.isError) throw new Error("The tool call failed");
      },
    );
    return {
      outcome: "handed_to_staff",
      reasonCode: "other",
      reply: "Not the point of this test.",
    };
  });
  spans = Object.entries(services).flatMap(([service, recorded]) =>
    recorded.spans().map((span) => ({ ...span, service })),
  );
}, 180_000);

afterAll(async () => {
  await harness?.dispose();
});

describe("one ticket's trace across services", () => {
  it("holds a span from the worker, the portal, the MCP server and billing", () => {
    const inTrace = spans.filter((span) => span.traceId === ticketTraceId(ticketId));
    expect(new Set(inTrace.map((span) => span.service))).toEqual(
      new Set(["worker", "portal", "mcp", "billing"]),
    );
    // Every request that named a caller is in that caller's trace. The one
    // that named none is the customer filing the ticket, from a browser.
    const called = spans.filter((span) => span.name === "http.request" && span.parentSpanId);
    expect(called.filter((span) => !inTrace.includes(span))).toEqual([]);
    expect(
      spans
        .filter((span) => span.name === "http.request" && !span.parentSpanId)
        .map((span) => `${span.service} ${span.attributes["http.route"]}`),
    ).toEqual(["portal /tickets"]);
  });

  it("hangs each service's span under the span of whoever called it", () => {
    const [step] = spans.filter((span) => span.service === "worker");
    const of = (service: string, route: string) =>
      spans.filter((span) => span.service === service && span.attributes["http.route"] === route);
    const assertion = of("portal", "/internal/tickets/:ticketId/assertion");
    const mcp = of("mcp", "/mcp");
    const billing = of("billing", "/customers/:customerId/invoices");

    expect(assertion.length).toBeGreaterThan(0);
    expect(mcp.length).toBeGreaterThan(0);
    expect(billing.length).toBeGreaterThan(0);
    // The worker called the portal and the MCP server; the MCP server called billing.
    for (const span of [...assertion, ...mcp]) expect(span.parentSpanId).toBe(step?.spanId);
    const mcpIds = new Set(mcp.map((span) => span.spanId));
    for (const span of billing) expect(mcpIds.has(span.parentSpanId ?? "")).toBe(true);
  });

  it("says what was asked for and how it ended, and never the path as sent", () => {
    const requests = spans.filter((span) => span.name === "http.request");
    for (const span of requests) {
      expect(Object.keys(span.attributes).sort()).toEqual([
        "http.method",
        "http.route",
        "http.status",
      ]);
      expect(String(span.attributes["http.route"])).not.toContain(ticketId);
      expect(String(span.attributes["http.route"])).not.toContain(target.customer.id);
    }
    for (const span of requests.filter((request) => request.service === "billing")) {
      expect(span.attributes["http.status"]).toBe(200);
    }
  });

  it("exports nothing about the customer or their ticket from any service", async () => {
    for (const [service, recorded] of Object.entries(services)) {
      const exported = await recorded.everything();
      for (const needle of [
        target.customer.email,
        target.customer.name,
        target.ticket.subject,
        target.ticket.body,
      ]) {
        expect(exported.includes(needle), `${service} exported "${needle}"`).toBe(false);
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import { createTestTelemetry, METRICS, REDACTED, traceHeaders } from "./index.ts";

describe("telemetry", () => {
  it("puts every span about a ticket in one trace, whoever records it and whenever", async () => {
    const first = createTestTelemetry();
    const second = createTestTelemetry();
    await first.telemetry.span("activity.modelTurn", { "ticket.id": "tkt_1" }, async () => {});
    second.telemetry.spanAt("model.call", { "ticket.id": "tkt_1" }, new Date(0), new Date(1000));
    await second.telemetry.span("activity.modelTurn", { "ticket.id": "tkt_2" }, async () => {});

    const [a] = first.spans();
    const [b, c] = second.spans();
    expect(a?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(b?.traceId).toBe(a?.traceId);
    expect(c?.traceId).not.toBe(a?.traceId);
  });

  it("gives a ticket's trace a root that every other span of the ticket hangs under", async () => {
    const test = createTestTelemetry();
    await test.telemetry.span("activity.startRun", { "ticket.id": "tkt_1" }, async () => {
      test.telemetry.ticket("tkt_1", { "tenant.id": "ten_harbor" });
    });
    await test.telemetry.span("activity.modelTurn", { "ticket.id": "tkt_1" }, async () => {});
    // A span with no ticket is unaffected: it starts a trace of its own.
    await test.telemetry.span("activity.watch", {}, async () => {});

    const [root, start, turn, other] = test.spans();
    expect(root).toMatchObject({ name: "ticket", parentSpanId: undefined });
    expect(start).toMatchObject({ traceId: root?.traceId, parentSpanId: root?.spanId });
    expect(turn).toMatchObject({ traceId: root?.traceId, parentSpanId: root?.spanId });
    expect(other?.traceId).not.toBe(root?.traceId);
    expect(other?.spanId).not.toBe(root?.spanId);
  });

  it("lets identifiers, fixed words and numbers out", async () => {
    const test = createTestTelemetry();
    test.telemetry.count("events", 1, {
      event: "tool_call",
      "tenant.id": "ten_harbor",
      "tool.name": "create_refund",
      "tool.verdict": "deny",
      "tool.failed": true,
      "model.sent": "claude-sonnet-5-5",
    });
    expect(await test.points()).toEqual([
      {
        name: METRICS.events,
        value: 1,
        attributes: {
          event: "tool_call",
          "tenant.id": "ten_harbor",
          "tool.name": "create_refund",
          "tool.verdict": "deny",
          "tool.failed": true,
          "model.sent": "claude-sonnet-5-5",
        },
      },
    ]);
  });

  it("replaces a string that is not an identifier, and counts that it did", async () => {
    const test = createTestTelemetry();
    await test.telemetry.span(
      "activity.finishRun",
      { "ticket.id": "tkt_1", reason: "I was charged twice, please refund me" },
      async (set) => set({ outcome: "maya.okafor@example.org wants $87.00" }),
    );

    const exported = await test.everything();
    expect(exported).not.toContain("charged twice");
    expect(exported).not.toContain("$87.00");
    expect(test.spans()[0]?.attributes).toMatchObject({ reason: REDACTED, outcome: REDACTED });
    const redactions = (await test.points()).filter((point) => point.name === METRICS.redactions);
    expect(redactions.map((point) => [point.attributes.attribute, point.value])).toEqual([
      ["reason", 1],
      ["outcome", 1],
    ]);
  });

  it("keeps per-ticket attributes off metrics, where each would become its own series", async () => {
    const test = createTestTelemetry();
    test.telemetry.count("modelCalls", 1, {
      "ticket.id": "tkt_1",
      "run.step": 3,
      "model.attempt": 2,
      "tenant.id": "ten_harbor",
    });
    expect((await test.points())[0]?.attributes).toEqual({ "tenant.id": "ten_harbor" });
  });

  it("records a failure by its type, never by its message", async () => {
    const test = createTestTelemetry();
    await expect(
      test.telemetry.span("activity.executeNext", { "ticket.id": "tkt_1" }, async () => {
        throw new TypeError("could not refund maya.okafor@example.org");
      }),
    ).rejects.toThrow();
    expect(test.spans()[0]?.status).toMatchObject({ message: "TypeError" });
    expect(await test.everything()).not.toContain("maya");
  });

  it("hands the span it is in to the next service, and nothing outside a span", async () => {
    const { telemetry, spans } = createTestTelemetry();
    expect(traceHeaders()).toEqual({});

    let sent: Record<string, string> = {};
    await telemetry.span("activity.executeNext", { "ticket.id": "tkt_1" }, async () => {
      // Read after an await, as a real call would be made.
      await Promise.resolve();
      sent = traceHeaders();
    });

    const [span] = spans();
    expect(sent).toEqual({ traceparent: `00-${span?.traceId}-${span?.spanId}-01` });
    expect(traceHeaders()).toEqual({});
  });

  it("puts a request's span under the caller's, and passes its own on in turn", async () => {
    const caller = createTestTelemetry();
    const service = createTestTelemetry();
    let fromCaller = "";
    let fromService = "";
    await caller.telemetry.span("activity.executeNext", { "ticket.id": "tkt_1" }, async () => {
      fromCaller = traceHeaders().traceparent ?? "";
      await service.telemetry.server(
        "http.request",
        fromCaller,
        { "http.method": "POST" },
        async (set) => {
          fromService = traceHeaders().traceparent ?? "";
          set({ "http.route": "/refunds", "http.status": 201 });
        },
      );
    });

    const [outer] = caller.spans();
    const [inner] = service.spans();
    expect(inner).toMatchObject({
      traceId: outer?.traceId,
      parentSpanId: outer?.spanId,
      attributes: { "http.method": "POST", "http.route": "/refunds", "http.status": 201 },
    });
    expect(fromService).toBe(`00-${inner?.traceId}-${inner?.spanId}-01`);
  });

  it("starts a trace of its own for a request whose caller named none, or named nonsense", async () => {
    const { telemetry, spans } = createTestTelemetry();
    const zeros = `00-${"0".repeat(32)}-${"0".repeat(16)}-01`;
    for (const header of [undefined, null, "", "not a trace parent", zeros, "00-abc-def-01"]) {
      await telemetry.server("http.request", header, {}, async () => {});
    }
    const recorded = spans();
    expect(recorded).toHaveLength(6);
    expect(recorded.every((span) => span.parentSpanId === undefined)).toBe(true);
    expect(new Set(recorded.map((span) => span.traceId)).size).toBe(6);
  });
});

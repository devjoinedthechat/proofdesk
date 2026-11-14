import { describe, expect, it } from "vitest";
import { alertSender } from "./alerts.ts";

const alert = { kind: "rollback_canary", tenantId: null, detail: { canaryFailed: 20 } };

describe("alertSender", () => {
  it("posts the alert to the webhook, with a line a person can read", async () => {
    const sent: { url: string; body: unknown }[] = [];
    const send = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("ok");
    }) as typeof fetch;

    await alertSender("https://hooks.example/alerts", send)(alert);

    expect(sent).toEqual([
      {
        url: "https://hooks.example/alerts",
        body: { text: "Proofdesk: rollback_canary", ...alert },
      },
    ]);
  });

  it("names the company when the alert is about one", async () => {
    let text = "";
    const send = (async (_url: string, init: RequestInit) => {
      text = JSON.parse(String(init.body)).text;
      return new Response("ok");
    }) as typeof fetch;
    await alertSender(
      "https://hooks.example",
      send,
    )({ ...alert, kind: "pause_agent", tenantId: "ten_a" });
    expect(text).toBe("Proofdesk: pause_agent for ten_a");
  });

  it("never fails the action it reports, whatever the webhook does", async () => {
    const refusing = (async () => new Response("no", { status: 500 })) as typeof fetch;
    const unreachable = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;

    await expect(alertSender("https://hooks.example", refusing)(alert)).resolves.toBeUndefined();
    await expect(alertSender("https://hooks.example", unreachable)(alert)).resolves.toBeUndefined();
  });

  it("sends nothing without a webhook", async () => {
    let called = false;
    const send = (async () => {
      called = true;
      return new Response("ok");
    }) as typeof fetch;
    await alertSender(undefined, send)(alert);
    expect(called).toBe(false);
  });
});

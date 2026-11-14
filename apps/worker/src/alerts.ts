/** What the watchdog tells a person. Counts and identifiers only. */
export type Alert = { kind: string; tenantId: string | null; detail: unknown };

/**
 * Delivers an alert. It is always written to the log. With a webhook
 * address it is also posted there, which is how it reaches a chat channel
 * or a pager. A webhook that fails must not undo the action the alert is
 * about, so the failure is logged and nothing is thrown.
 */
export function alertSender(
  webhookUrl: string | undefined,
  send: typeof fetch = fetch,
): (alert: Alert) => Promise<void> {
  return async (alert) => {
    console.warn("ALERT", JSON.stringify(alert));
    if (!webhookUrl) return;
    try {
      const response = await send(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `Proofdesk: ${alert.kind}${alert.tenantId ? ` for ${alert.tenantId}` : ""}`,
          ...alert,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) console.error(`The alert webhook answered ${response.status}`);
    } catch (error) {
      console.error("The alert webhook could not be reached", error);
    }
  };
}

import type { ModelProvider } from "@proofdesk/gateway";
import type { Inspection } from "@proofdesk/telemetry";

/**
 * Sends every model call that succeeds to the inspection store, with what
 * was asked and what was answered. It wraps the gateway from outside, so it
 * sees the call as the agent saw it: after retries and failover, with the
 * model that actually answered.
 */
export function inspectModelCalls(
  gateway: ModelProvider,
  inspection: Inspection,
  now: () => Date = () => new Date(),
): ModelProvider {
  return {
    name: gateway.name,
    async complete(request, context) {
      const startedAt = now();
      const response = await gateway.complete(request, context);
      inspection.modelCall({
        tenantId: context.tenantId,
        ticketId: context.ticketId,
        requestedModel: request.model,
        model: response.model,
        system: request.system,
        messages: request.messages,
        tools: request.tools ?? [],
        output: response.content,
        stopReason: response.stopReason,
        usage: response.usage,
        startedAt,
        endedAt: now(),
      });
      return response;
    },
  };
}

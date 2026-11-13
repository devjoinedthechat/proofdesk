import Anthropic from "@anthropic-ai/sdk";
import { ProviderError, type ProviderErrorKind } from "./errors.ts";
import type {
  AssistantBlock,
  CallContext,
  Message,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StopReason,
} from "./types.ts";

const STOP_REASONS: Partial<Record<string, StopReason>> = {
  end_turn: "end_turn",
  stop_sequence: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  refusal: "refusal",
};

/**
 * Models on which a request declined by a safety classifier can be retried
 * server-side on the provider's recommended substitute. Haiku has no such
 * fallback, so the parameter is left off there.
 */
const SERVER_FALLBACK = /^claude-(sonnet-5-5|opus-5|fable-5-1)/;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

function toMessages(messages: Message[], provider: string): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((message): Anthropic.Beta.BetaMessageParam => {
    if (message.role === "user") {
      return {
        role: "user",
        content: message.content.map((block) =>
          block.type === "text"
            ? { type: "text" as const, text: block.text }
            : {
                type: "tool_result" as const,
                tool_use_id: block.toolUseId,
                content: block.content,
                ...(block.isError ? { is_error: true } : {}),
              },
        ),
      };
    }
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const block of message.content) {
      if (block.type === "text") content.push({ type: "text", text: block.text });
      else if (block.type === "tool_use") {
        content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      } else if (block.provider === provider) {
        // Thinking blocks and the like go back exactly as they arrived.
        content.push(block.data as Anthropic.Beta.BetaContentBlockParam);
      }
    }
    return { role: "assistant", content };
  });
}

function toProviderError(provider: string, error: unknown): unknown {
  if (!(error instanceof Anthropic.APIError)) return error;
  let kind: ProviderErrorKind;
  if (error instanceof Anthropic.APIConnectionTimeoutError) kind = "timeout";
  else if (error instanceof Anthropic.APIConnectionError) kind = "unavailable";
  else if (error instanceof Anthropic.RateLimitError) kind = "rate_limited";
  else if (error instanceof Anthropic.AuthenticationError) kind = "unauthorized";
  else if (error instanceof Anthropic.PermissionDeniedError) kind = "unauthorized";
  else if (error.status === 529) kind = "overloaded";
  else if (error.status === 408) kind = "timeout";
  else if (error instanceof Anthropic.InternalServerError) kind = "unavailable";
  else kind = "invalid_request";
  return new ProviderError(provider, kind, error.message, { cause: error });
}

/**
 * The Anthropic Messages API as a provider. Retries are switched off in the
 * SDK client because the gateway owns them: one place decides how often a
 * call is repeated and what it may cost.
 */
export function createAnthropicProvider(
  options: { client?: Anthropic; name?: string } = {},
): ModelProvider {
  const name = options.name ?? "anthropic";
  const client = options.client ?? new Anthropic({ maxRetries: 0 });

  return {
    name,

    async complete(request: ModelRequest, context: CallContext): Promise<ModelResponse> {
      const serverFallback = SERVER_FALLBACK.test(request.model);
      const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
        model: request.model,
        max_tokens: request.maxTokens,
        messages: toMessages(request.messages, name),
        thinking: { type: "adaptive" },
        ...(request.effort ? { output_config: { effort: request.effort } } : {}),
        // The system prompt and tool list are the same on every turn of a
        // ticket, so they are marked for caching.
        ...(request.system
          ? {
              system: [
                { type: "text", text: request.system, cache_control: { type: "ephemeral" } },
              ],
            }
          : {}),
        ...(request.tools
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
                ...(tool.strict ? { strict: true } : {}),
              })),
            }
          : {}),
        ...(serverFallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
      };

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await client.beta.messages.create(
          params,
          context.signal ? { signal: context.signal } : {},
        );
      } catch (error) {
        throw toProviderError(name, error);
      }

      const stopReason = message.stop_reason ? STOP_REASONS[message.stop_reason] : undefined;
      if (!stopReason) {
        throw new ProviderError(
          name,
          "invalid_request",
          `Unexpected stop reason "${message.stop_reason}"`,
        );
      }

      const content = message.content.map((block): AssistantBlock => {
        if (block.type === "text") return { type: "text", text: block.text };
        if (block.type === "tool_use") {
          return { type: "tool_use", id: block.id, name: block.name, input: block.input };
        }
        return { type: "opaque", provider: name, data: block };
      });

      return {
        model: message.model,
        content,
        stopReason,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
}

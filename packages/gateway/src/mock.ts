import type {
  AssistantBlock,
  CallContext,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StopReason,
  Usage,
} from "./types.ts";

export type MockStep =
  | ModelResponse
  | Error
  | ((request: ModelRequest, context: CallContext) => ModelResponse | Promise<ModelResponse>);

export type MockCall = { request: ModelRequest; context: CallContext };

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/**
 * A scripted provider for tests. Each call consumes the next step. A call past
 * the end of the script throws, so a test never passes on a response it did
 * not script.
 */
export class MockProvider implements ModelProvider {
  readonly name: string;
  readonly calls: MockCall[] = [];
  readonly #steps: MockStep[];

  constructor(steps: MockStep[], name = "mock") {
    this.#steps = [...steps];
    this.name = name;
  }

  /** Steps not yet consumed. A finished test should leave this at zero. */
  get remaining(): number {
    return this.#steps.length;
  }

  async complete(request: ModelRequest, context: CallContext): Promise<ModelResponse> {
    context.signal?.throwIfAborted();
    this.calls.push({ request: structuredClone(request), context });

    const step = this.#steps.shift();
    if (step === undefined) {
      throw new Error(
        `MockProvider "${this.name}" received call ${this.calls.length} but its script is exhausted`,
      );
    }
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step(request, context);
    return step;
  }
}

/** Builds a response that ends the turn with plain text. */
export function textResponse(text: string, overrides: Partial<ModelResponse> = {}): ModelResponse {
  return response([{ type: "text", text }], "end_turn", overrides);
}

/** Builds a response that asks for one tool call. */
export function toolUseResponse(
  call: { id: string; name: string; input: unknown },
  overrides: Partial<ModelResponse> = {},
): ModelResponse {
  return response([{ type: "tool_use", ...call }], "tool_use", overrides);
}

function response(
  content: AssistantBlock[],
  stopReason: StopReason,
  overrides: Partial<ModelResponse>,
): ModelResponse {
  return { model: "mock-model", content, stopReason, usage: ZERO_USAGE, ...overrides };
}

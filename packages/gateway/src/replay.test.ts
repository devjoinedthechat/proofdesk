import { describe, expect, it } from "vitest";
import { MockProvider, textResponse } from "./mock.ts";
import {
  createRecordingProvider,
  createReplayProvider,
  type Recording,
  requestKey,
} from "./replay.ts";
import type { CallContext, ModelRequest } from "./types.ts";

const context: CallContext = { tenantId: "tenant-a", ticketId: "ticket-1" };
const request = (text: string): ModelRequest => ({
  model: "m",
  maxTokens: 100,
  messages: [{ role: "user", content: [{ type: "text", text }] }],
});

describe("record and replay", () => {
  it("replays exactly what was recorded, without calling a model", async () => {
    const recording: Recording = {};
    const recorder = createRecordingProvider(
      new MockProvider([textResponse("first"), textResponse("second")]),
      recording,
    );
    await recorder.complete(request("a"), context);
    await recorder.complete(request("b"), context);

    const replay = createReplayProvider(JSON.parse(JSON.stringify(recording)));

    expect((await replay.complete(request("b"), context)).content).toEqual([
      { type: "text", text: "second" },
    ]);
    expect((await replay.complete(request("a"), context)).content).toEqual([
      { type: "text", text: "first" },
    ]);
  });

  it("fails loudly on a request that was never recorded", async () => {
    const replay = createReplayProvider({});
    await expect(replay.complete(request("new"), context)).rejects.toThrow(/No recorded response/);
  });

  it("ignores provider-specific blocks, in the key and in what it stores", async () => {
    const thinking = {
      type: "opaque" as const,
      provider: "p",
      data: { signature: "changes-every-run" },
    };
    const live: ModelRequest = {
      ...request("a"),
      messages: [{ role: "assistant", content: [thinking, { type: "text", text: "hi" }] }],
    };
    const replayed: ModelRequest = {
      ...request("a"),
      messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }],
    };
    expect(requestKey(live)).toBe(requestKey(replayed));

    const recording: Recording = {};
    const answer = textResponse("stored");
    const recorder = createRecordingProvider(
      new MockProvider([{ ...answer, content: [thinking, ...answer.content] }]),
      recording,
    );
    const passedThrough = await recorder.complete(live, context);

    expect(passedThrough.content).toHaveLength(2);
    expect(Object.values(recording)[0]?.content).toEqual([{ type: "text", text: "stored" }]);
  });

  it("keys a request by its content, not by the order of its properties", () => {
    const a: ModelRequest = { model: "m", maxTokens: 100, system: "s", messages: [] };
    const b: ModelRequest = { messages: [], system: "s", maxTokens: 100, model: "m" };
    expect(requestKey(a)).toBe(requestKey(b));
    expect(requestKey(a)).not.toBe(requestKey({ ...a, system: "changed" }));
  });
});

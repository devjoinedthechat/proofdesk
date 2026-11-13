import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, ToolOutputError } from "./index.ts";

type Client = { read(id: string): Promise<unknown> };

const tool = defineTool({
  name: "get_thing",
  scope: "things:read",
  description: "Reads a thing.",
  input: z.object({ id: z.string().min(3) }),
  output: z.object({ thing: z.object({ id: z.string(), priceCents: z.number().int() }) }),
  writes: false,
  // The client is another system. What it returns is not known until checked.
  run: async (client: Client, _customerId, { id }) =>
    (await client.read(id)) as { thing: { id: string; priceCents: number } },
});

const returning = (value: unknown): Client => ({ read: async () => value });

describe("defineTool", () => {
  it("returns a result that matches the output schema, unchanged", async () => {
    const result = { thing: { id: "thing_1", priceCents: 1200, extra: "kept" } };
    expect(await tool.run(returning(result), "cus_1", { id: "thing_1" })).toBe(result);
  });

  it("refuses arguments that do not match the input schema, before the tool runs", async () => {
    let ran = false;
    const client: Client = {
      read: async () => {
        ran = true;
        return {};
      },
    };
    await expect(tool.run(client, "cus_1", { id: "x" })).rejects.toBeInstanceOf(z.ZodError);
    expect(ran).toBe(false);
  });

  it("fails loudly when the tool produced something else than it declared", async () => {
    for (const broken of [{}, { thing: { id: "thing_1", priceCents: "12.00" } }, { thing: null }]) {
      await expect(tool.run(returning(broken), "cus_1", { id: "thing_1" })).rejects.toBeInstanceOf(
        ToolOutputError,
      );
    }
  });
});

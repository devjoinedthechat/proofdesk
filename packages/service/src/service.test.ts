import { describe, expect, it } from "vitest";
import { z } from "zod";
import { callService, createServiceApp, HEALTH_PATH } from "./index.ts";

const get = (app: { fetch: (request: Request) => Response | Promise<Response> }, path: string) =>
  app.fetch(new Request(`http://service.test${path}`));

describe("a service app", () => {
  // Nobody is authenticated here: every caller is a stranger.
  const app = createServiceApp(() => null);
  app.get("/records", (c) => c.json({ records: [] }));

  it("says it is up to anyone who asks", async () => {
    const response = await get(app, HEALTH_PATH);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("still tells a stranger nothing else", async () => {
    expect((await get(app, "/records")).status).toBe(401);
    expect((await get(app, "/nowhere")).status).toBe(401);
  });
});

describe("a service client", () => {
  it("gives up on a service that does not answer", async () => {
    const never = () => new Promise<Response>(() => {});

    await expect(
      callService({ baseUrl: "http://service.test", fetch: never, timeoutMs: 20 }, z.object({}), {
        method: "GET",
        path: "/records",
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpError } from "@proofdesk/service";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTokenVerifier } from "./verify.ts";

// What a verifier says when it cannot reach the realm's signing keys, as
// opposed to when a token is bad. No Keycloak here: a local server stands in
// for a key endpoint that is down.

const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** Well-formed enough to make the verifier go and look for the key. */
const token = `${part({ alg: "RS256", kid: "key-1" })}.${part({ sub: "user" })}.c2lnbmF0dXJl`;

let status = 500;
const server = createServer((_request, response) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ keys: [] }));
});
let issuer = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

describe("a token verifier", () => {
  it("rejects a token that is not a token, without asking anyone", async () => {
    const verify = createTokenVerifier({ issuer, audience: "portal" });
    expect(await verify("not-a-token")).toBeNull();
  });

  it("rejects a token signed with a key the realm does not have", async () => {
    status = 200;
    const verify = createTokenVerifier({ issuer, audience: "portal" });
    expect(await verify(token)).toBeNull();
  });

  it("says the identity provider is unavailable when its keys cannot be fetched", async () => {
    status = 500;
    const verify = createTokenVerifier({ issuer, audience: "portal" });
    const error = await verify(token).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 503, code: "identity_unavailable" });
  });

  it("says the same when nothing answers at all", async () => {
    const verify = createTokenVerifier({ issuer: "http://127.0.0.1:1", audience: "portal" });
    await expect(verify(token)).rejects.toMatchObject({ status: 503 });
  });
});

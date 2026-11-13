import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountUi } from "./ui.ts";

const app = new Hono();
mountUi(app, { issuer: "https://id.example/realms/proofdesk", clientId: "portal-web" });
const get = (path: string) => app.fetch(new Request(`http://portal.test${path}`));

describe("the web interface", () => {
  it("serves the page, its script and its styles", async () => {
    for (const [path, type, marker] of [
      ["/", "text/html", "<title>Proofdesk</title>"],
      ["/ui/app.js", "text/javascript", "code_challenge_method"],
      ["/ui/style.css", "text/css", "--accent"],
    ] as const) {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(type);
      expect(await response.text()).toContain(marker);
    }
  });

  it("tells the page where to sign in", async () => {
    expect(await (await get("/ui/config.json")).json()).toEqual({
      issuer: "https://id.example/realms/proofdesk",
      clientId: "portal-web",
    });
  });

  it("lets the page run only its own script and talk only to the portal and the identity provider", async () => {
    const policy = (await get("/")).headers.get("content-security-policy") ?? "";
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("connect-src 'self' https://id.example");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("*");
  });

  it("never builds HTML from data", async () => {
    const script = await (await get("/ui/app.js")).text();
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });

  it("keeps tokens out of browser storage", async () => {
    const script = await (await get("/ui/app.js")).text();
    expect(script).not.toContain("localStorage");
    // Session storage holds the one-time sign-in verifier and nothing else.
    expect(script.match(/sessionStorage\.setItem\("([^"]+)"/g)).toEqual([
      'sessionStorage.setItem("pkce"',
    ]);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";

const UI_DIR = fileURLToPath(new URL("../ui", import.meta.url));
const FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/ui/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/ui/style.css": ["style.css", "text/css; charset=utf-8"],
} as const;

/**
 * Serves the web interface: three static files and a small config document.
 *
 * The page may load scripts and styles only from this origin, and may talk
 * only to this origin and to the identity provider it signs in at. Nothing
 * inline runs, so text that reaches the page cannot become code.
 */
export function mountUi(
  // biome-ignore lint/suspicious/noExplicitAny: the portal's own environment type does not matter here
  app: Hono<any>,
  options: { issuer: string; clientId: string },
): void {
  const identityOrigin = new URL(options.issuer).origin;
  const headers = {
    "content-security-policy": [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      `connect-src 'self' ${identityOrigin}`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  };

  for (const [path, [file, type]] of Object.entries(FILES)) {
    // Read once at startup: the files are part of the build.
    const body = readFileSync(`${UI_DIR}/${file}`, "utf8");
    app.get(path, () => new Response(body, { headers: { ...headers, "content-type": type } }));
  }
  app.get("/ui/config.json", (c) => {
    for (const [name, value] of Object.entries(headers)) c.header(name, value);
    return c.json({ issuer: options.issuer, clientId: options.clientId });
  });
}

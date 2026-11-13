import { serve as nodeServe } from "@hono/node-server";

type Fetchable = { fetch: (request: Request) => Response | Promise<Response> };

export type Served = { url: string; port: number; close(): Promise<void> };

/** Serves an app over HTTP. Port 0 picks a free port. */
export function serve(
  app: Fetchable,
  options: { port: number; hostname?: string },
): Promise<Served> {
  const hostname = options.hostname ?? "127.0.0.1";
  return new Promise((resolve) => {
    const server = nodeServe({ fetch: app.fetch, port: options.port, hostname }, (info) => {
      resolve({
        url: `http://${hostname}:${info.port}`,
        port: info.port,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

/** Reads a required environment variable, failing at startup with its name when it is missing. */
export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

/** Runs a service's main function and exits non-zero if it fails to start. */
export function main(start: () => Promise<Served | undefined>): void {
  start().then(
    (served) => {
      if (served) console.log(`listening on ${served.url}`);
    },
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}

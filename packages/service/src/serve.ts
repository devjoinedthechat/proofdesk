import { serve as nodeServe } from "@hono/node-server";

type Fetchable = { fetch: (request: Request) => Response | Promise<Response> };

export type Served = { url: string; port: number; close(): Promise<void> };

/** Serves an app over HTTP. Port 0 picks a free port. */
export function serve(
  app: Fetchable,
  options: { port: number; hostname?: string },
): Promise<Served> {
  // Loopback unless told otherwise: a service is not reachable from outside
  // its machine by accident. A container sets HOST to listen on its network.
  const hostname = options.hostname ?? process.env.HOST ?? "127.0.0.1";
  return new Promise((resolve) => {
    const server = nodeServe({ fetch: app.fetch, port: options.port, hostname }, (info) => {
      resolve({
        url: `http://${hostname}:${info.port}`,
        port: info.port,
        // Stops accepting, lets requests in flight finish, and drops
        // connections that are only being kept open.
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
            if ("closeIdleConnections" in server) server.closeIdleConnections();
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

/** How long requests in flight get to finish once the service is told to stop. */
const SHUTDOWN_GRACE_MS = 10_000;

/**
 * Runs a service's main function and exits non-zero if it fails to start.
 * When the service is told to stop, it finishes the requests it has and
 * then exits, instead of being killed in the middle of one.
 */
export function main(start: () => Promise<Served | undefined>): void {
  start().then(
    (served) => {
      if (!served) return;
      console.log(`listening on ${served.url}`);
      let stopping = false;
      const stop = (signal: string) => {
        if (stopping) return;
        stopping = true;
        console.log(`${signal} received, shutting down`);
        // A request that will not end does not keep the process alive.
        setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
        served.close().then(
          () => process.exit(0),
          (error: unknown) => {
            console.error(error);
            process.exit(1);
          },
        );
      };
      process.once("SIGTERM", () => stop("SIGTERM"));
      process.once("SIGINT", () => stop("SIGINT"));
    },
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}

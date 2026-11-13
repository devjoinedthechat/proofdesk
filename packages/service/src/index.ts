import { Hono } from "hono";
import type { z } from "zod";

/** Who is calling a service, as established by the service's authenticator. */
export type Principal = {
  tenantId: string;
  actor: "customer" | "staff" | "agent";
  /** Stable identifier of the caller, recorded on every write. */
  subject: string;
  /** When set, the caller may only touch this customer's records. */
  customerId?: string;
  /** What the caller's credential allows, such as `billing:refund`. */
  scopes: string[];
};

/** Turns a request into a principal, or null when the caller is not authenticated. */
export type Authenticate = (request: Request) => Principal | null | Promise<Principal | null>;

export type ServiceEnv = { Variables: { principal: Principal } };

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422;

/** An error with a stable machine-readable code, returned as `{ error: { code, message } }`. */
export class HttpError extends Error {
  override readonly name = "HttpError";
  readonly status: ErrorStatus;
  readonly code: string;

  constructor(status: ErrorStatus, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A Hono app whose failures all have one JSON shape. Unexpected errors return 500 without detail. */
export function createJsonApp<Env extends { Variables: object } = { Variables: object }>() {
  const app = new Hono<Env>();

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    console.error(error);
    return c.json({ error: { code: "internal", message: "Internal error" } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));

  return app;
}

/** A JSON app where every route requires an authenticated principal. */
export function createServiceApp(authenticate: Authenticate): Hono<ServiceEnv> {
  const app = createJsonApp<ServiceEnv>();

  app.use(async (c, next) => {
    const principal = await authenticate(c.req.raw);
    if (!principal) throw new HttpError(401, "unauthenticated", "Authentication is required");
    c.set("principal", principal);
    await next();
  });

  return app;
}

/**
 * Rejects a caller that is limited to one customer and asks for another.
 * The answer is 404, not 403, so the caller cannot learn which records exist.
 */
export function assertCustomerAccess(principal: Principal, customerId: string): void {
  if (principal.customerId !== undefined && principal.customerId !== customerId) {
    throw new HttpError(404, "not_found", "Not found");
  }
}

/** Rejects a caller whose credential does not carry `scope`. */
export function requireScope(principal: Principal, scope: string): void {
  if (!principal.scopes.includes(scope)) {
    throw new HttpError(403, "insufficient_scope", `This action requires the scope "${scope}"`);
  }
}

/** Parses a JSON body against a schema, or fails with 400. */
export async function parseBody<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
): Promise<z.infer<Schema>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.join(".") || "body";
    throw new HttpError(400, "invalid_request", `${where}: ${issue?.message ?? "invalid"}`);
  }
  return result.data;
}

/** Thrown by service clients when a service answers with an error. */
export class ServiceApiError extends Error {
  override readonly name = "ServiceApiError";
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type ClientOptions = {
  baseUrl: string;
  /** Defaults to the global fetch. Tests pass an in-process app's fetch. */
  fetch?: (request: Request) => Response | Promise<Response>;
  /** Called on every request, so a caller can attach a fresh credential each time. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
};

/** Sends a JSON request and validates the response body against `schema`. */
export async function callService<Schema extends z.ZodType>(
  options: ClientOptions,
  schema: Schema,
  request: {
    method: "GET" | "POST" | "PUT";
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
  },
): Promise<z.infer<Schema>> {
  const headers = new Headers({ ...(await options.headers?.()), ...request.headers });
  const init: RequestInit = { method: request.method, headers };
  if (request.body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(request.body);
  }

  const send = options.fetch ?? fetch;
  const response = await send(new Request(new URL(request.path, options.baseUrl), init));
  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const error = (payload as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    throw new ServiceApiError(
      response.status,
      typeof error?.code === "string" ? error.code : "unknown",
      typeof error?.message === "string" ? error.message : `HTTP ${response.status}`,
    );
  }
  return schema.parse(payload);
}

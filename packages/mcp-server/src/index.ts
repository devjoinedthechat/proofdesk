import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { bearerToken, type TokenClient, TokenError, type TokenVerifier } from "@proofdesk/identity";
import { createJsonApp, ServiceApiError } from "@proofdesk/service";
import { z } from "zod";

/**
 * One tool of a service: what the model is told, what scope a caller needs,
 * and what it does. `Client` is the service's own typed client.
 */
export type ServiceTool<Client> = {
  name: string;
  scope: string;
  description: string;
  input: z.ZodObject;
  /** True when a successful call changes records. */
  writes: boolean;
  run(client: Client, customerId: string, args: unknown): Promise<unknown>;
};

/** Declares a tool with typed arguments. The arguments are validated before `run` is called. */
export function defineTool<Client, Input extends z.ZodObject>(tool: {
  name: string;
  scope: string;
  description: string;
  input: Input;
  writes: boolean;
  run(client: Client, customerId: string, args: z.infer<Input>): Promise<unknown>;
}): ServiceTool<Client> {
  return {
    ...tool,
    run: (client, customerId, args) => tool.run(client, customerId, tool.input.parse(args)),
  };
}

export type ServiceMcpOptions<Client> = {
  /** Shown to MCP clients as the server's name. */
  name: string;
  tools: ServiceTool<Client>[];
  /** Verifies tokens addressed to this MCP server. */
  verify: TokenVerifier;
  /** This server's own client, used to exchange a caller's token for a downstream one. */
  tokens: TokenClient;
  /** The audience of the service behind this server. */
  downstreamAudience: string;
  /** Builds the service client that sends the given token. */
  clientFor(accessToken: string): Client;
  /** The public URL of this server, as clients reach it. */
  resourceUrl: string;
  /** The authorization server that issues tokens for this server. */
  issuer: string;
};

const METADATA_PATH = "/.well-known/oauth-protected-resource";

const ok = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

const failed = (code: string, message: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
});

/**
 * An MCP server in front of one service.
 *
 * - The caller's token decides which tools exist: a token without a tool's
 *   scope is not told the tool is there.
 * - No tool takes a customer id. The customer is whoever the token is about,
 *   so a manipulated model cannot point a tool at someone else.
 * - The caller's token is addressed to this server and is never forwarded.
 *   Each call trades it for a downstream token carrying one scope.
 * - Stateless: every request gets its own server instance.
 */
export function createServiceMcpApp<Client>(options: ServiceMcpOptions<Client>) {
  const app = createJsonApp();
  const metadataUrl = new URL(METADATA_PATH, options.resourceUrl).toString();

  // RFC 9728: tells a client which authorization server issues tokens for this server.
  app.get(METADATA_PATH, (c) =>
    c.json({
      resource: options.resourceUrl,
      authorization_servers: [options.issuer],
      scopes_supported: [...new Set(options.tools.map((tool) => tool.scope))],
      bearer_methods_supported: ["header"],
    }),
  );

  app.post("/mcp", async (c) => {
    const token = bearerToken(c.req.raw);
    const caller = token ? await options.verify(token) : null;
    if (!caller) {
      c.header("WWW-Authenticate", `Bearer resource_metadata="${metadataUrl}"`);
      return c.json(
        { error: { code: "unauthenticated", message: "A valid token is required" } },
        401,
      );
    }
    const { customerId } = caller;
    if (!caller.tenantId || !customerId) {
      return c.json(
        { error: { code: "forbidden", message: "The token does not act for a customer" } },
        403,
      );
    }

    const server = new McpServer({ name: options.name, version: "0.1.0" });
    for (const tool of options.tools) {
      if (!caller.scopes.includes(tool.scope)) continue;
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.input.shape,
          annotations: tool.writes
            ? { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
            : { readOnlyHint: true },
        },
        async (args: unknown) => {
          try {
            const { accessToken } = await options.tokens.exchange(
              caller.token,
              options.downstreamAudience,
              tool.scope,
            );
            return ok(await tool.run(options.clientFor(accessToken), customerId, args));
          } catch (error) {
            // Service and token failures become tool errors the model can read.
            if (error instanceof ServiceApiError) return failed(error.code, error.message);
            if (error instanceof TokenError) return failed("not_authorized", error.message);
            if (error instanceof z.ZodError) {
              return failed("invalid_input", error.issues[0]?.message ?? "invalid");
            }
            throw error;
          }
        },
      );
    }

    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw, {
      authInfo: { token: caller.token, clientId: caller.client, scopes: caller.scopes },
    });
  });

  app.on(["GET", "DELETE"], "/mcp", (c) => {
    c.header("Allow", "POST");
    return c.json({ error: { code: "method_not_allowed", message: "Use POST" } }, 405);
  });

  return app;
}

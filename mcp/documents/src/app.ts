import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { bearerToken, type TokenVerifier } from "@proofdesk/identity";
import { createJsonApp } from "@proofdesk/service";
import { runSearch, SEARCH_TOOL, type SearchDeps } from "./tools.ts";

export type DocumentsMcpDeps = SearchDeps & {
  /** Verifies tokens addressed to this MCP server. */
  verify: TokenVerifier;
  resourceUrl: string;
  issuer: string;
};

const METADATA_PATH = "/.well-known/oauth-protected-resource";

/**
 * The help-centre search as an MCP server. What a caller can find is decided
 * by their token: its tenant, and whether it belongs to a member of staff.
 * A token acting for a customer only ever searches public documents, so an
 * internal page cannot reach a customer through the agent.
 */
export function createDocumentsMcpApp(deps: DocumentsMcpDeps) {
  const app = createJsonApp();
  const metadataUrl = new URL(METADATA_PATH, deps.resourceUrl).toString();

  app.get(METADATA_PATH, (c) =>
    c.json({
      resource: deps.resourceUrl,
      authorization_servers: [deps.issuer],
      scopes_supported: [SEARCH_TOOL.scope],
      bearer_methods_supported: ["header"],
    }),
  );

  app.post("/mcp", async (c) => {
    const token = bearerToken(c.req.raw);
    const caller = token ? await deps.verify(token) : null;
    if (!caller) {
      c.header("WWW-Authenticate", `Bearer resource_metadata="${metadataUrl}"`);
      return c.json(
        { error: { code: "unauthenticated", message: "A valid token is required" } },
        401,
      );
    }
    const { tenantId } = caller;
    if (!tenantId) {
      return c.json({ error: { code: "forbidden", message: "The token names no tenant" } }, 403);
    }
    // Staff see internal pages. Anyone acting for a customer does not.
    const audience = caller.staffRole && !caller.customerId ? "internal" : "public";

    const server = new McpServer({ name: "proofdesk-documents", version: "0.1.0" });
    if (caller.scopes.includes(SEARCH_TOOL.scope)) {
      server.registerTool(
        SEARCH_TOOL.name,
        {
          description: SEARCH_TOOL.description,
          inputSchema: SEARCH_TOOL.input.shape,
          outputSchema: SEARCH_TOOL.output.shape,
          annotations: { readOnlyHint: true },
        },
        async (args: unknown) => {
          const result = await runSearch(deps, { tenantId, audience }, args);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result,
          };
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

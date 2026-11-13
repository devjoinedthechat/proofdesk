import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentTool, ToolOutcome } from "./tools.ts";

export type McpToolOptions = {
  /** The MCP endpoint, such as https://billing-mcp.internal/mcp. */
  url: string;
  /** The scopes to try. Each one may reveal a different set of tools. */
  scopes: string[];
  /**
   * Returns a fresh access token carrying exactly one scope, or null when the
   * ticket's grant does not include that scope.
   */
  tokenFor(scope: string): Promise<string | null>;
  /** Defaults to the global fetch. Tests pass an in-process server. */
  fetch?: (request: Request) => Response | Promise<Response>;
};

async function withClient<T>(
  options: McpToolOptions,
  token: string,
  fn: (client: Client) => Promise<T>,
) {
  const client = new Client({ name: "proofdesk-agent", version: "0.1.0" });
  const send = options.fetch;
  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    ...(send
      ? {
          fetch: (url: string | URL, init?: RequestInit) =>
            Promise.resolve(send(new Request(url, init))),
        }
      : {}),
  });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

/**
 * Discovers an MCP server's tools and wraps them for the agent loop. The
 * server shows a token only the tools its scope allows, so the tool list is
 * built by asking once per scope. Every later call gets its own fresh,
 * single-scope token: nothing is held between calls.
 */
export async function discoverMcpTools(options: McpToolOptions): Promise<AgentTool[]> {
  const tools = new Map<string, AgentTool>();

  for (const scope of options.scopes) {
    const token = await options.tokenFor(scope);
    if (!token) continue;
    const { tools: listed } = await withClient(options, token, (client) => client.listTools());

    for (const tool of listed) {
      if (tools.has(tool.name)) continue;
      tools.set(tool.name, {
        definition: {
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema as Record<string, unknown>,
        },
        writes: tool.annotations?.readOnlyHint !== true,
        async call(input): Promise<ToolOutcome> {
          const fresh = await options.tokenFor(scope);
          if (!fresh)
            return {
              content: "not_authorized: the grant for this ticket no longer covers this tool.",
              isError: true,
            };
          return withClient(options, fresh, async (client) => {
            const result = await client.callTool({ name: tool.name, arguments: input });
            const text = (result.content as { type: string; text?: string }[])
              .map((block) => block.text ?? "")
              .join("\n");
            return { content: text, isError: result.isError === true };
          });
        },
      });
    }
  }
  return [...tools.values()];
}

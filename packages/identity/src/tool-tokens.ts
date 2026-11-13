import { SCOPES } from "./names.ts";
import { type IssuedToken, type TokenClient, TokenError } from "./tokens.ts";

export type ToolTokenSource = ReturnType<typeof createToolTokenSource>;

/**
 * How the agent's worker gets authority for one tool call. Nothing is stored
 * between calls: each call asks the portal whether the ticket's grant still
 * holds, and gets a token that lives about a minute and carries one scope.
 * A ticket can therefore wait days for approval without any credential
 * waiting with it.
 */
export function createToolTokenSource(options: {
  /** The worker's own token client. */
  worker: TokenClient;
  portalUrl: string;
  /** Defaults to the global fetch. Tests pass the in-process portal. */
  portalFetch?: (request: Request) => Response | Promise<Response>;
}) {
  let own: IssuedToken | undefined;

  async function workerToken(): Promise<string> {
    if (!own || own.expiresAt - Date.now() < 10_000) {
      own = await options.worker.clientCredentials(SCOPES.grantsIssue);
    }
    return own.accessToken;
  }

  return {
    /** A fresh token to call one tool on behalf of the ticket's customer. */
    async forTool(input: { ticketId: string; scope: string }): Promise<IssuedToken> {
      const send = options.portalFetch ?? fetch;
      const path = `/internal/tickets/${encodeURIComponent(input.ticketId)}/assertion`;
      const response = await send(
        new Request(new URL(path, options.portalUrl), {
          method: "POST",
          headers: {
            authorization: `Bearer ${await workerToken()}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ scope: input.scope }),
        }),
      );
      const body = (await response.json().catch(() => ({}))) as {
        assertion?: string;
        error?: { code?: string; message?: string };
      };
      if (!response.ok || !body.assertion) {
        throw new TokenError(
          response.status,
          body.error?.code ?? "grant_refused",
          body.error?.message ?? "The portal did not issue an assertion",
        );
      }
      return options.worker.fromAssertion(body.assertion, input.scope);
    },
  };
}

/** An OAuth error response from the token endpoint. */
export class TokenError extends Error {
  override readonly name = "TokenError";
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, description: string) {
    super(`${code}: ${description}`);
    this.status = status;
    this.code = code;
  }
}

export type IssuedToken = { accessToken: string; expiresAt: number };

export type TokenClient = ReturnType<typeof createTokenClient>;

/** One confidential client's view of the realm's token endpoint. */
export function createTokenClient(options: {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Where this client reaches the realm, when that differs from its public name. */
  backchannel?: string | undefined;
}) {
  const endpoint = `${options.backchannel ?? options.issuer}/protocol/openid-connect/token`;

  async function request(parameters: Record<string, string>): Promise<IssuedToken> {
    const response = await fetch(endpoint, {
      method: "POST",
      body: new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        ...parameters,
      }),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || typeof body.access_token !== "string") {
      throw new TokenError(
        response.status,
        typeof body.error === "string" ? body.error : "invalid_response",
        typeof body.error_description === "string" ? body.error_description : "No token issued",
      );
    }
    const lifetime = typeof body.expires_in === "number" ? body.expires_in : 0;
    return { accessToken: body.access_token, expiresAt: Date.now() + lifetime * 1000 };
  }

  return {
    clientId: options.clientId,

    /** A token for the client itself, with no user behind it. */
    clientCredentials(scope: string) {
      return request({ grant_type: "client_credentials", scope });
    },

    /** Trades a signed ticket-grant assertion for a token that acts for its customer. */
    fromAssertion(assertion: string, scope: string) {
      return request({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
        scope,
      });
    },

    /**
     * Trades a token this client received for one addressed to a downstream
     * service. The received token is never forwarded as it is.
     */
    exchange(subjectToken: string, audience: string, scope: string) {
      return request({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: subjectToken,
        subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        audience,
        scope,
      });
    },
  };
}

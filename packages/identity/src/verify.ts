import type { Principal } from "@proofdesk/service";
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";

export type VerifiedToken = {
  token: string;
  claims: JWTPayload;
  /** The Keycloak user the token is about. */
  subject: string;
  /** The client the token was issued to. */
  client: string;
  scopes: string[];
  tenantId?: string;
  customerId?: string;
};

export type TokenVerifier = (token: string) => Promise<VerifiedToken | null>;

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

/**
 * Verifies access tokens for one audience. A token is accepted only if this
 * realm signed it, it has not expired, it is an access token, and it names
 * this audience. A token minted for another service is rejected, which is what
 * stops one service from replaying a caller's token against another.
 */
export function createTokenVerifier(options: { issuer: string; audience: string }): TokenVerifier {
  const jwks = createRemoteJWKSet(new URL(`${options.issuer}/protocol/openid-connect/certs`));

  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "sub", "azp"],
      });
      if (payload.typ !== "Bearer") return null;

      const verified: VerifiedToken = {
        token,
        claims: payload,
        subject: String(payload.sub),
        client: String(payload.azp),
        scopes: text(payload.scope)?.split(" ") ?? [],
      };
      const tenantId = text(payload.tenant_id);
      const customerId = text(payload.customer_id);
      if (tenantId) verified.tenantId = tenantId;
      if (customerId) verified.customerId = customerId;
      return verified;
    } catch {
      return null;
    }
  };
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header ? /^Bearer +(\S+)$/i.exec(header) : null;
  return match?.[1] ?? null;
}

/**
 * Turns a verified token into a principal. A token without a tenant is not a
 * principal: every record in this system belongs to one.
 */
export function principalFrom(token: VerifiedToken, actor: Principal["actor"]): Principal | null {
  if (!token.tenantId) return null;
  return {
    tenantId: token.tenantId,
    actor,
    subject: `${token.client}:${token.subject}`,
    scopes: token.scopes,
    ...(token.customerId ? { customerId: token.customerId } : {}),
  };
}

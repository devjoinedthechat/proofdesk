import { HttpError, type Principal } from "@proofdesk/service";
import { createRemoteJWKSet, errors, type JWTPayload, jwtVerify } from "jose";

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
  /** Set for members of staff, such as `approver`. */
  staffRole?: string;
};

export type TokenVerifier = (token: string) => Promise<VerifiedToken | null>;

/**
 * True when a token could not be judged at all, because the realm's signing
 * keys could not be fetched. Every other failure is a verdict on the token.
 */
function keysUnavailable(error: unknown): boolean {
  if (!(error instanceof errors.JOSEError)) return true;
  // The library reports a key endpoint that did not answer properly with its
  // plain base error. Everything it says about a token has a code of its own.
  return error instanceof errors.JWKSTimeout || error.code === "ERR_JOSE_GENERIC";
}

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

/**
 * Verifies access tokens for one audience. A token is accepted only if this
 * realm signed it, it has not expired, it is an access token, and it names
 * this audience. A token minted for another service is rejected, which is what
 * stops one service from replaying a caller's token against another.
 *
 * A rejected token yields null. If the signing keys cannot be fetched, the
 * verifier throws a 503 instead: the caller's token may be perfectly good,
 * and "sign in again" would be the wrong thing to tell them.
 */
export function createTokenVerifier(options: {
  /** The realm's public name, exactly as it appears in a token's `iss` claim. */
  issuer: string;
  audience: string;
  /**
   * Where this service reaches the realm, when that differs from its public
   * name: inside a private network, say. Only the signing keys are fetched
   * from here. The issuer a token must name does not change.
   */
  backchannel?: string | undefined;
}): TokenVerifier {
  const jwks = createRemoteJWKSet(
    new URL(`${options.backchannel ?? options.issuer}/protocol/openid-connect/certs`),
  );

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
      const staffRole = text(payload.staff_role);
      if (staffRole) verified.staffRole = staffRole;
      return verified;
    } catch (error) {
      if (keysUnavailable(error)) {
        console.error("The identity provider's signing keys could not be fetched", error);
        throw new HttpError(503, "identity_unavailable", "Sign-in cannot be checked right now");
      }
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

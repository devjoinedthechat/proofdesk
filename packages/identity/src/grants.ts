import { randomUUID } from "node:crypto";
import { exportJWK, exportSPKI, generateKeyPair, importJWK, type JWK, SignJWT } from "jose";

export type GrantKey = {
  kid: string;
  privateJwk: JWK;
  publicJwk: JWK;
  /** The public key as base64 SPKI, the form Keycloak's identity provider setting takes. */
  publicKeySpki: string;
};

export async function generateGrantKey(kid: string = `grants-${randomUUID()}`): Promise<GrantKey> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const pem = await exportSPKI(publicKey);
  return {
    kid,
    privateJwk: await exportJWK(privateKey),
    publicJwk: { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" },
    publicKeySpki: pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""),
  };
}

export type GrantSigner = Awaited<ReturnType<typeof createGrantSigner>>;

/**
 * Signs ticket-grant assertions. An assertion says: this customer authorised
 * the agent to act for them, within these scopes. Keycloak trusts the signer's
 * key and turns one assertion into one short-lived access token.
 *
 * The signer is the only component that can name a customer. The agent's
 * worker cannot, so a compromised worker gets tokens only for tickets that
 * hold a live grant, and only within each grant's scopes.
 */
export async function createGrantSigner(options: {
  /** This signer's name, as registered with Keycloak. */
  issuer: string;
  /** The realm issuer URL. Assertions are valid only there. */
  audience: string;
  key: GrantKey;
  lifetimeSeconds?: number;
  clock?: () => Date;
}) {
  const privateKey = await importJWK(options.key.privateJwk, "ES256");
  const lifetime = options.lifetimeSeconds ?? 60;
  const clock = options.clock ?? (() => new Date());

  return {
    issuer: options.issuer,
    jwks: () => ({ keys: [options.key.publicJwk] }),

    /** Signs a single-use assertion for one customer and one set of scopes. */
    async sign(input: { customerId: string; scopes: string[] }) {
      const jti = randomUUID();
      const issuedAt = Math.floor(clock().getTime() / 1000);
      const assertion = await new SignJWT({ scope: input.scopes.join(" ") })
        .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: options.key.kid })
        .setIssuer(options.issuer)
        .setSubject(input.customerId)
        .setAudience(options.audience)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + lifetime)
        .setJti(jti)
        .sign(privateKey);
      return { assertion, jti };
    },
  };
}

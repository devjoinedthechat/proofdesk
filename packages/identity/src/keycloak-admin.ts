import { CLIENTS, GRANT_IDP, REALM, SCOPES } from "./names.ts";

export type KeycloakAdmin = Awaited<ReturnType<typeof connectKeycloakAdmin>>;

/** A minimal client for Keycloak's admin REST API. */
export async function connectKeycloakAdmin(options: {
  url: string;
  username: string;
  password: string;
}) {
  const base = options.url.replace(/\/$/, "");
  async function signIn(): Promise<string> {
    const login = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
      method: "POST",
      body: new URLSearchParams({
        client_id: "admin-cli",
        grant_type: "password",
        username: options.username,
        password: options.password,
      }),
    });
    const { access_token: accessToken } = (await login.json()) as { access_token?: string };
    if (!accessToken) throw new Error(`Keycloak admin sign-in failed with status ${login.status}`);
    return accessToken;
  }
  let token = await signIn();

  async function call(method: string, path: string, body?: unknown) {
    const send = () =>
      fetch(`${base}/admin${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    let response = await send();
    // An administrator's token lives about a minute. Sign in again once.
    if (response.status === 401) {
      token = await signIn();
      response = await send();
    }
    const text = await response.text();
    if (!response.ok && !(method === "DELETE" && response.status === 404)) {
      throw new Error(`Keycloak ${method} ${path} failed: ${response.status} ${text}`);
    }
    return {
      status: response.status,
      location: response.headers.get("location"),
      json: <T>() => JSON.parse(text) as T,
    };
  }

  return { url: base, call };
}

export type RealmOptions = {
  realm?: string;
  /** The name the grant signer puts in the `iss` claim of its assertions. */
  grantIssuer: string;
  /** The signer's public key, base64 SPKI. */
  grantPublicKey: string;
  grantKeyId: string;
  secrets: { worker: string; billingMcp: string; entitlementsMcp: string };
  /** Adds a password sign-in client. For local development and tests only. */
  devLogin?: boolean;
  /** Allows plain HTTP from any address. For local development and tests only. */
  insecureHttp?: boolean;
};

/**
 * On every client: Keycloak's built-in `basic` scope, which is what puts the
 * `sub` claim in a token, and our scope that adds the tenant and customer.
 */
const IDENTITY_SCOPES = ["basic", "proofdesk-identity"];
const BILLING_API_AUDIENCE = "billing-api-audience";
const ENTITLEMENTS_API_AUDIENCE = "entitlements-api-audience";

const audienceMapper = (audience: string) => ({
  name: `audience-${audience}`,
  protocol: "openid-connect",
  protocolMapper: "oidc-audience-mapper",
  config: {
    "included.custom.audience": audience,
    "access.token.claim": "true",
    "id.token.claim": "false",
  },
});

const attributeMapper = (attribute: string) => ({
  name: attribute,
  protocol: "openid-connect",
  protocolMapper: "oidc-usermodel-attribute-mapper",
  config: {
    "user.attribute": attribute,
    "claim.name": attribute,
    "jsonType.label": "String",
    "access.token.claim": "true",
    "id.token.claim": "false",
    "userinfo.token.claim": "false",
  },
});

/**
 * Creates the realm: who can sign in, which client may ask for which scope,
 * and which audience each scope's token is addressed to. This function is the
 * written form of the system's trust relationships.
 */
export async function provisionRealm(admin: KeycloakAdmin, options: RealmOptions): Promise<void> {
  const realm = options.realm ?? REALM;
  const path = `/realms/${realm}`;

  await admin.call("POST", "/realms", {
    realm,
    enabled: true,
    accessTokenLifespan: 300,
    // Sign-in is by email, and nobody registers themselves: customers are
    // created from the company's own records.
    sslRequired: options.insecureHttp ? "none" : "external",
    registrationAllowed: false,
    loginWithEmailAllowed: true,
  });

  // tenant_id and customer_id decide what a token can reach, so only an
  // administrator may set them.
  const profile = (await admin.call("GET", `${path}/users/profile`)).json<
    Record<string, unknown>
  >();
  await admin.call("PUT", `${path}/users/profile`, {
    ...profile,
    unmanagedAttributePolicy: "ADMIN_EDIT",
  });

  const scope = (name: string, inToken: boolean, mappers: unknown[]) =>
    admin.call("POST", `${path}/client-scopes`, {
      name,
      protocol: "openid-connect",
      attributes: { "include.in.token.scope": String(inToken) },
      protocolMappers: mappers,
    });
  // Every token carries the user's tenant and customer. Each functional scope
  // addresses the token to exactly one service.
  await scope("proofdesk-identity", false, [
    attributeMapper("tenant_id"),
    attributeMapper("customer_id"),
    attributeMapper("staff_role"),
  ]);
  // Only the MCP server gets this one. It is what lets an exchanged token be
  // addressed to the billing service.
  await scope(BILLING_API_AUDIENCE, false, [audienceMapper(CLIENTS.billingApi)]);
  await scope(SCOPES.tickets, true, [audienceMapper(CLIENTS.portal)]);
  await scope(SCOPES.grantsIssue, true, [audienceMapper(CLIENTS.portal)]);
  await scope(SCOPES.approvals, true, [audienceMapper(CLIENTS.portal)]);
  await scope(SCOPES.billingRead, true, [audienceMapper(CLIENTS.billingMcp)]);
  await scope(SCOPES.billingRefund, true, [audienceMapper(CLIENTS.billingMcp)]);
  await scope(SCOPES.billingPlan, true, [audienceMapper(CLIENTS.billingMcp)]);
  await scope(SCOPES.billingErase, true, [audienceMapper(CLIENTS.billingMcp)]);
  await scope(SCOPES.entitlementsErase, true, [audienceMapper(CLIENTS.entitlementsMcp)]);
  await scope(SCOPES.entitlementsRead, true, [audienceMapper(CLIENTS.entitlementsMcp)]);
  await scope(SCOPES.entitlementsWrite, true, [audienceMapper(CLIENTS.entitlementsMcp)]);
  await scope(ENTITLEMENTS_API_AUDIENCE, false, [audienceMapper(CLIENTS.entitlementsApi)]);
  await scope(SCOPES.documentsRead, true, [audienceMapper(CLIENTS.documentsMcp)]);

  await admin.call("POST", `${path}/identity-provider/instances`, {
    alias: GRANT_IDP,
    providerId: "jwt-authorization-grant",
    enabled: true,
    hideOnLogin: true,
    config: {
      issuer: options.grantIssuer,
      useJwksUrl: "false",
      publicKeySignatureVerifier: options.grantPublicKey,
      publicKeySignatureVerifierKeyId: options.grantKeyId,
      jwtAuthorizationGrantEnabled: "true",
      jwtAuthorizationGrantAssertionSignatureAlg: "ES256",
      // An assertion is usable for two minutes from its issue time, once.
      jwtAuthorizationGrantMaxAllowedAssertionExpiration: "120",
      jwtAuthorizationGrantAssertionReuseAllowed: "false",
    },
  });

  const client = (representation: Record<string, unknown>) =>
    admin.call("POST", `${path}/clients`, {
      publicClient: false,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: false,
      // Without this, a client's tokens would carry every role and audience
      // the user has, not only what the requested scopes grant.
      fullScopeAllowed: false,
      defaultClientScopes: IDENTITY_SCOPES,
      optionalClientScopes: [],
      ...representation,
    });

  // Resource servers. They only receive tokens and can never obtain one.
  await client({ clientId: CLIENTS.portal, bearerOnly: true, defaultClientScopes: [] });
  await client({ clientId: CLIENTS.billingApi, bearerOnly: true, defaultClientScopes: [] });

  await client({
    clientId: CLIENTS.portalWeb,
    publicClient: true,
    standardFlowEnabled: true,
    redirectUris: ["http://localhost:3000/*"],
    webOrigins: ["+"],
    attributes: {
      "pkce.code.challenge.method": "S256",
      "post.logout.redirect.uris": "http://localhost:3000/*",
    },
    defaultClientScopes: [...IDENTITY_SCOPES, SCOPES.tickets, SCOPES.approvals],
  });

  await client({
    clientId: CLIENTS.worker,
    secret: options.secrets.worker,
    serviceAccountsEnabled: true,
    optionalClientScopes: [
      SCOPES.grantsIssue,
      SCOPES.billingRead,
      SCOPES.billingRefund,
      SCOPES.billingPlan,
      SCOPES.entitlementsRead,
      SCOPES.entitlementsWrite,
      SCOPES.documentsRead,
      SCOPES.billingErase,
      SCOPES.entitlementsErase,
    ],
    attributes: {
      "oauth2.jwt.authorization.grant.enabled": "true",
      "oauth2.jwt.authorization.grant.idp": GRANT_IDP,
      "access.token.lifespan": "60",
    },
  });

  await client({
    clientId: CLIENTS.billingMcp,
    secret: options.secrets.billingMcp,
    optionalClientScopes: [
      SCOPES.billingRead,
      SCOPES.billingRefund,
      SCOPES.billingPlan,
      SCOPES.billingErase,
    ],
    defaultClientScopes: [...IDENTITY_SCOPES, BILLING_API_AUDIENCE],
    attributes: { "standard.token.exchange.enabled": "true", "access.token.lifespan": "60" },
  });

  await client({ clientId: CLIENTS.entitlementsApi, bearerOnly: true, defaultClientScopes: [] });
  await client({
    clientId: CLIENTS.entitlementsMcp,
    secret: options.secrets.entitlementsMcp,
    optionalClientScopes: [
      SCOPES.entitlementsRead,
      SCOPES.entitlementsWrite,
      SCOPES.entitlementsErase,
    ],
    defaultClientScopes: [...IDENTITY_SCOPES, ENTITLEMENTS_API_AUDIENCE],
    attributes: { "standard.token.exchange.enabled": "true", "access.token.lifespan": "60" },
  });

  if (options.devLogin) {
    await client({
      clientId: CLIENTS.devLogin,
      publicClient: true,
      directAccessGrantsEnabled: true,
      defaultClientScopes: [...IDENTITY_SCOPES, SCOPES.tickets, SCOPES.approvals],
    });
  }

  // A token obtained from an assertion or an exchange may never carry a scope
  // that the assertion or the original token did not.
  await admin.call("PUT", `${path}/client-policies/profiles`, {
    profiles: [
      {
        name: "downscope-only",
        executors: [{ executor: "downscope-assertion-grant-enforcer", configuration: {} }],
      },
    ],
  });
  await admin.call("PUT", `${path}/client-policies/policies`, {
    policies: [
      {
        name: "downscope-only",
        enabled: true,
        conditions: [{ condition: "any-client", configuration: {} }],
        profiles: ["downscope-only"],
      },
    ],
  });
}

/**
 * Creates the sign-in account for one customer and links it to the grant
 * signer, which is what lets a ticket grant name this customer.
 */
export async function provisionCustomer(
  admin: KeycloakAdmin,
  customer: { id: string; tenantId: string; email: string; name: string; password?: string },
  realm: string = REALM,
): Promise<string> {
  const [firstName, ...rest] = customer.name.split(" ");
  const created = await admin.call("POST", `/realms/${realm}/users`, {
    username: customer.email,
    email: customer.email,
    emailVerified: true,
    enabled: true,
    firstName,
    lastName: rest.join(" ") || firstName,
    attributes: { tenant_id: [customer.tenantId], customer_id: [customer.id] },
    ...(customer.password
      ? { credentials: [{ type: "password", value: customer.password, temporary: false }] }
      : {}),
  });
  const userId = created.location?.split("/").pop();
  if (!userId) throw new Error(`Keycloak did not return an id for ${customer.email}`);

  await admin.call("POST", `/realms/${realm}/users/${userId}/federated-identity/${GRANT_IDP}`, {
    identityProvider: GRANT_IDP,
    userId: customer.id,
    userName: customer.email,
  });
  return userId;
}

/**
 * Deletes a customer's sign-in account, found by the customer id it carries.
 * Returns how many accounts were removed, so a repeat reports zero.
 */
export async function deleteCustomerAccount(
  admin: KeycloakAdmin,
  customerId: string,
  realm: string = REALM,
): Promise<number> {
  const query = encodeURIComponent(`customer_id:${customerId}`);
  const users = (await admin.call("GET", `/realms/${realm}/users?q=${query}&exact=true`)).json<
    { id: string; attributes?: { customer_id?: string[] } }[]
  >();
  // The search is by attribute; the match is checked again before deleting.
  const matches = users.filter((user) => user.attributes?.customer_id?.includes(customerId));
  for (const user of matches) await admin.call("DELETE", `/realms/${realm}/users/${user.id}`);
  return matches.length;
}

export async function deleteRealm(admin: KeycloakAdmin, realm: string): Promise<void> {
  await admin.call("DELETE", `/realms/${realm}`);
}

/** Creates the sign-in account for a member of staff of one tenant. */
export async function provisionStaff(
  admin: KeycloakAdmin,
  staff: { tenantId: string; email: string; name: string; role: string; password?: string },
  realm: string = REALM,
): Promise<string> {
  const [firstName, ...rest] = staff.name.split(" ");
  const created = await admin.call("POST", `/realms/${realm}/users`, {
    username: staff.email,
    email: staff.email,
    emailVerified: true,
    enabled: true,
    firstName,
    lastName: rest.join(" ") || firstName,
    attributes: { tenant_id: [staff.tenantId], staff_role: [staff.role] },
    ...(staff.password
      ? { credentials: [{ type: "password", value: staff.password, temporary: false }] }
      : {}),
  });
  const userId = created.location?.split("/").pop();
  if (!userId) throw new Error(`Keycloak did not return an id for ${staff.email}`);
  return userId;
}

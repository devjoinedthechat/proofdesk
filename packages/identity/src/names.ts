/** Names shared by the realm, the services and the agent. */

export const REALM = "proofdesk";

export const CLIENTS = {
  /** The portal API, as a token audience. */
  portal: "portal",
  /** The browser sign-in client for customers and staff. */
  portalWeb: "portal-web",
  /** Password sign-in for local development and tests only. */
  devLogin: "dev-login",
  /** The agent's worker. It can act for a customer only with a signed ticket grant. */
  worker: "agent-worker",
  /** The billing MCP server, which receives the agent's tool calls. */
  billingMcp: "billing-mcp",
  /** The billing service, as a token audience. Only the MCP server can obtain it. */
  billingApi: "billing-api",
  /** The entitlements MCP server. */
  entitlementsMcp: "entitlements-mcp",
  /** The entitlements service, as a token audience. Only its MCP server can obtain it. */
  entitlementsApi: "entitlements-api",
  /** The help-centre search MCP server, as a token audience. */
  documentsMcp: "documents-mcp",
} as const;

/** The identity provider through which Keycloak trusts signed ticket grants. */
export const GRANT_IDP = "ticket-grants";

export const SCOPES = {
  tickets: "tickets",
  grantsIssue: "grants:issue",
  approvals: "approvals",
  billingRead: "billing:read",
  billingRefund: "billing:refund",
  billingPlan: "billing:plan",
  entitlementsRead: "entitlements:read",
  entitlementsWrite: "entitlements:write",
  documentsRead: "documents:read",
} as const;

export function realmIssuer(keycloakUrl: string, realm: string = REALM): string {
  return `${keycloakUrl.replace(/\/$/, "")}/realms/${realm}`;
}

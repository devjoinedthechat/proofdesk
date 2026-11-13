# 5. Ticket grants for agent authority

Status: accepted, 2026-11-13

## Context

The agent acts for a customer against systems of record. Two facts make the usual answer, "forward the user's token", wrong here.

- **Tickets outlive sessions.** A refund can wait days for staff approval. By then the customer's sign-in token has expired.
- **The agent reads untrusted text.** A manipulated model must not be able to widen its own authority, name a different customer, or reuse a credential elsewhere.

## Decision

Submitting a ticket creates a **ticket grant**: this customer, these scopes, until expiry, revocation or the ticket closing. Nothing from the sign-in is stored.

For every tool call, the worker obtains fresh authority in two steps.

1. The worker asks the portal for an assertion for ticket T and one scope. The portal checks the grant and signs a single-use assertion naming the customer.
2. The worker presents the assertion to Keycloak with its own client secret (RFC 7523 JWT authorization grant). Keycloak returns an access token for that customer.

The MCP server then exchanges that token for one addressed to the billing service (RFC 8693). It never forwards the token it received.

## What each party can and cannot do

| Party           | Holds                                | Cannot                                                          |
| --------------- | ------------------------------------ | --------------------------------------------------------------- |
| Portal          | The grant signing key                | Obtain a token: it has no client that Keycloak issues tokens to |
| Worker          | A client secret                      | Name a customer: only a signed assertion can                    |
| MCP server      | A client secret, exchange permission | Reach billing without a caller's token addressed to it          |
| Billing service | Nothing                              | Accept a token addressed to anyone else                         |

Compromising the worker alone yields tokens only for tickets with a live grant, within each grant's scopes.

## The resulting token

| Property | Value                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------- |
| Lifetime | 60 seconds, no refresh token                                                                   |
| Audience | One service                                                                                    |
| Scope    | One scope, never more than the assertion carried                                               |
| Subject  | The customer; `tenant_id` and `customer_id` come from attributes only an administrator can set |
| Actor    | The requesting client, in `azp`                                                                |

## Why not the alternatives

A spike against Keycloak 26.8 tested each.

- **Standard token exchange alone** needs a live user token, which does not exist days later.
- **Offline tokens** work, but mean storing a long-lived credential per ticket. A leak of that store is a leak of every customer's authority.
- **Legacy impersonation** lets one client act as any user in the realm, and is deprecated.
- **A separate token service** would work, but adds a second issuer for every service to trust.

## Costs and limits

- **Three network calls per tool call** before the tool runs: portal, Keycloak, and the exchange. Acceptable next to a model call.
- **No `act` claim.** Keycloak does not emit one for this grant, so the acting client is read from `azp`.
- **The token does not name the ticket.** The link from token to ticket is the portal's assertion log, one row per assertion.
- **Scope narrowing is a policy, not a default.** Without Keycloak's downscope client policy, a client may request any scope assigned to it. A test turns the policy off and watches two checks fail.
- **Key rotation** currently means updating the key registered in Keycloak. A JWKS URL would remove that step.

## When this breaks

If tools need a token for an external party's API, that party will not trust this realm, and a different delegation is needed for that hop.

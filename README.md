# Proofdesk

A back-office support agent for a simulated subscription company, built as a reference for production-grade AI agents.

The agent resolves refund, plan-change and data-deletion tickets by reading the company's records and making the changes itself. Each production property the repo claims is backed by a test that tries to break it.

## Quick start

Requires Node 22.18 or later, pnpm and Docker.

```sh
pnpm install
pnpm check      # lint, type checks, all tests
pnpm stack:up   # Postgres with pgvector, Keycloak, Temporal
```

`pnpm test` starts its own Postgres and Keycloak containers, so it does not need the stack. `pnpm test:unit` runs the tests that need no Docker.

| Service     | Address               | Local login               |
| ----------- | --------------------- | ------------------------- |
| Postgres    | `localhost:5432`      | `proofdesk` / `proofdesk` |
| Keycloak    | http://localhost:8080 | `admin` / `admin`         |
| Temporal UI | http://localhost:8233 | none                      |

`pnpm stack:down` stops the stack. `pnpm stack:reset` also deletes its data.

## The simulated company

The agent works for two fictional companies with different refund rules, so the same ticket can have two correct answers.

| Tenant       | Refund window | Approval needed above |
| ------------ | ------------- | --------------------- |
| Harbor Notes | 14 days       | $200                  |
| Tallyfield   | 30 days       | $500                  |

- **Seeded.** One seed always produces the same customers, subscriptions, invoices and payments.
- **Scenarios.** 32 refund tickets, each with a hand-written expected result: the refunds that must exist afterwards, whether approval is requested, and what the reply must say. Fifteen of them must end without a refund.
- **Judged on final state.** A run passes only if the expected refunds exist and nothing else in the company changed.
- **Validated without a model.** A scripted oracle reaches the expected result on every scenario, and a solver that always refunds or always refuses fails every one.

Billing enforces what must always hold: a refund never exceeds what was paid, and a retried request with the same idempotency key pays once. Company policy, such as the refund window, is deliberately not billing's job.

## Identity and authority

The agent never holds a customer's credential. Submitting a ticket creates a grant, and each tool call gets its own 60-second, single-scope token derived from it. A ticket can wait days for approval with no credential waiting alongside it.

```
customer signs in → submits a ticket          the grant: this customer, these scopes
worker → portal:   "ticket T, scope S"        → signed, single-use assertion
worker → Keycloak: assertion + own secret     → token for the MCP server
worker → MCP server: tool call
MCP server → Keycloak: token exchange         → token for the billing service
MCP server → billing service → Postgres under row-level security
```

| Claim                                          | Test that tries to break it                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A token without the refund scope cannot refund | It is not shown the tool, the tool call fails, Keycloak refuses to widen it, and billing refuses it directly |
| One tenant cannot reach another's data         | Unfiltered queries as the service's database role return only the scoped tenant's rows                       |
| One customer cannot reach another's payment    | A refund against it fails as not found; the database rejects the row                                         |
| A token works only where it was addressed      | The MCP token is rejected by billing; a sign-in token is rejected by the MCP server                          |
| The worker cannot name a customer              | A self-signed assertion, a replayed assertion and a bare service token are all refused                       |
| The grant is checked on every call             | Revoked, expired, closed and out-of-category requests are refused                                            |
| The service role cannot rewrite history        | Updates and deletes on billing tables fail with permission denied                                            |

Each row was also checked from the other side: with the control removed, the test fails.

## Layout

| Path                     | Contents                                                                       |
| ------------------------ | ------------------------------------------------------------------------------ |
| `packages/gateway`       | Provider-neutral model interface and a scripted mock provider                  |
| `packages/simulator`     | Seeded company, refund scenarios, reference policy, oracle and scenario runner |
| `packages/db`            | Application database schema, migration and test-database helpers               |
| `packages/service`       | Shared HTTP conventions: principals, errors, typed clients                     |
| `services/billing`       | Billing system of record: subscriptions, invoices, payments, refunds           |
| `services/entitlements`  | Entitlements system of record, with versioned writes                           |
| `infra/compose`          | Local development stack                                                        |
| `docs/adr`               | Decision records                                                               |
| `docs/architecture.html` | Architecture diagram                                                           |

## Decisions

- [Own agent loop instead of a framework](docs/adr/0001-own-agent-loop.md)
- [Temporal for durable execution](docs/adr/0002-temporal-for-durable-execution.md)
- [Postgres for vectors](docs/adr/0003-postgres-for-vectors.md)
- [Ground truth before the agent](docs/adr/0004-ground-truth-before-the-agent.md)
- [Ticket grants for agent authority](docs/adr/0005-ticket-grants-for-agent-authority.md)

## Licence

[MIT](LICENSE)

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

`pnpm test` starts its own Postgres container, so it does not need the stack. `pnpm test:unit` runs the tests that need no Docker.

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

## Licence

[MIT](LICENSE)

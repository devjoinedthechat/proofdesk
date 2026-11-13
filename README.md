# Proofdesk

A back-office support agent for a simulated subscription company, built as a reference for production-grade AI agents.

The agent resolves refund, plan-change and data-deletion tickets by reading the company's records and making the changes itself. Each production property the repo claims is backed by a test that tries to break it.

## Quick start

Requires Node 22.18 or later, pnpm and Docker.

```sh
pnpm install
pnpm stack:up   # Postgres with pgvector, Keycloak, Temporal
pnpm check      # lint, type checks, tests
```

| Service     | Address               | Local login               |
| ----------- | --------------------- | ------------------------- |
| Postgres    | `localhost:5432`      | `proofdesk` / `proofdesk` |
| Keycloak    | http://localhost:8080 | `admin` / `admin`         |
| Temporal UI | http://localhost:8233 | none                      |

`pnpm stack:down` stops the stack. `pnpm stack:reset` also deletes its data.

## Layout

| Path                     | Contents                                                      |
| ------------------------ | ------------------------------------------------------------- |
| `packages/gateway`       | Provider-neutral model interface and a scripted mock provider |
| `infra/compose`          | Local development stack                                       |
| `docs/adr`               | Decision records                                              |
| `docs/architecture.html` | Architecture diagram                                          |

## Decisions

- [Own agent loop instead of a framework](docs/adr/0001-own-agent-loop.md)
- [Temporal for durable execution](docs/adr/0002-temporal-for-durable-execution.md)
- [Postgres for vectors](docs/adr/0003-postgres-for-vectors.md)

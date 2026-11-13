# Proofdesk

A back-office support agent for a simulated subscription company, built as a reference for production-grade AI agents.

The agent resolves refund, plan-change and data-deletion tickets by reading the company's records and making the changes itself. Each production property the repo claims is backed by a test that tries to break it.

## Results on real models

Three repeats of every scenario on each model, judged on the final state of the simulated company.

| Suite                                     | `claude-sonnet-5-5` | `claude-haiku-5-5` |
| ----------------------------------------- | ------------------- | ------------------ |
| 32 honest refund tickets                  | 96 of 96 passed     | 95 of 96 passed    |
| 7 tickets that need the help centre       | 21 of 21 passed     | 21 of 21 passed    |
| 24 attack tickets: attacks that succeeded | 0 of 72             | 0 of 72            |
| Cost per ticket                           | $0.0088             | $0.0006            |

Read these with their limits. Both suites are saturated, and no attack was strong enough to fool the model, so those runs never reached the controls behind it. What a fooled model can and cannot do is tested separately, with a scripted model that is fully under an attacker's control:

| A compromised model tries to                                | Result                                          |
| ----------------------------------------------------------- | ----------------------------------------------- |
| Refund a charge outside the window, under any label         | Denied by policy, on billing records            |
| Refund another customer's payment                           | Denied by policy; refused by billing without it |
| Split a large refund to avoid approval                      | Both parts wait for staff                       |
| Refund more than was paid, with staff fooled into approving | Refused by the billing service                  |
| Tell the customer a refund was made when none was           | Reply stopped by the guard                      |

The [eval report](docs/eval-report/README.md) has the method and the limits, and the [threat model](docs/threat-model.md) lists what a compromised model can still do.

## Quick start

Requires Node 22.18 or later, pnpm and Docker.

```sh
pnpm install
pnpm check      # lint, type checks, all tests
pnpm stack:up   # Postgres with pgvector, Keycloak, Temporal
```

`pnpm test` starts its own Postgres, Keycloak and Temporal containers, so it does not need the stack. `pnpm test:unit` runs the tests that need no Docker.

| Service     | Address               | Local login               |
| ----------- | --------------------- | ------------------------- |
| Postgres    | `localhost:5432`      | `proofdesk` / `proofdesk` |
| Keycloak    | http://localhost:8080 | `admin` / `admin`         |
| Temporal UI | http://localhost:8233 | none                      |

`pnpm evals` runs the agent on the scenarios with a real model. It needs an `ANTHROPIC_API_KEY` in `.env`, requires a `--max-spend` cap in dollars, and spends real money.

`pnpm stack:down` stops the stack. `pnpm stack:reset` also deletes its data.

## The simulated company

The agent works for two fictional companies with different refund rules, so the same ticket can have two correct answers.

| Tenant       | Refund window | Approval needed above |
| ------------ | ------------- | --------------------- |
| Harbor Notes | 14 days       | $200                  |
| Tallyfield   | 30 days       | $500                  |

- **Seeded.** One seed always produces the same customers, subscriptions, invoices and payments.
- **Scenarios.** 32 honest refund tickets and 24 attack tickets, each with a hand-written expected result: the refunds that must exist afterwards, whether approval is requested, and what the reply must say. Fifteen of them must end without a refund.
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

## Retrieval and memory

The agent can search each company's help centre. Access is part of the search, not a filter around it.

| Claim                                                            | Test that tries to break it                                                                          |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| The same question gets different sources for different audiences | A staff-only page is the top result for staff and absent for an agent acting for a customer          |
| One tenant never sees another's documents                        | Searches as each tenant; an unscoped query as the search role returns nothing                        |
| A poisoned page is held back at ingestion                        | The scan quarantines it with its findings; it has no chunks to retrieve                              |
| A poisoned page that gets through changes no outcome             | With the scan bypassed, both models still refuse the out-of-window refund                            |
| Re-indexing is atomic and idempotent                             | Unchanged content is skipped; changed content replaces its chunks in one transaction                 |
| Deletion removes the embeddings too                              | After a delete, no chunk of the document is left                                                     |
| A small tenant still gets results from a large index             | With the vector index forced, recall falls to 3.5% without iterative scan and returns to 98% with it |
| Memory cannot be poisoned by a ticket                            | A memory is a set of facts the system computed from what happened; no ticket text is stored          |
| Memories have an owner, a source and an expiry                   | Expired entries and other customers' entries never reach the prompt                                  |

Search quality was measured with a stand-in embedder because no embedding API key was available. See the [retrieval report](docs/eval-report/retrieval.md).

## Durable execution

Each ticket is one Temporal workflow. A worker can stop at any point and another continues from the same step.

| Claim                                          | Test that tries to break it                                                                                                                                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A refund is issued exactly once                | With every service running as its own process, the worker is sent `SIGKILL` at the moment billing has paid. A second worker repeats the call; billing answers 201, then 200, and one refund exists |
| A repeated or overlapping step changes nothing | The same activity is run twice, and two attempts of one step are run at once                                                                                                                       |
| A large refund waits for a person              | The workflow pauses, the worker is shut down, the approval arrives with no worker running, a new worker finishes                                                                                   |
| Only that tenant's staff can approve           | Another company's approver gets an empty list and a 404; the customer gets a 403                                                                                                                   |
| Approval cannot override the kill switch       | The agent is paused after the request; the approved refund is still denied                                                                                                                         |
| The model's account is not trusted             | A run that claims a refund it never made is handed to staff                                                                                                                                        |
| No customer data in workflow history           | The finished history is searched for the ticket text, name, email and amount                                                                                                                       |
| The audit log is tamper-evident                | Entries are edited, re-hashed and deleted with full database access                                                                                                                                |

These run with a scripted stand-in for the model. They test the system around the model, not the model's judgment.

## Layout

| Path                     | Contents                                                                       |
| ------------------------ | ------------------------------------------------------------------------------ |
| `packages/gateway`       | Provider-neutral model interface and a scripted mock provider                  |
| `packages/simulator`     | Seeded company, refund scenarios, reference policy, oracle and scenario runner |
| `packages/db`            | Application database schema, migration and test-database helpers               |
| `packages/service`       | Shared HTTP conventions: principals, errors, typed clients                     |
| `services/documents`     | Help-centre documents: ingestion pipeline and permission-aware hybrid search   |
| `mcp/documents`          | Help-centre search MCP server                                                  |
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
- [Run state lives in the database, not in workflow history](docs/adr/0006-run-state-outside-workflow-history.md)
- [Refund rules are enforced on billing records, not only in the prompt](docs/adr/0007-enforce-refund-rules-on-records.md)
- [What is in the prompt, what is retrieved, what is remembered](docs/adr/0008-prompt-retrieval-memory.md)

## Licence

[MIT](LICENSE)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="" width="112" height="112">
  </picture>
</p>

<h1 align="center">Proofdesk</h1>

<p align="center">
  <b>An AI support agent that issues refunds and changes plans itself.</b><br>
  Every claim is backed by a test that tries to break it.
</p>

<p align="center">
  <a href="https://github.com/devjoinedthechat/proofdesk/actions/workflows/ci.yml"><img src="https://github.com/devjoinedthechat/proofdesk/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-15803d" alt="MIT licence"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022.18-15803d" alt="node >= 22.18">
  <img src="https://img.shields.io/badge/typescript-strict-15803d" alt="TypeScript strict">
</p>

<p align="center">
  <a href="#walkthrough">Walkthrough</a> ·
  <a href="#what-it-proves">What it proves</a> ·
  <a href="#results-on-real-models">Results</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/claims.md">Every claim</a> ·
  <a href="#design-decisions">Design decisions</a>
</p>

A production-grade AI support agent for subscription billing. It resolves refund and plan-change tickets by acting on the systems of record itself: it reads the customer's billing records, applies the company's policy, and issues the refund or makes the change. It also carries out data-deletion requests, with no model involved.

The repo is organised around one question: what happens when the model is wrong? Every property it claims is backed by a test that tries to break it, and a run is judged on the final state of the databases, not on what the model says it did.

```mermaid
flowchart LR
  customer([Customer]) --> portal
  staff([Staff]) --> portal
  portal[Portal<br/>interface and API] -- outbox --> ticket
  portal -- outbox --> deletion

  subgraph engine [Temporal]
    ticket[Ticket workflow]
    deletion[Deletion workflow<br/>no model]
    watchdog[Watchdog]
  end

  subgraph worker [Worker]
    loop[Agent loop] --> policy[Policy check<br/>Cedar] --> tools[Tool call]
  end

  ticket --> loop
  loop --> gateway[Model gateway<br/>budgets, failover] --> model([Claude])
  tools -- one-scope token --> mcp[MCP servers<br/>billing, entitlements, documents]
  mcp -- exchanged token --> services[Billing and entitlements]
  keycloak[Keycloak] -. issues every token .-> tools
  services --> db[(Postgres<br/>row-level security)]
  mcp --> db

  watchdog -. can only stop .-> controls[(Kill switch<br/>and rollout)]
  controls -. read before every step .-> loop
  loop --> audit[(Audit log<br/>hash-chained)]
  loop -- numbers only --> grafana[Grafana]
  loop -- conversations --> phoenix[Phoenix]
```

## Walkthrough

![A customer's request, the agent's question, the answer and the refund; a refund that waits for staff approval; the kill switch](docs/walkthrough/proofdesk-walkthrough.svg)

The system running locally with Claude as the agent: a request the agent has to ask about, a refund that waits for staff approval, and the kill switch. Every picture is the real interface and every reply is the model's. [How it was made](docs/walkthrough/README.md).

## What it proves

Each row is a property and the test that attacks it.

<!-- claims:start -->
| Property                                             | How the test tries to break it                                                                                                         | Test                                                                                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| The agent acts only with the customer's authority    | A ticket grant is withdrawn, expired, closed, or asked for a scope its category does not allow                                         | [authority.itest.ts](mcp/billing/src/authority.itest.ts)                                                                    |
| One tenant never reaches another's rows              | Unfiltered queries run as the service's own database role                                                                              | [billing.itest.ts](services/billing/src/billing.itest.ts)                                                                   |
| Refund rules hold even if the model is compromised   | A scripted, attacker-controlled model calls the refund tool directly: outside the window, relabelled, disputed, another customer's     | [compromised.itest.ts](packages/evals/src/compromised.itest.ts), [policy.test.ts](packages/policy/src/policy.test.ts)       |
| The reply cannot misstate what was done              | It claims a refund that was not made, hides one that was, and leaks its tool names                                                     | [compromised.itest.ts](packages/evals/src/compromised.itest.ts), [workflow.itest.ts](apps/worker/src/workflow.itest.ts)     |
| A refund is issued exactly once                      | All services run as separate processes; the worker is sent `SIGKILL` the moment billing has paid, and a second worker repeats the call | [processes.itest.ts](apps/worker/src/processes.itest.ts), [workflow.itest.ts](apps/worker/src/workflow.itest.ts)            |
| A large refund waits for a person                    | The worker is shut down during the wait and the approval arrives with no worker running                                                | [workflow.itest.ts](apps/worker/src/workflow.itest.ts), [processes.itest.ts](apps/worker/src/processes.itest.ts)            |
| The audit log is tamper-evident                      | Entries are edited, re-hashed and deleted with full database access                                                                    | [audit.itest.ts](packages/db/src/audit.itest.ts)                                                                            |
| Access is part of the search, not a filter around it | The same question is asked as staff and as an agent acting for a customer, and by another company                                      | [documents.itest.ts](packages/simulator/src/documents.itest.ts), [authority.itest.ts](mcp/documents/src/authority.itest.ts) |
| A bad build is rolled back without anyone acting     | A canary whose model claims refunds it never made gets half of new tickets; the watchdog must notice and send all traffic back         | [canary.itest.ts](apps/worker/src/canary.itest.ts), [watchdog.test.ts](apps/worker/src/watchdog.test.ts)                    |
| The kill switch stops work already in progress       | An operator pauses the agent after the model has read the invoices and before it refunds                                               | [controls.itest.ts](apps/worker/src/controls.itest.ts)                                                                      |
| A deleted customer leaves no trace                   | Every table, every workflow history, the inspection store and the identity provider are searched for their name, email and ticket text | [deletion.itest.ts](apps/worker/src/deletion.itest.ts)                                                                      |

These are 11 of 44. For 38 of them, `pnpm prove` takes the control out of the source and expects the tests to fail: 54 removals, run in CI on every push. [The full list](docs/claims.md) names the tests behind each claim and the edit that removes its control.
<!-- claims:end -->

- **Authority is the customer's, per call.** Submitting a ticket creates a grant, and every tool call gets its own 60-second, single-scope token derived from it. A ticket can wait days for approval with no credential waiting alongside it ([ADR 5](docs/adr/0005-ticket-grants-for-agent-authority.md)).
- **Rules are enforced on records, not on the model's word.** The policy layer reads the billing records itself, every tool is strict, and every result is checked against a schema by the code that acts on it ([ADR 7](docs/adr/0007-enforce-refund-rules-on-records.md), [ADR 11](docs/adr/0011-schemas-at-every-boundary.md)).
- **Automation may only stop things.** A watchdog can roll back a build or pause the agent; only a person can start it again ([ADR 14](docs/adr/0014-stopping-the-agent.md)).
- **No model takes part in a deletion.** What must go is fixed in code and in one database function ([ADR 13](docs/adr/0013-deletion-without-a-model.md)).

The [threat model](docs/threat-model.md) lists the controls by layer and states what a compromised model can still do.

## Results on real models

Three repeats of 76 scenarios on each model. An attempt passes only if the final state is exactly the expected one, approval was requested exactly when required, and the reply states the required facts.

| Suite                                     | `claude-sonnet-5-5` | `claude-haiku-5-5` |
| ----------------------------------------- | ------------------- | ------------------ |
| 32 honest refund tickets                  | 96 of 96            | 93 of 96           |
| 13 plan-change tickets                    | 39 of 39            | 36 of 39           |
| 7 tickets that need the help centre       | 21 of 21            | 21 of 21           |
| 24 attack tickets: attacks that succeeded | 0 of 72             | 0 of 72            |
| Cost per ticket                           | $0.0091             | $0.0006            |

- **The quality gate fails when it should.** With the refund policy removed from the prompt, the pass rate on the gate sample falls from 28 of 28 to 20 of 28 and the command exits non-zero.
- **The suites are nearly saturated.** Sonnet passed every attempt and Haiku failed 9 of 228, none of which moved money wrongly. These numbers cannot rank models.
- **No attack fooled either model,** which means those runs barely reached the controls behind the model. That is why the compromised-model tests above exist.

The [eval report](docs/eval-report/README.md) has the method, every failure and the limits.

With the model taken out, a ticket costs about 450 ms of this system's own time across seven durable steps, and one worker handles about 37 tickets a second. [What the system costs per ticket](docs/load.md) has the numbers and what they leave out.

## Quick start

Requires Node 22.18 or later, pnpm and Docker.

```sh
pnpm install
pnpm check        # secret scan, lint, type checks and every test
pnpm test:unit    # only the tests that need no Docker
pnpm prove        # take each control out in turn and expect its tests to fail
pnpm load         # time 200 tickets with the model taken out
```

`pnpm test` starts its own Postgres, Keycloak and Temporal containers and takes a few minutes. It includes the test that runs every service as a separate process and kills the worker mid-refund. The tests cover 95% of lines and 83% of branches, and CI fails under 93% and 80%.

`pnpm prove` takes about 25 minutes for every removal. `pnpm prove refund-once` runs one claim, and `pnpm prove --list` shows what would be removed.

### Run the whole system locally

```sh
pnpm local:up      # build one image, provision, start every service
pnpm local:demo    # file a duplicate-charge ticket and print the reply
pnpm local:smoke   # start from nothing and check six journeys and the interface
pnpm local:down    # stop, keeping the data (local:reset deletes it)
```

`local:up` starts Postgres, Keycloak and Temporal, then a provisioning step that creates the databases and their roles, seeds a company dated today, loads the help centre, creates the Keycloak realm and writes the signing key for ticket grants. The portal, both services, the three MCP servers and the worker start once it has finished. Running it again changes nothing.

`local:demo` takes a name. Each one uses the system as its people would, through the portal:

| Demo       | What happens                                                                         |
| ---------- | ------------------------------------------------------------------------------------ |
| `refund`   | A duplicate charge is refunded                                                       |
| `approval` | A $980 refund waits for staff, is approved, and is paid                              |
| `reply`    | The agent asks which charge; the customer answers; the refund follows                |
| `plan`     | A request for more seats changes billing and access together                         |
| `handover` | An operator pauses the agent; the ticket goes to staff; a member of staff answers it |
| `delete`   | A customer asks to be deleted, and can no longer sign in                             |

Five screens are available while the stack runs:

| Screen    | Address                             | What it shows                                                                                  |
| --------- | ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| Proofdesk | `http://localhost:3000`             | The customer page and the staff console                                                        |
| Phoenix   | `http://localhost:6006`             | Every conversation in full: what the model was sent, each tool call and its verdict, the reply |
| Grafana   | `http://localhost:3001/d/proofdesk` | What the agent did, what it cost, what stopped it, and a trace per ticket                      |
| Temporal  | `http://localhost:8233`             | Each ticket's workflow, step by step                                                           |
| Keycloak  | `http://localhost:8080`             | The realm, its clients and users                                                               |

The password for every local account is `local-demo-password`, or `DEMO_PASSWORD` if you set it. Phoenix's account is `admin@localhost`.

| Sign in to Proofdesk as                                  | To                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `maya.okafor@example.org`                                | File a request about a duplicate $87 charge and read the reply         |
| `mateus.rocha@example.org`                               | File one about a $980 duplicate, which needs approval                  |
| `approver@harbor.example`, `approver@tallyfield.example` | Approve refunds, answer tickets the agent handed over, and review them |
| `operator@harbor.example`, `operator@tallyfield.example` | Use the kill switch                                                    |

Sign-in is the authorization code flow with PKCE. The page keeps tokens in memory only, and its content security policy lets it run no script but its own.

With `ANTHROPIC_API_KEY` in the environment or in `.env`, the agent is Claude and a ticket costs about two cents. Without it, or with `SCRIPTED_MODEL=1`, a scripted stand-in handles the demo tickets and nothing is spent. `local:smoke` always uses the stand-in.

### Evals

To run the agent on the scenarios with a real model:

```sh
echo "ANTHROPIC_API_KEY=..." > .env
pnpm evals --model claude-sonnet-5-5 --effort medium --max-spend 1 --out results.json
```

`--max-spend` is required, in dollars. The command stops starting new attempts once the cap is reached.

Without an API key, `--via claude-code` reaches the model through the Claude Code command line, which signs in by itself. Set `CLAUDE_CODE_BIN` if `claude` is not on the path. It is a different route to the model, and its results should not be mixed with the API's.

## How a ticket is handled

1. **Submission.** A signed-in customer submits a ticket and picks a category. In one transaction the portal stores the ticket, creates the grant, and records that a workflow is owed.
2. **Model turn.** The worker sends the ticket, wrapped as untrusted text, with the company's policy and the tools the category allows. Every tool is strict: arguments are constrained to its schema.
3. **Policy check.** Each tool call the model asks for is decided by Cedar: allow, deny, or wait for staff.
4. **Tool call.** The worker obtains a fresh token for that one call and calls the MCP server, with an idempotency key the model never sees.
5. **Resolution.** The model ends by calling a tool with the outcome, the reason and the reply.
6. **Reply check.** The reply is compared with what the tools actually did before it is stored.
7. **Record.** The outcome, an audit entry per step, and a summary for the customer's next ticket are written.
8. **If the agent asked a question,** the customer's answer joins the same conversation and the agent takes another turn. If it handed the ticket over, a member of staff answers.

Run state is saved after every step, so a worker can stop anywhere and another continues. See [ADR 6](docs/adr/0006-run-state-outside-workflow-history.md).

## Stack

| Layer             | Choice                                               | What it does here                                             |
| ----------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| Language          | TypeScript on Node 22, pnpm workspace                | One language across services, agent, evals and tests          |
| Model             | Claude Sonnet and Haiku, Anthropic SDK               | Own agent loop with strict tool schemas; no agent framework   |
| Model gateway     | Own, thin                                            | Budgets per ticket and tenant, retries, failover, fault tests |
| Durable execution | Temporal                                             | One workflow per ticket; survives a worker dying mid-refund   |
| Tools             | Three MCP servers (billing, entitlements, documents) | Typed inputs and outputs; each call carries a scoped token    |
| Identity          | Keycloak, OAuth token exchange (RFC 8693)            | The agent acts as the customer, never as itself               |
| Policy            | Cedar                                                | Allow, deny or require approval, decided outside the model    |
| Data              | PostgreSQL, Kysely, dbmate, row-level security       | Tenant isolation enforced by the database; hash-chained audit |
| Validation        | Zod                                                  | Every boundary: tool input, tool output, model output         |
| Telemetry         | OpenTelemetry to Grafana                             | One trace per ticket; counts and costs, no customer text      |
| Inspection        | Arize Phoenix                                        | Full conversations, per tenant, deleted with the customer     |
| Evals             | Own runner on Vitest                                 | Judged on the final state of the databases                    |
| Tests             | Vitest, Testcontainers, Playwright                   | Real Postgres, Keycloak and Temporal; a real browser          |
| Local and CI      | Docker Compose, GitHub Actions                       | The whole system from nothing on every push                   |

## Test environment

The systems of record run as a seeded environment, so every ticket has a known correct outcome.

- **Two tenants with different rules.** One allows refunds for 14 days and needs approval above $200; the other 30 days and $500. The same ticket can have two correct answers.
- **Hand-written expected results.** Each scenario states the refunds or plan change that must exist afterwards, whether approval is requested, and what the reply must say.
- **Validated without a model.** A scripted oracle reaches the expected result on every scenario, and solvers that always refund or always refuse fail every one.
- **Conversations too.** 14 more scenarios take more than one round: the agent must ask, and 7 of the answers carry an attack. Guessing right without asking fails. Sonnet passed 41 of 42 attempts and Haiku 32 of 42, with no attack succeeding; those runs went through the Claude Code command line, not the API, and [stand apart](docs/eval-report/README.md#conversations) from the table above.

## Repository layout

| Path                                                              | Contents                                                                                                         |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `apps/portal`                                                     | The web interface and its API: tickets, replies, grants, approvals, review queue, kill switch, deletion requests |
| `apps/worker`                                                     | The ticket, deletion and watchdog workflows, and their activities                                                |
| `apps/stack`                                                      | Provisioning, the demo client and the browser check for the local stack                                          |
| `mcp/billing`, `mcp/entitlements`, `mcp/documents`                | MCP servers in front of each service                                                                             |
| `services/billing`, `services/entitlements`, `services/documents` | The systems of record and the help centre                                                                        |
| `packages/agent`                                                  | Agent loop, prompt, plan-change saga, reply guard                                                                |
| `packages/gateway`                                                | Model access: budgets, retries, failover between models, record and replay                                       |
| `packages/policy`                                                 | Cedar policies and the facts they are decided on                                                                 |
| `packages/identity`                                               | Token verification, grant signing, realm provisioning                                                            |
| `packages/mcp-server`                                             | Shared MCP server: per-token tool list, token exchange                                                           |
| `packages/dispatch`                                               | How recorded work becomes a running workflow                                                                     |
| `packages/db`                                                     | Schema, row-level security helpers, audit log, memory                                                            |
| `packages/telemetry`                                              | Dashboards' traces and metrics, limited to an allowlist; and full conversations for the inspection store         |
| `packages/simulator`                                              | Seeded environment, scenarios, oracle, final-state runner                                                        |
| `packages/evals`                                                  | Eval runner, report generator, quality gate, replay, capture of cases from reviewed tickets                      |
| `packages/claims`                                                 | Every claim with its tests, and the command that removes each control to check them                              |
| `infra`                                                           | Compose file, dashboards and the image every service runs from                                                   |
| `docs`                                                            | Every claim, decision records, eval report, load numbers, threat model, cut list                                 |

## Design decisions

1. [Own agent loop instead of a framework](docs/adr/0001-own-agent-loop.md)
2. [Temporal for durable execution](docs/adr/0002-temporal-for-durable-execution.md)
3. [Postgres for vectors](docs/adr/0003-postgres-for-vectors.md)
4. [Ground truth before the agent](docs/adr/0004-ground-truth-before-the-agent.md)
5. [Ticket grants for agent authority](docs/adr/0005-ticket-grants-for-agent-authority.md)
6. [Run state lives in the database, not in workflow history](docs/adr/0006-run-state-outside-workflow-history.md)
7. [Refund rules are enforced on billing records, not only in the prompt](docs/adr/0007-enforce-refund-rules-on-records.md)
8. [What is in the prompt, what is retrieved, what is remembered](docs/adr/0008-prompt-retrieval-memory.md)
9. [A plan change is one tool and a saga](docs/adr/0009-plan-change-saga.md)
10. [One model provider](docs/adr/0010-one-model-provider.md)
11. [A schema at every boundary](docs/adr/0011-schemas-at-every-boundary.md)
12. [A daily cap on the agent's refunds](docs/adr/0012-daily-refund-cap.md)
13. [Deletion is a fixed procedure, with no model in it](docs/adr/0013-deletion-without-a-model.md)
14. [Automation may stop the agent, and only a person may start it](docs/adr/0014-stopping-the-agent.md)
15. [Telemetry can carry identifiers and numbers, and nothing else](docs/adr/0015-telemetry-without-content.md)
16. [A failure in production becomes a test](docs/adr/0016-failures-become-tests.md)
17. [Conversations go to one inspection store, on purpose](docs/adr/0017-one-store-for-conversations.md)
18. [A ticket is a conversation, and a promise](docs/adr/0018-a-ticket-is-a-conversation-and-a-promise.md)

See also [what was left out, and why](docs/cut-list.md).

## Scope

- **One agent, by choice.** Every property here can be shown with one. Multi-agent orchestration would add surface without adding a proof.
- **No agent framework.** The loop is a few hundred lines, and the controls around it are the point.
- **One model provider.** Failover is between Claude models, which covers a model short of capacity and not the provider being down. Help-centre search is full-text with queries the agent writes; the vector path is built and switched off. See [ADR 10](docs/adr/0010-one-model-provider.md).
- **Local only.** The whole system runs on one machine with Docker Compose. It is not deployed to a cloud, and the local stack uses development settings: plain HTTP, password sign-in and fixed local secrets.
- **A small interface.** One page for customers and staff, written without a framework.

## Licence

[MIT](LICENSE)

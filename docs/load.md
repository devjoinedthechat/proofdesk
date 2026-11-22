# What the system costs per ticket

How long a ticket takes, and how many the system handles, when the model answers at once. This is the system's own overhead: the workflow engine, the database, the policy layer and the billing service.

Run on 21 November 2026 with `pnpm load`, on one laptop: 12 cores, 24 GB, Node 22.18, Docker Desktop.

## Tickets

Run with the tool calls going straight to billing. Every ticket is a duplicate charge that the agent refunds: three model turns, two tool calls, seven durable steps and four audit entries. 200 tickets per row, each for its own customer, with one worker process.

| Tickets at a time | Tickets a second | Median | 95th percentile |
| ----------------- | ---------------- | ------ | --------------- |
| 1                 | 2.1              | 450 ms | 514 ms          |
| 8                 | 17.0             | 451 ms | 546 ms          |
| 32                | 36.9             | 819 ms | 953 ms          |

- **About 450 ms of a ticket is this system.** In the eval runs a ticket took a median of 4.7 seconds with a real model, so the model is roughly nine tenths of the wait.
- **Each durable step costs about 65 ms.** That is one round through the workflow engine and one transaction that saves the run.
- **Eight at a time cost nothing extra.** At 32 the time per ticket doubles and throughput still rises, to about 37 a second.
- **Every run was checked.** Each row ended with exactly one refund per ticket and one unbroken audit chain. A fast run that did the wrong thing is not a result.

## The audit chain

Every company's entries go into one chain, and appends take turns on a single lock. This is how fast the chain takes entries with nothing else going on, 3,000 entries per row.

| Writers | Entries a second |
| ------- | ---------------- |
| 1       | 2,190            |
| 8       | 2,278            |
| 32      | 3,453            |

- **The lock is not the limit.** At four entries per ticket, 2,200 entries a second is about 550 tickets a second, fifteen times what the rest of the system reached.
- **More writers do not slow it.** They wait in line, and the line moves at the same speed.

## The token chain

In the full system a tool call does not go straight to billing. The agent's runtime fetches an assertion for the ticket from the portal, trades it at Keycloak for a token scoped to that tool, and the MCP server exchanges that token again before it calls billing. `pnpm load` runs both ways side by side: the same tickets, the same two tool calls, once direct and once through the chain.

Run on 22 November 2026 on the same laptop, while other work kept it busy (a load average near 50 on 12 cores). The numbers are lower than in the tables above, and lower again for the audit chain, which took about 280 entries a second in the same run. Only the two columns are comparable with each other.

| Tickets at a time | Direct: median, per second | Token chain: median, per second |
| ----------------- | -------------------------- | ------------------------------- |
| 1                 | 497 ms, 1.8                | 1,001 ms, 0.9                   |
| 8                 | 1,521 ms, 4.5              | 3,026 ms, 2.4                   |
| 32                | 5,180 ms, 5.9              | 7,152 ms, 4.2                   |

- **The chain costs about 250 ms a tool call.** One ticket at a time it doubles the system's own time, from 0.5 to 1 second, for two tool calls. Against the 4.7 seconds a real model takes it is still the smaller part.
- **That figure is probably near the quiet one.** The direct path, one at a time, was only about 10% slower here than on the quiet run. Under more tickets at once the busy machine dominates both paths.
- **Every chained run was checked too.** Each row ended with exactly one refund per ticket and an unbroken audit chain. Billing refuses a call without a token Keycloak signed for it, so every one of those refunds went through the whole chain.

## What this does not measure

- **The network.** The services run inside the measuring process, not in their own containers.
- **A production workflow engine.** Temporal runs as its development server, with one worker.
- **A production Keycloak.** It runs as one development container.
- **The daily refund cap.** It is lifted for the run. With it in place, every ticket after the first few would wait for staff, which is the cap doing its job.
- **Another machine.** These are one laptop's numbers. They show where the time goes, not what a deployment would reach.

## Reproduce

```sh
pnpm load                                  # 200 tickets at 1, 8 and 32 at a time, direct and through the token chain
pnpm load --paths direct                   # without the token chain
pnpm load --tickets 500 --concurrency 64   # other sizes
```

Needs Docker. It starts its own Postgres, Temporal and, for the token chain, Keycloak, and spends nothing.

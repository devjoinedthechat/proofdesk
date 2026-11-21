# What the system costs per ticket

How long a ticket takes, and how many the system handles, when the model answers at once. This is the system's own overhead: the workflow engine, the database, the policy layer and the billing service.

Run on 21 November 2026 with `pnpm load`, on one laptop: 12 cores, 24 GB, Node 22.18, Docker Desktop.

## Tickets

Every ticket is a duplicate charge that the agent refunds: three model turns, two tool calls, seven durable steps and four audit entries. 200 tickets per row, each for its own customer, with one worker process.

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

## What this does not measure

- **The token chain.** Tool calls here go straight to the billing service. In the full system each one also fetches an assertion from the portal, trades it at Keycloak, and is exchanged again by the MCP server.
- **The network.** The services run inside the measuring process, not in their own containers.
- **A production workflow engine.** Temporal runs as its development server, with one worker.
- **The daily refund cap.** It is lifted for the run. With it in place, every ticket after the first few would wait for staff, which is the cap doing its job.
- **Another machine.** These are one laptop's numbers. They show where the time goes, not what a deployment would reach.

## Reproduce

```sh
pnpm load                                  # 200 tickets at 1, 8 and 32 at a time
pnpm load --tickets 500 --concurrency 64   # other sizes
```

Needs Docker. It starts its own Postgres and Temporal, and spends nothing.

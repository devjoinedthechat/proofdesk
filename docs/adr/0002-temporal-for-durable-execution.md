# 2. Temporal for durable execution

Status: accepted, 2026-11-13

## Context

A ticket can run for days: a refund over the limit waits for staff approval. A worker can crash between any two steps, including after a refund is issued and before it is recorded.

The agent therefore needs durable execution: state that survives crashes, retries with idempotency, and a way to wait for a person.

## Options

| Option                    | For                                                                               | Against                                                                            |
| ------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Temporal                  | Long track record; versioning for running workflows; signals; UI for stuck runs   | One more service; determinism rules for workflow code                              |
| DBOS                      | State in the Postgres we already run; database steps commit with their checkpoint | Younger; less tooling for stuck runs; recovery depends on the application database |
| Queue plus status columns | No new dependency                                                                 | We would rebuild retries, timers and recovery, and get them wrong                  |

## Decision

Temporal. One workflow per ticket; every model call and tool call is an activity; approvals arrive as signals.

## Why

- **Changing running workflows.** A ticket paused for approval must survive a deploy. Temporal's workflow versioning and task-queue routing cover this, and the canary release builds on the same routing.
- **Separate failure domain.** Orchestration state does not live in the application database, so a database incident does not also stop recovery.
- **Operational view.** Every waiting, retrying or failed workflow is inspectable with its history.

## Cost

- Activities run at least once, so every tool call carries an idempotency key.
- Workflow history stores activity inputs and outputs. Personal data must stay out of it: workflows pass record IDs, not records.
- Workflow code must be deterministic. A test replays a finished ticket's history, with an approval wait in it, through the current workflow code and fails if the two diverge.

## When this breaks

A small team that wants one datastore and no extra service is better served by DBOS. The workflow shape here (idempotent steps, signals, compensation) ports to it directly.

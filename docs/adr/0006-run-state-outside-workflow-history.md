# 6. Run state lives in the database, not in workflow history

Status: accepted, 2026-11-13

## Context

Temporal makes a workflow durable by recording every activity's input and output in its history and replaying from it. An agent's activities naturally pass the conversation around: ticket text in, model responses and tool results out.

That would put customers' words and billing details into workflow history, where they are hard to delete and visible to anyone with access to the Temporal UI. A data-deletion request must be able to remove them.

## Decision

The workflow carries identifiers and step numbers only. The conversation is stored in one database row per ticket (`agent_runs`), and each activity loads it, applies one step, and saves it.

- **Workflow input:** ticket id, tenant id, customer id.
- **Activity inputs:** those identifiers and a step number, plus a staff decision when there is one.
- **Activity outputs:** counts and flags, such as "two tool calls pending" or "needs approval".

A test reads a finished workflow's history and checks it contains the ticket id but none of the ticket text, the customer's name or email, or the refunded amount.

## Applying a step exactly once

Temporal runs activities at least once. An activity can finish its work and be run again because the worker died before reporting back, or because a slow attempt overlapped with its retry.

Each run has a step counter. An activity names the step it is applying, and the save is conditional on the counter still having that value.

| Situation                               | What happens                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Retry after the step was saved          | The counter has moved on. The saved output is returned and nothing runs                            |
| Two attempts overlap                    | Both do the work, one save wins, the other returns the winner's output                             |
| Crash after a tool ran, before the save | The retry calls the tool again with the same idempotency key, and billing returns the first refund |

The idempotency key is derived from the ticket and the call's arguments, not chosen by the model, so it is the same on every attempt.

## Approvals

When policy asks for approval, the activity records the request and returns without advancing the step. The workflow waits for a signal, for up to seven days, then runs the same step again with the decision. Policy is asked again with the approval as a fact, so an approval cannot override the kill switch.

## Cost

- **A database read and write per step**, on top of the model or tool call. Small next to either.
- **The agent loop exists as step functions**, not only as a loop. The in-process loop used for evaluations is those same functions run back to back, so there is one implementation.
- **The database is now needed to resume a workflow.** Temporal alone cannot. This gives up part of the separation ADR 2 valued, in exchange for deletable conversations.
- **Model calls can be paid for twice** when an attempt is retried. Tool effects cannot.

## When this breaks

For very long conversations, rewriting one large JSON row per step becomes wasteful, and the state should move to append-only message rows.

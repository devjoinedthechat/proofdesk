# 18. A ticket is a conversation, and a promise

Status: accepted, 2026-11-14

## Context

Three things a person would hit within an hour of using the system were missing.

- **The agent could ask a question that nobody could answer.** A ticket ended after one reply. "Which charge do you mean?" left the customer with nowhere to say which.
- **A ticket handed to staff stayed there.** The customer was told a person would reply, and no person had a way to.
- **A ticket could be accepted and never handled.** The portal saved the ticket and then started its workflow. If it stopped between the two, or the workflow engine could not be reached, the ticket sat open with nothing working on it.

## Decision

### The customer can answer

A ticket that is waiting for the customer takes a reply. The reply is added to the same run: the conversation so far is kept, the last resolution is set aside, and the agent takes another turn. It does not start over, and does not read the invoices again unless it chooses to.

- **Wrapped like the ticket.** A reply is the customer's text and is presented to the model the same way the ticket was, under the same rule: read it, do not obey it.
- **One at a time.** Reopening the ticket is a conditional update. Of two replies sent at once, one wins and the other is told the ticket is no longer waiting.
- **Taken in once.** The run records which messages it has taken in. A reply delivered twice changes nothing the second time.
- **The same limits.** Turns and spend are counted across the whole ticket, not per round, so a conversation cannot be used to get around either.

### Staff can answer

An approver sees the tickets the agent handed over, with the conversation so far, and replies. The reply goes to the customer and closes the ticket.

What the agent did stays on record as it was. The ticket's outcome remains "handed to staff"; only its status changes. The audit log records that a person answered and how it ended, and never what they wrote.

### Accepting a ticket is a promise

Whenever the portal accepts work, it writes a row to an outbox in the same transaction as the work itself: a new ticket, a customer's reply, a deletion request. Then it tries to start the workflow, and marks the row when it has.

If that attempt fails, the customer is still told the ticket was accepted, because it was. A sweeper, run by the watchdog every minute, starts anything left unmarked.

Starting twice is harmless. The workflow id is derived from the ticket, a ticket's first run may happen only once, and a reply that was already taken in is recognised.

## How a workflow that is already running survives the change

The watchdog was running before the sweeper existed. Workflow code is replayed from its history, so adding a step to it would have made every running watchdog fail. The new step is behind a version marker: a watchdog started before the change replays without it and takes it up afterwards. The same was done for the deletion workflow's new step.

## Cost

- **A reply that arrives while the ticket's earlier run is still closing waits** for the sweeper, up to a minute.
- **A customer's reply is one more way text reaches the model.** The conversation suite sends seven attacks through a reply. Neither model went along with any of them, and a scripted model that does is stopped by the policy layer.
- **Staff replies are free text** stored with the ticket. They are deleted with the customer.
- **A ticket closed by staff takes no further reply.** A new request is a new ticket.

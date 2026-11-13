# 9. A plan change is one tool and a saga

Status: accepted, 2026-11-13

## Context

Changing a customer's plan touches two systems of record: the subscription in billing, and the entitlement that decides what the workspace can use. They have separate databases and cannot change in one transaction.

If only one of them changes, the customer either pays for something they cannot use or uses something they do not pay for.

## Decision

The agent is given one tool, `change_plan`. It never sees the service tools that make up the change. The system runs them in a fixed order, as a saga:

1. Change the subscription in billing.
2. Set the entitlement to match.
3. If step 2 is refused, undo step 1.

All three carry the same idempotency key, derived from the ticket and the requested change.

## Why the model does not sequence the writes

Left to call two tools, a model can call one and stop, call them in the wrong order, or resolve the ticket after the first. Each of those leaves the two systems disagreeing. Which writes belong together is a property of the systems, not a judgment about the ticket, so it belongs in code.

The model decides what to change. The system decides how.

## What happens on failure

| Failure                                                    | Result                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Billing refuses (unknown plan, cancelled subscription)     | Nothing changed. The model is told why                                                     |
| The worker dies after billing changed, before entitlements | The step is retried. Billing returns the change it already made, and the saga continues    |
| Entitlements refuses                                       | Billing is put back exactly as it was. The model is told nothing has changed               |
| The worker dies during the undo                            | The step is retried. Billing reports the change, entitlements refuses again, the undo runs |
| The undo itself is refused                                 | The step fails loudly and keeps being retried. This needs a person                         |

**A crash and a refusal are handled differently on purpose.** A crash says nothing about whether the write happened, so the right response is to try again with the same key. A refusal is an answer, so the right response is to undo.

## Where it runs

The saga runs inside a single workflow activity. Because every step is idempotent, retrying the whole activity is the same as resuming it. That is simpler than modelling each step as its own activity with compensation in workflow code, and gives the same end states.

## Cost

- **Billing needed an undo.** A plan change records what it replaced, and can be reverted only while the subscription still has the values it set.
- **Entitlement writes needed idempotency keys,** stored with their result.
- **The undo can be refused** if the subscription was changed again in between. That case is not resolved automatically.

## Limits

- **No charge or credit is made at the time of the change.** Changes apply from the next renewal, which avoids proration and with it a third system.
- **Two systems.** With three or more, the saga should move into workflow code where each step's state is visible.

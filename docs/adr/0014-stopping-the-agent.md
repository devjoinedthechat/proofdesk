# 14. Automation may stop the agent, and only a person may start it

Status: accepted, 2026-11-13

## Context

Three things can be wrong with an agent in production that no single ticket shows: a new build that behaves worse than the last, a model that has started misreporting what it did, and a tool that is doing damage. Each needs a control that works across tickets, and each must work when nobody is watching.

## Decision

Three controls, and one rule that covers all of them: **whatever acts without a person may only stop things.**

| Control                  | Stops                                         | Set by                       | Lifted by           |
| ------------------------ | --------------------------------------------- | ---------------------------- | ------------------- |
| Kill switch, whole agent | Every model call and tool call for one tenant | An operator, or the watchdog | An operator         |
| Kill switch, one tool    | That tool, for one tenant                     | An operator                  | An operator         |
| Canary rollback          | New tickets going to the canary build         | The watchdog                 | The deploy pipeline |

### The kill switch

- **It is read before every model turn and every tool call.** A ticket in progress stops at its next step. A refund staff already approved is not paid.
- **A paused agent makes no model call.** The ticket goes to staff as it stands.
- **One tool can be paused alone.** The agent keeps answering and reading; the paused tool is denied by a policy that approval does not override.
- **Operators are their own role.** Approving refunds does not include stopping the agent, and an operator acts only inside their own tenant.

### The canary

A share of new tickets is sent to a second build on its own task queue. The ticket's id decides which, so the split is exact over time and the same ticket always gets the same answer. The route is stored with the ticket.

### The watchdog

A workflow that runs every minute and applies two rules to counts of finished tickets:

- **Roll the canary back** when it has finished at least 10 tickets and its failure rate is more than 20 points above the stable build's. A failure is a run that did not end in a clean resolution, or a reply the guard stopped.
- **Pause a tenant's agent** when the reply guard stopped 5 of its tickets on the stable build within the hour. A guard stop means the model said it did something it did not.

The rules are a pure function of counts and thresholds. No model grades anything.

## How the rule is enforced

The worker's database role cannot write to the kill switch or the rollout. It can call three functions:

- `pause_agent` sets a pause and cannot clear one.
- `rollback_canary` sets the canary's share to zero and cannot raise it.
- `agent_health` returns counts per tenant and route, and no ticket.

So a watchdog that is wrong can cause an unnecessary pause or rollback, which a person undoes. It cannot restart an agent a person stopped, widen a canary, or read a ticket.

## Cost

- **A false alarm stops work** until a person looks. That is the intended direction of failure.
- **Thresholds are fixed numbers,** chosen by judgment and not tuned on traffic.
- **The comparison needs volume.** A canary that receives few tickets is not judged, and so is not rolled back.
- **An alert is a row, an audit entry and a log line.** No pager or chat channel is connected.

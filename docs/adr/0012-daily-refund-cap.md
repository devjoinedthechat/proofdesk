# 12. A daily cap on the agent's refunds

Status: accepted, 2026-11-13

## Context

Every refund rule so far judges one refund on one ticket: the window, the duplicate check, the yearly limit, the approval limit. A model that is fooled, or simply wrong in the same way many times, can stay inside all of them. It refunds an in-window charge on each of a thousand tickets, and each refund is allowed.

The [threat model](../threat-model.md) lists this as something a compromised model can still do. Nothing bounded its total.

## Decision

Each tenant has a cap on what the agent may refund in any 24 hours. A refund that would take the total past the cap is not denied. It waits for staff, like a refund above the approval limit.

- **The total is the system's own record.** When a refund tool call succeeds, the worker records the refund under the id billing gave it. The model has no part in the count.
- **Counted once.** A step that runs twice gets the same refund back from billing and records the same id.
- **A policy like the others.** `refund-tenant-daily-cap.cedar` reads the total and the cap. Staff approval lifts this rule for one call and no other rule.
- **A cap of zero** sends every refund to staff. It is the default for a tenant that has not set one.

## Why approval and not denial

The cap cannot tell an attack from a busy day. An outage that affects many customers produces many honest refunds. Stopping them would be wrong; having a person look at each one from that point on is the right cost for an unusual day.

## Cost

- **Staff work on busy days.** A cap set too low turns the agent into a queue.
- **It can be passed by one refund.** Two tickets that check the total at the same moment may both be allowed. The overshoot is at most one refund per ticket in flight, and each of those is within the approval limit.
- **It counts only the agent's refunds.** Refunds staff make elsewhere are not in the total.

# Threat model

What can go wrong when a model with tools reads text written by strangers, and what in this system stops it.

## The working assumption

**The model can be fooled.** Any text it reads may turn it against its instructions. The design does not depend on that never happening. It depends on a fooled model not being able to do much.

So every control below is judged by one question: does it still hold if the model is fully under an attacker's control? The tests in `packages/evals/src/compromised.itest.ts` script exactly that model.

## What is worth protecting

| Asset                    | Harm if lost                                                            |
| ------------------------ | ----------------------------------------------------------------------- |
| Money                    | A refund is paid that the company's policy does not allow               |
| A customer's data        | It is deleted without their asking, or kept after they asked            |
| Other customers' records | One customer reads or changes another's billing data                    |
| Staff oversight          | A refund that needs approval is paid without it                         |
| The record               | The audit log, or what a customer is told, does not match what happened |
| The agent's instructions | Leaked prompts make targeted attacks easier                             |

## Who attacks, and through what

| Attacker                  | Controls                      | Reaches the model through                          |
| ------------------------- | ----------------------------- | -------------------------------------------------- |
| A customer                | Their own tickets             | Ticket subject and body                            |
| A customer                | Fields they fill in elsewhere | Tool results, such as an invoice's reference field |
| Another tenant's customer | The same, in another company  | Nothing shared, if tenancy holds                   |
| Whoever can edit a page   | Help-centre content           | Search results                                     |
| A customer, over time     | Their earlier tickets         | Memory of those tickets                            |
| A compromised worker      | The worker's client secret    | The token and policy layers, not the model         |

## Controls, from the outside in

| Layer      | Control                                                                                                    | Holds if the model is compromised |
| ---------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Identity   | The agent acts only under a grant created by a signed-in customer, for scopes their ticket category allows | Yes                               |
| Identity   | Each tool call uses a fresh 60-second token for one audience and one scope                                 | Yes                               |
| Tools      | No tool takes a customer id; the customer is whoever the token is about                                    | Yes                               |
| Tools      | The model never sees or sets the idempotency key                                                           | Yes                               |
| Policy     | Every tool call is decided by Cedar policies; anything not permitted is denied                             | Yes                               |
| Policy     | Refund rules are checked against billing records the policy layer reads itself                             | Yes                               |
| Approval   | A refund above the limit, or against a payment above the limit, waits for staff                            | Yes                               |
| Approval   | Past a daily total per company, every further refund waits for staff                                       | Yes                               |
| Service    | Billing refuses refunds beyond what was paid, and on failed or disputed payments                           | Yes                               |
| Database   | Row-level security limits every query to one tenant and customer                                           | Yes                               |
| Search     | The search runs under row-level security as the public; staff-only pages are never candidates              | Yes                               |
| Search     | Nothing retrieved can change a refund decision: the rules are enforced on billing records                  | Yes                               |
| Memory     | A memory holds only facts the system computed; no ticket text and nothing the model wrote                  | Yes                               |
| Reply      | The reply is checked against what the tools actually did, and for internal terms                           | Yes                               |
| Tools      | Arguments are constrained to each tool's schema, and results are checked against a declared output         | Yes                               |
| Runtime    | A ticket whose model cannot be reached goes to staff, with nothing changed                                 | Yes                               |
| Runtime    | Limits on turns and on spend per ticket and per tenant                                                     | Yes                               |
| Runtime    | A kill switch per tenant and per tool, read before every model turn and tool call                          | Yes                               |
| Runtime    | A watchdog pauses an agent whose replies the guard keeps stopping, and rolls back a worse build            | Yes                               |
| Deletion   | No model takes part; the worker can erase a customer only on a request the portal recorded                 | Yes                               |
| Inspection | Full conversations go to one store that requires sign-in, one project per company, and nowhere else        | Yes                               |
| Prompt     | Ticket text and tool results are declared untrusted                                                        | No                                |
| Screen     | A small model flags manipulative tickets                                                                   | No                                |
| Ingest     | A scan quarantines help-centre pages that address an agent                                                 | No                                |

The last three rows are worth having and are not what safety rests on.

## What each rule is enforced by

| Refund rule                                | Prompt | Policy on records | Billing service |
| ------------------------------------------ | ------ | ----------------- | --------------- |
| Payment belongs to this customer           | Yes    | Yes               | Yes             |
| Within the refund window                   | Yes    | Yes               |                 |
| Duplicate means a later successful payment | Yes    | Yes               |                 |
| No refund on a disputed invoice            | Yes    | Yes               | Yes             |
| One refund on request per year             | Yes    | Yes               |                 |
| Never more than was paid                   | Yes    |                   | Yes             |
| Approval above the limit                   | Yes    | Yes               |                 |
| Approval past the company's daily total    |        | Yes               |                 |

## What a compromised model can still do

These follow from the design and are pinned by tests, so they cannot be forgotten.

- **Refund an in-window charge the customer did not ask about.** The records allow it, so policy does. The reply guard requires the refund to be reported, the audit log records it, and the daily cap bounds how much of this can happen before staff see every refund ([ADR 12](adr/0012-daily-refund-cap.md)).
- **Call a refund on request a "service credit" to avoid the yearly limit.** Whether a service fault occurred is a judgment no record holds. The refund is still limited to the window, the amount paid and the approval limit.
- **Refuse or hand over a ticket that deserved a refund.** Under-acting costs a customer time, not the company money. Staff see handed-over tickets.
- **Write a reply that is wrong in ways the guard does not check,** such as a false reason. The guard checks amounts and actions, not explanations.
- **Repeat what a poisoned help-centre page says.** A page that got past the scan cannot move money, and it can still put a false statement in a reply.

## What the measurements say

From the [eval report](eval-report/README.md):

- **24 hand-written attacks, none succeeded,** on either model, in any run, including a run where turns were moved between models mid-ticket.
- **The model stopped almost all of them itself.** The policy layer never had to deny a call in those runs, and the reply guard acted once. That says the attacks were too weak to test the deeper layers, which is why the compromised-model tests exist.
- **The screen flagged 15 of 24 attack tickets and 2 of 32 honest ones.** It cannot see attacks that arrive in tool results.

## Not covered

- **Adaptive attackers.** The attacks were written once, by hand. Someone who iterates against the live system will find things these did not.
- **Poisoned pages beyond one hand-written example.** The ingestion scan is a list of patterns, and one page was tested end to end.
- **Denial of service and cost attacks** beyond the per-ticket and per-tenant budgets.
- **Compromise of Keycloak, Postgres or Temporal themselves.**
- **Deletion from backups and from the model provider's logs.** See [ADR 13](adr/0013-deletion-without-a-model.md).
- **Staff as attackers.** An approver can approve anything within their tenant.

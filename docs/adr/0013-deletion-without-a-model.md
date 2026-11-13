# 13. Deletion is a fixed procedure, with no model in it

Status: accepted, 2026-11-13

## Context

A customer may ask for their data to be deleted. The request is irreversible, it reaches every store, and getting it half right is worse than refusing it.

The agent handles refunds and plan changes by reading a ticket and deciding what to do. Nothing about a deletion needs deciding: the customer either asked or did not, and what must go is the same every time.

## Decision

A deletion is requested through its own endpoint and carried out by its own workflow. No model reads the request, chooses a step, or is offered a tool that erases anything.

### The request

- **A fixed action, not a ticket.** The ticket form does not accept a deletion. There is no free text for anyone to interpret.
- **A fresh sign-in.** The token must have been issued within the last five minutes. A session left open on a shared computer is not enough.
- **A typed confirmation.** The customer types their own email address, and it must match the account.
- **Every other grant is revoked at once.** From that moment no agent can act for the customer on any ticket.

### The workflow

| Step | What it does                                                          | On whose authority                             |
| ---- | --------------------------------------------------------------------- | ---------------------------------------------- |
| 1    | Stops the workflows of the customer's open tickets                    | The system's                                   |
| 2    | Removes the customer's conversations from the inspection store        | The system's                                   |
| 3    | Cancels subscriptions and clears the customer's text on invoices      | The request's own grant, one scope, 60 seconds |
| 4    | Removes access in the entitlements service                            | The request's own grant, likewise              |
| 5    | Erases the customer from the application database, in one transaction | A database function that requires the request  |
| 6    | Deletes the sign-in account                                           | An identity administrator's                    |

Steps 3 and 4 come before step 5 because they need the grant, which step 5 erases. Every step is safe to repeat.

### What the worker cannot do

The worker's database role cannot delete a customer, a ticket or a memory. It can call one function, `erase_customer`, which acts only on a request the portal recorded for that customer. The worker cannot create such a request.

So a worker that is compromised, or simply wrong, cannot erase someone who did not ask. The same holds in billing: the service's role cannot cancel a subscription itself, only call a function that acts inside its row scope.

## What is kept, and why

| Kept                           | Why                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Invoices, payments and refunds | The company must keep its financial records. The customer's free text on them is cleared.                                 |
| The audit log                  | It never held personal data: identifiers and amounts only. Removing entries would break the chain that makes it evidence. |
| The record of the request      | Identifiers and counts, to show the deletion happened.                                                                    |
| The customer's id              | A random identifier, kept in the three places above. Nothing that says who it was remains next to it.                     |
| Workflow histories             | They hold identifiers and step numbers only ([ADR 6](0006-run-state-outside-workflow-history.md)).                        |

## How it is tested

One test gives a customer a real history: a ticket resolved with a refund, a second ticket waiting for staff, a memory, text on their invoices. The customer then asks to be deleted, and every table of every database, every workflow history, the inspection store and the identity provider are searched for their name, their email address and a marker word from their tickets.

The same test checks that nobody else was touched, that the financial records are all still there, that the audit chain still verifies, and that the waiting ticket's workflow was stopped.

## Cost

- **No undo.** There is no grace period in which a request can be withdrawn.
- **The identity step uses an administrator account.** A narrower account that can only delete users is the right production setup and is not built.
- **Backups are out of scope.** Data in a database backup stays until the backup expires.
- **Model provider logs are out of scope.** What was sent to the model for earlier tickets is governed by the provider's retention.

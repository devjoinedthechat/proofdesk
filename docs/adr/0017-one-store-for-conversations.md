# 17. Conversations go to one inspection store, on purpose

Status: accepted, 2026-11-14

## Context

[ADR 15](0015-telemetry-without-content.md) keeps customer text out of traces and metrics. That left one question unanswered: where does a person look to see what the model was actually sent, and what it said?

The answer was the application database, with a SQL query. That is enough to recover a conversation and not enough to inspect one. Reading a ticket's turns, the tool calls between them, the policy's verdict on each and the tokens they cost is what an inspection tool is for, and building one would prove nothing about the agent.

## Decision

Full conversations are sent to one inspection store, Arize Phoenix, self-hosted. It is treated as a second copy of customer data and given the controls that implies.

| Rule                          | How it is enforced                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Content goes to one place     | Dashboards still receive identifiers and numbers only. The two pipelines are separate code with separate exporters. |
| Off unless configured         | Without an address for the store, nothing is sent anywhere.                                                         |
| Sign-in required              | The store runs with authentication on. Reading and writing both need a credential.                                  |
| One project per company       | A company's conversations are written to its own project, so access can be granted per company.                     |
| A deletion request reaches it | The deletion workflow removes the customer's conversations there, and the sweep test searches the store.            |

## What is recorded

One trace per ticket, with the same trace id as the ticket's trace in the dashboards, so the two can be matched.

- **The ticket,** as the root: what the customer wrote, the reply they received, the outcome, the reason, what the reply guard objected to, and the versions in force.
- **Each model call:** the instructions, every message, the tools offered, the answer, the model that answered and the one that was asked for, and the token counts.
- **Each tool call:** its arguments, the policy layer's verdict, and its result.

Spans follow the OpenInference conventions, so any tool that reads them would do.

## Which instructions were in force

An inspection is worth little if it cannot say what the model had been told. Each run now records:

- **The prompt version** from the code that is running, not a placeholder.
- **A hash of the system prompt's text** for that company, since the text differs per company.
- **A fingerprint of the policy set:** the schema and every policy's text.

## Cost

- **A second store holds customer data.** Its backups, its access and its retention are now part of the system's privacy surface.
- **Deletion has one more step that can fail.** A conversation sent after the deletion step ran would survive it. Agents working for the customer are stopped first and pending sends are flushed before deleting, which closes the ordinary cases and not a worker that was unreachable at the time.
- **Per-company access is the store's to enforce.** This system writes to separate projects. Who may open which project is configured in the store.
- **Failed model calls are not recorded,** only ones that returned. Failures are counted in the dashboards.
- **The model's private reasoning is not shown.** It is kept as the provider returned it and is not readable text.

## Why not the alternatives

- **A viewer of our own.** Weeks of interface work to reach what an existing tool does on its first day.
- **A hosted service.** Customer conversations would leave the machine.
- **Langfuse, self-hosted.** A fine choice, and heavier to run: several more services against Phoenix's one container.

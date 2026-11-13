# 15. Telemetry can carry identifiers and numbers, and nothing else

Status: accepted, 2026-11-13

## Context

An agent's traces are where customer data usually escapes. The natural thing to record about a model call is its prompt and its answer, and the natural thing to record about a tool call is its arguments and result. Those are the ticket, the reply and the customer's billing records, copied into a system with its own access rules, its own retention and no part in a deletion request.

Telemetry is also needed: cost per ticket, latency, how often the agent hands over, what the policy layer denied.

## Decision

Telemetry is built so that content cannot be attached, instead of relying on each call site to leave it out.

- **A fixed list of attributes.** A span or metric can carry the attributes named in `packages/telemetry` and no others. The list has identifiers (tenant, ticket), fixed vocabularies (event, tool name, verdict, outcome, reason, model) and numbers. It has no attribute for text.
- **Strings must look like identifiers.** A string value that contains a space or other punctuation is replaced before it is recorded, and a counter records that it happened. A sentence cannot get out through an attribute meant for a code.
- **Errors are recorded by type.** An error message can quote anything.
- **Metrics mirror the audit log.** One counter, `proofdesk.events`, is incremented for every audit entry. The audit log was already limited to identifiers and amounts, so the dashboards and the record of what happened are the same stream and cannot disagree.

## One trace per ticket

A ticket's work is spread over many activities, retries, days and possibly several workers. There is no call stack to carry a trace context along.

The trace id is derived from the ticket id. Every span about a ticket, from any process at any time, lands in one trace, under a root span written when the run starts. Nothing has to be passed between steps or stored.

## What this costs

- **No prompts or replies in traces.** To see what the model was shown for a ticket, a person with access to the application database reads the run there, under its access rules and its deletion.
- **Debugging is one step longer.** A trace says which step failed and how; the content is one lookup away.
- **Only the worker is instrumented.** The portal, the services and the MCP servers do not emit telemetry yet.
- **The local stack's Grafana is a development image,** with anonymous access.

## How it is tested

A ticket is handled from arrival to refund with telemetry kept in memory. Everything that would have been exported is then searched for the customer's name and email address, the ticket's text, the reply and the amount. The redaction counter must be zero: nothing had to be removed, because nothing was offered.

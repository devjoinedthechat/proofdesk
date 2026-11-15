# Security

Proofdesk is a reference system. It is not run as a service, and nobody's data is in it. A flaw in it still matters, because the repository's claims are about security: authority, isolation, deletion.

## Reporting a vulnerability

Report it privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability**. Please do not open a public issue for it.

A useful report says what an attacker can do, from which starting point (a customer, a member of staff of another company, a manipulated model, a compromised service), and how to reproduce it against the local stack.

You can expect an answer within a week.

## What counts

Anything that breaks a control described in the [threat model](docs/threat-model.md), for example:

- one customer or company reaching another's records
- the agent acting beyond its ticket's grant, or past a policy rule or a person's rejection
- a deletion that leaves the person's data behind
- an audit log that can be changed without the change showing
- content that reaches telemetry, logs or the workflow history

## What does not

The local stack's development settings are deliberate and listed in the [cut list](docs/cut-list.md): plain HTTP, password sign-in, and default credentials in `infra/compose/compose.yaml`. They are for one machine and are not how a deployment would be configured.

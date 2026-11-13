# 11. A schema at every boundary

Status: accepted, 2026-11-13

## Context

A model produces text. Everything the system does with that text, and everything it hands the model, crosses a boundary between code that can be reasoned about and a component that cannot. An unchecked value at any of them is a place where "usually right" enters a system of record.

## Decision

Every boundary has a schema, and the value is checked against it by the side that depends on it.

| Boundary                        | Schema                                  | Checked by                                    |
| ------------------------------- | --------------------------------------- | --------------------------------------------- |
| Model to tool: the arguments    | The tool's input schema, in strict mode | The provider while generating; the tool again |
| Model to system: the resolution | Fixed outcome and reason codes          | The provider; the agent loop again            |
| Tool to caller: the result      | The tool's output schema                | The tool before it answers                    |
| Billing records to policy       | The fields policy decides on            | The policy layer before it decides            |
| Tool result to saga and guard   | The fields each one reads               | The saga and the reply guard                  |
| Service request and response    | The service's wire format               | The service; its client                       |
| Policy to its own vocabulary    | The Cedar schema                        | Policy validation at load                     |

## Why checked twice

Strict mode makes the model's arguments match the tool's schema as they are generated. The API enforces only part of JSON Schema: it drops numeric ranges and string lengths. So the gateway sends the tool's schema in the form strict mode accepts, and the tool validates the full schema when called. A value strict mode lets through, such as a refund of zero cents, is refused there.

The same holds in the other direction. A tool declares its output and validates it before answering, and the code that then acts on that output validates the fields it reads. Each side checks what it depends on and trusts nothing it did not check.

## What a mismatch does

- **Arguments that do not match:** the tool does not run. The model is told and may correct the call.
- **A tool result that does not match its declared output:** the call fails loudly. It is a fault in the system, not something for the model to work around.
- **Billing records policy cannot read:** no decision is made, and so no refund.
- **A saga step whose answer cannot be read:** the step fails and is retried. Every step is idempotent, so the retry is safe.

## What a schema does not give

A schema constrains shape. `create_refund` with a well-formed payment id and a positive amount is valid whether or not the refund should be made. Whether it should is decided by policy on billing records ([ADR 7](0007-enforce-refund-rules-on-records.md)), not by the schema and not by the model.

The reply to the customer is free text by design. It is checked against what the tools did, and its claims beyond that are not verified.

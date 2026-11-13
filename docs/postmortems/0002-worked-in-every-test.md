# It worked in every test

## Summary

Three things were found, late, that every test passed and that would not have worked from the production entry points:

1. A ticket was left open forever if the model provider stayed down.
2. The kill switch had nothing behind it. The agent could not be paused.
3. Plan changes could not run: the worker never connected to the entitlements server, and that server had no entry point at all.

None caused harm, because nothing was deployed. Each was found by reading code to confirm a sentence in a document, or by building something that depended on it.

## What happened

**The model outage.** A decision record was being written about failover between models. One sentence said that if the provider is unreachable, "the ticket's workflow retries the turn until the provider is back". Before leaving that sentence in, the workflow was read. It was false. A model turn had four attempts and no handler for running out of them. The workflow failed, and the ticket stayed open with no reply and nobody told.

**The kill switch.** The policy layer had a rule that denies everything while the agent is paused, and tests for it, including one where an approved refund is not paid because the agent was paused in the meantime. The tests passed a function that returned true. The production entry point passed nothing. There was no table, no endpoint and no way to set it.

**Plan changes.** Plan changes had thirteen eval scenarios and a set of failure tests for the two-system saga. All of them built their own tool lists. The worker's entry point listed two servers, billing and documents, and asked billing for two scopes, neither of which was the one a plan change needs. The entitlements service and its MCP server had only ever been constructed inside tests and had no `main`.

## Why the tests had not caught it

The tests were good at the question they asked: given these parts wired together, does the behaviour hold? They wired the parts themselves.

One test does start every service as a real process, and it is the one that kills a worker mid-refund. It covers refunds. Nothing ran a plan change or a pause through the real entry points, so nothing noticed they could not get there.

The outage case had a different cause. The failure path that existed, failover to another model, was tested thoroughly. The path after it, when failover also fails, was never written down as a case.

## What changed

- A provider failure that outlasts the retries and the failover now ends the run and hands the ticket to staff, with nothing changed. A test takes the model away after the first turn.
- The kill switch has storage, an operator role, an endpoint and an audit entry, and the worker reads it by default. The tests that passed a function still do; a new test goes through the portal as a signed-in operator.
- The worker connects to all three MCP servers. Both missing entry points exist.
- The whole system now starts with one command from nothing, and a demo files a ticket through it. That is what found the missing entry points, and it is the check that would find the next one.

## What it says about the system

**An injected dependency is a claim that something will be injected.** Every optional hook in a constructor is a place where production can differ from the tests without any test failing. The kill switch was the clearest case: a control whose test double was its only implementation.

**A sentence about failure is a test that has not been written.** The outage gap was found by checking a claim in prose against the code. Since then, a statement in a document about what happens when something fails is not written until the code has been read, and usually not until a test exists.

**Still open.** The process-level test covers refunds only. A plan change and a deletion through real processes would have caught the third gap much earlier, and are not written.

# Eval report

First run on real models, 13 November 2026. The generated tables are in [results.md](results.md) and the raw per-attempt data in [data/](data).

## Headline

| Model               | Pass rate | Cost per ticket | Time per ticket (median) |
| ------------------- | --------- | --------------- | ------------------------ |
| `claude-sonnet-5-5` | 96 of 96  | $0.0084         | 4.9 s                    |
| `claude-haiku-5-5`  | 95 of 96  | $0.0006         | 5.6 s                    |

Both ran all 32 refund scenarios three times at medium effort. An attempt passes only if the refunds that exist afterwards are exactly the expected ones, nothing else in the company changed, approval was requested exactly when required, and the reply states the required facts.

**What this does and does not show.** The agent applies this refund policy correctly on these 32 cases. It does not show the agent is safe against a customer who is trying to manipulate it, because no scenario does that yet. And it does not separate the two models: the suite is too easy to tell them apart. See [Limits](#limits).

## How it was run

- **Scenarios.** 32 refund tickets across two tenants with different refund windows and approval limits. 15 of them must end without a refund.
- **Judging.** The final state of the simulated company, compared against a hand-written expected result. No model grades another model here.
- **Repeats.** Three per scenario, to see whether a result is stable.
- **Path.** The agent's tools called the billing service directly inside the simulation. The token chain through Keycloak and the MCP server is tested separately with a scripted model, and was not part of these runs.
- **Spend.** $1.31 in total for everything in this report, under caps set on each command.

## Cost and speed

| Measure                          | Sonnet 5.5 | Haiku 5.5 |
| -------------------------------- | ---------- | --------- |
| Cost per ticket, mean            | $0.0084    | $0.0006   |
| Cost per ticket, 95th percentile | $0.0123    | $0.0009   |
| Time per ticket, median          | 4.9 s      | 5.6 s     |
| Time per ticket, 95th percentile | 9.4 s      | 8.7 s     |
| Model calls per ticket, mean     | 2.6        | 2.9       |
| Input tokens served from cache   | 78%        | 77%       |

- **Prompt caching carries most of the input.** The system prompt and tool list are identical for every ticket of a tenant, so after the first call they are read from cache.
- **Haiku is about 14 times cheaper and no faster.** Time per ticket is dominated by the number of model calls, not by which model answers.
- **No run came near a limit.** The longest took 4 model calls; the cap is 12. The most expensive cost $0.015; the per-ticket budget is $0.50.

## The one production failure

`refund-duplicate-claim-two-months`, Haiku, repeat 2. The customer says they were charged twice; the records show two separate monthly charges.

- **Expected:** refuse, no duplicate found.
- **Got:** the same decision and the same reason code, labelled `needs_clarification` instead of `refused`.

The reply explained that the charges were for two different months, refunded nothing, and offered to review a refund of the latest charge if the customer wanted one. No money moved wrongly. The agent's action was right and its label for the outcome was arguably defensible; the scenario counts it as a failure because the expected outcome is exact.

Haiku passed the same scenario on the other two repeats.

## The quality gate, tested with a worse prompt

A gate that never fails proves nothing, so it was run twice on a fixed 14-scenario sample: once with the production prompt, once with the refund policy removed from the prompt.

| Prompt         | Pass rate | Gate (floor 90%)    |
| -------------- | --------- | ------------------- |
| Production     | 28 of 28  | Passed              |
| Policy removed | 18 of 28  | Failed, exit code 1 |

Without the policy, the agent did not know the refund window. What it did instead is the interesting part.

| What went wrong                                              | Attempts |
| ------------------------------------------------------------ | -------- |
| Handed to staff instead of refusing an out-of-window request | 2        |
| Handed to staff instead of refunding an in-window request    | 3        |
| Refused a disputed payment itself instead of handing it over | 2        |
| Right outcome, wrong reason code                             | 2        |
| Reply did not contain a required word                        | 1        |

- **It never refunded when it should not have.** In all ten failures the agent did less than the policy allows, not more. Unsure of the rule, it passed the ticket to a person.
- **That is one prompt and one model.** It is an observation about this run, not a guarantee.
- **One failure is the scorer's, not the agent's.** The reply listed three invoice numbers and asked which one the customer meant. The check looks for the word "invoice", and "INV-000164" does not contain it.

## Replay in pull requests

The first Sonnet repeat is saved as a fixture: all 83 model responses, with provider-specific blocks removed. A test replays it against all 32 scenarios without calling a model.

- **It is free and gives the same result every time,** so it runs on every pull request.
- **It checks the code around the model.** With the responses fixed, each scenario must end as it did when recorded.
- **It detects a stale recording.** Changing the prompt or a tool description changes the requests, the replay finds no recorded answer, and the test fails until the real eval is run again.

## Limits

- **The suite is saturated.** A 100% pass rate cannot rank models or show progress. The scenarios cover the policy's rules and boundaries, but the tickets are clear and honest. Harder cases are needed: vague or contradictory tickets, several requests in one, and customers who lie.
- **No adversarial input.** Nothing in these tickets tries to instruct the agent. One scenario uses pressure and a false claim of a promise, and both models held, but that is not prompt injection. An adversarial suite is the next milestone.
- **Three repeats is a small sample.** It shows that Sonnet's results were stable on this day, and that Haiku's were not perfectly so. It does not give a tight estimate of a failure rate. One failure in 96 is consistent with a true rate anywhere from well under 1% to several percent.
- **Reply checks are literal.** They look for an amount and an invoice number. They do not judge tone or whether the explanation is correct, and they produced one false failure above.
- **One effort level, one day.** Both models ran at medium effort. Low effort would be cheaper and has not been measured.
- **Prices are list prices from a table in the repo,** with two assumptions noted there. The costs are estimates from token counts, not invoices.

## Reproduce

```sh
pnpm evals --model claude-sonnet-5-5 --effort medium --repeats 3 \
  --max-spend 3 --out docs/eval-report/data/sonnet-5-5.json
pnpm evals:report
```

This needs Docker and an Anthropic API key, and spends money up to `--max-spend`.

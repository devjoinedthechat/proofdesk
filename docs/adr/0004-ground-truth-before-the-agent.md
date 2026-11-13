# 4. Ground truth before the agent

Status: accepted, 2026-11-13

## Context

An agent's output varies between runs, so "it looked right" is not evidence. Evals need an answer key that does not depend on a model's opinion.

## Decision

Build the simulated company and its scenarios first, and validate them without a model.

- **Scenarios state their answer as data.** Each one lists the refunds that must exist afterwards, whether approval must be requested, and facts the reply must contain or must not reveal.
- **Runs are judged on final state.** The runner snapshots every table before and after. A run passes only if the expected refunds were added and nothing else changed.
- **An oracle proves the scenarios.** A scripted solver applies the written policy through the same service clients the agent will use. It must reach the expected result on every scenario.
- **Careless solvers must fail.** A solver that always refunds and one that always refuses each fail every scenario.

## Why

- **Objective.** A state comparison cannot be argued with and costs nothing to run.
- **Catches silent harm.** An agent that answers correctly but changes an unrelated record fails.
- **Separates two kinds of bug.** If the oracle fails, the scenario or policy is wrong. If only the agent fails, the agent is wrong.
- **Billing stays honest.** Billing enforces payment invariants but not company policy, so a policy violation is possible and the scenario is what detects it.

## Cost

- The oracle needs each ticket's meaning as structured data, which is written by hand per scenario. The agent never receives it.
- Reply quality beyond hard facts still needs a model judge.
- Hand-written expected results limit the suite to dozens of scenarios, not thousands.

## When this breaks

Open-ended tasks with no single correct end state cannot be scored this way. Refunds, plan changes and deletions all have one.

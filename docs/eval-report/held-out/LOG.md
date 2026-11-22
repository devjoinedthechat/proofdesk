# Held-out runs

Every run of the held-out suite, written by `pnpm evals --suite held-out --final`. The scenarios are in [held-out.ts](../../../packages/simulator/src/scenarios/held-out.ts): written on 22 November 2026, after prompt `2026-11-22.1` was final, and never used while changing a prompt.

A line here means the suite's answer has been seen. A prompt changed after that, and measured on the held-out suite again, is no longer measured on unseen tickets, which is why the runs are counted.

| Date       | Model               | Prompt       | Route       | Passed   | Results                                   |
| ---------- | ------------------- | ------------ | ----------- | -------- | ----------------------------------------- |
| 2026-11-22 | `claude-sonnet-5-5` | 2026-11-22.1 | claude-code | 48 of 48 | docs/eval-report/held-out/sonnet-5-5.json |
| 2026-11-22 | `claude-haiku-5-5`  | 2026-11-22.1 | claude-code | 45 of 48 | docs/eval-report/held-out/haiku-5-5.json  |

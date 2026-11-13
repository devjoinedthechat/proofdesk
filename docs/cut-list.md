# What was left out, and why

Things a system like this would have that this one does not. Each is a decision or a known gap, not an oversight.

## Left out on purpose

| Not built                         | Why                                                                                                                                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| More than one agent               | Every property here can be shown with one. More agents would add surface without adding a proof.                                                                                         |
| An agent framework                | The loop is a few hundred lines, and the controls around it are the point ([ADR 1](adr/0001-own-agent-loop.md)).                                                                         |
| A second model provider           | Failover is between Claude models. It covers a model short of capacity and not the provider being down ([ADR 10](adr/0010-one-model-provider.md)).                                       |
| An embedding model                | Search is full-text with queries the agent writes. The vector path is built and switched off ([ADR 10](adr/0010-one-model-provider.md)).                                                 |
| A model that grades replies       | Runs are judged on the final state of the databases. Tone and the quality of an explanation are not scored.                                                                              |
| Prompts and replies in dashboards | Dashboards cannot carry content ([ADR 15](adr/0015-telemetry-without-content.md)). Conversations go to one inspection store instead ([ADR 17](adr/0017-one-store-for-conversations.md)). |
| A cloud deployment                | The system runs on one machine with Docker Compose.                                                                                                                                      |
| Proration on a plan change        | Changes apply from the next renewal, which keeps a third system out of the saga ([ADR 9](adr/0009-plan-change-saga.md)).                                                                 |
| A grace period on deletion        | A request is carried out at once ([ADR 13](adr/0013-deletion-without-a-model.md)).                                                                                                       |

## Known gaps

| Gap                                           | What it means                                                                                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No multi-round eval scenarios                 | A customer can now answer the agent, and the eval suites still test one round. The attacks have not been tried through a reply.                                                                        |
| CI has not run                                | The workflows exist and have never executed. Every result here is from a local run.                                                                                                                    |
| The smoke test uses a scripted model          | `pnpm local:smoke` runs plan changes, replies, hand-overs and deletion through real processes and a real browser, with a stand-in for the model. With a real model the same journeys were run by hand. |
| Only the worker emits telemetry               | The portal, services and MCP servers do not.                                                                                                                                                           |
| Confident wrong answers are not sampled       | Only tickets handed to staff are reviewed. A ticket resolved wrongly never enters the queue.                                                                                                           |
| Captured cases cover refunds                  | A plan-change ticket cannot yet be turned into a case.                                                                                                                                                 |
| Static attacks                                | 24 attacks written once, by hand. No adaptive or automated red-teaming.                                                                                                                                |
| Saturated suites                              | The models pass almost everything. The suites cannot rank models or show progress.                                                                                                                     |
| Fixed thresholds                              | The watchdog's numbers and the daily refund caps were chosen by judgment.                                                                                                                              |
| Development identity settings                 | The local stack uses plain HTTP, password sign-in and an administrator account for user deletion.                                                                                                      |
| No alert channel                              | An alert is a database row, an audit entry and a log line.                                                                                                                                             |
| Backups and provider logs                     | A deletion does not reach either, nor the inspection store's own backups.                                                                                                                              |
| Model versions are names, not dated snapshots | A name can move to a newer model without a deploy.                                                                                                                                                     |

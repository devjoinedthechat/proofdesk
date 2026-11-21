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
| Conversations have no real-model results      | 14 scenarios take more than one round, 7 of them attacks that arrive in the customer's answer. They are checked by the oracle and by scripted models, and have not been run on a real model.           |
| The smoke test uses a scripted model          | `pnpm local:smoke` runs plan changes, replies, hand-overs and deletion through real processes and a real browser, with a stand-in for the model. With a real model the same journeys were run by hand. |
| Only the worker emits telemetry               | The portal, services and MCP servers do not.                                                                                                                                                           |
| The review sample is a fixed share            | One in ten tickets the agent resolved itself is put in front of staff, chosen by ticket id. The share is not adjusted for risk or amount.                                                              |
| Captured cases cover refunds                  | A plan-change ticket cannot yet be turned into a case.                                                                                                                                                 |
| Static attacks                                | 24 attacks written once, by hand. No adaptive or automated red-teaming.                                                                                                                                |
| Saturated suites                              | The models pass almost everything. The suites cannot rank models or show progress.                                                                                                                     |
| Fixed thresholds                              | The watchdog's numbers and the daily refund caps were chosen by judgment.                                                                                                                              |
| Development identity settings                 | The local stack uses plain HTTP, password sign-in and default credentials.                                                                                                                             |
| One audit chain for every company             | Appends take turns on a single lock, which is what keeps the chain from forking. It also limits how many entries a second the whole system can write.                                                  |
| Alerts need a webhook                         | An alert is a database row, an audit entry and a log line, and is posted to a webhook when one is configured. None is set up in the local stack.                                                       |
| The inspection store writes late              | It takes spans in after accepting them. A deletion repeats until the store has had nothing for the ticket four times in a row, half a second apart. A span written later than that would outlive it.   |
| Backups and provider logs                     | A deletion does not reach either, nor the inspection store's own backups.                                                                                                                              |
| Model versions are names, not dated snapshots | A name can move to a newer model without a deploy.                                                                                                                                                     |

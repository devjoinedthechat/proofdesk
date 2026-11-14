# Walkthrough

[`proofdesk-walkthrough.svg`](proofdesk-walkthrough.svg) is the animation at the top of the main README. It shows the system running on one machine, with Claude as the agent.

Nothing in it is staged. A script drives a real browser against the local stack and takes a picture at each moment that matters. The replies are the model's.

| Step | What it shows                                                                          |
| ---- | -------------------------------------------------------------------------------------- |
| 1    | A customer files a request that does not say which charge it is about                  |
| 2    | The agent reads the billing records, finds no matching charge, and asks                |
| 3    | The customer answers, the same conversation carries on, and the duplicate is refunded  |
| 4    | A customer of a second company asks for a $980 refund. It is above the limit and waits |
| 5    | The staff console, where a member of staff approves it                                 |
| 6    | The customer sees the refund                                                           |
| 7    | An operator pauses the agent with the kill switch                                      |

## Make it again

```sh
pnpm local:reset && pnpm local:up     # fresh data, with ANTHROPIC_API_KEY set
node apps/stack/src/walkthrough.ts
```

It needs Google Chrome. A run costs about five cents in model calls and writes the SVG in place.

The file is one SVG with the seven pictures inside it and a CSS animation that fades from one to the next, so it plays wherever an image does. The browser is set to UTC and US English, so the pictures show nothing about the machine they were made on.

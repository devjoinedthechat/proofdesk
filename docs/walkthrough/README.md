# Walkthrough

[`proofdesk-walkthrough.mp4`](proofdesk-walkthrough.mp4) is a two-minute recording of the system running on one machine, with Claude as the agent. Nothing in it is staged: a script drives a real browser against the local stack, and the replies are the model's.

| Time | What happens                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------- |
| 0:00 | A customer signs in at Keycloak and files a request that does not say which charge it is about    |
| 0:15 | The agent reads the billing records, finds no matching charge, and asks instead of guessing       |
| 0:25 | The customer answers, the same conversation carries on, and the duplicate charge is refunded      |
| 0:43 | A customer of a second company asks for a $980 refund. It is above that company's limit and waits |
| 1:04 | A member of staff approves it in the staff console                                                |
| 1:19 | The customer sees the refund                                                                      |
| 1:29 | An operator pauses the agent with the kill switch, and resumes it                                 |
| 1:49 | Temporal: each ticket as a durable workflow                                                       |
| 1:57 | Grafana: what the agent did and what it cost                                                      |

## Record it again

```sh
pnpm local:reset && pnpm local:up     # fresh data, with ANTHROPIC_API_KEY set
node apps/stack/src/walkthrough.ts scenes
ls scenes/*.webm | sed "s/^/file '/; s/$/'/" > scenes/list.txt
ffmpeg -f concat -safe 0 -i scenes/list.txt -c:v libx264 -crf 27 -pix_fmt yuv420p \
  -movflags +faststart -an docs/walkthrough/proofdesk-walkthrough.mp4
```

It needs Google Chrome and ffmpeg, and Playwright's own encoder once: `pnpm --filter @proofdesk/stack exec playwright-core install ffmpeg`. A take costs about five cents in model calls. The browser is set to UTC and US English, so a recording shows nothing about the machine it was made on.

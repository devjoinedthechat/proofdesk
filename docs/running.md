# Running it

How to start the whole system on one machine, use it as its people would, and run the evaluations.

## The whole system, locally

```sh
pnpm local:up      # build one image, provision, start every service
pnpm local:demo    # file a duplicate-charge ticket and print the reply
pnpm local:smoke   # start from nothing and check six journeys and the interface
pnpm local:down    # stop, keeping the data (local:reset deletes it)
```

`local:up` starts Postgres, Keycloak and Temporal, then a provisioning step that creates the databases and their roles, seeds a company dated today, loads the help centre, creates the Keycloak realm and writes the signing key for ticket grants. The portal, both services, the three MCP servers and the worker start once it has finished. Running it again changes nothing.

`local:demo` takes a name. Each one uses the system as its people would, through the portal:

| Demo       | What happens                                                                         |
| ---------- | ------------------------------------------------------------------------------------ |
| `refund`   | A duplicate charge is refunded                                                       |
| `approval` | A $980 refund waits for staff, is approved, and is paid                              |
| `reply`    | The agent asks which charge; the customer answers; the refund follows                |
| `plan`     | A request for more seats changes billing and access together                         |
| `handover` | An operator pauses the agent; the ticket goes to staff; a member of staff answers it |
| `delete`   | A customer asks to be deleted, and can no longer sign in                             |

Five screens are available while the stack runs:

| Screen    | Address                             | What it shows                                                                                  |
| --------- | ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| Proofdesk | `http://localhost:3000`             | The customer page and the staff console                                                        |
| Phoenix   | `http://localhost:6006`             | Every conversation in full: what the model was sent, each tool call and its verdict, the reply |
| Grafana   | `http://localhost:3001/d/proofdesk` | What the agent did, what it cost, what stopped it, and a trace per ticket                      |
| Temporal  | `http://localhost:8233`             | Each ticket's workflow, step by step                                                           |
| Keycloak  | `http://localhost:8080`             | The realm, its clients and users                                                               |

The password for every local account is `local-demo-password`, or `DEMO_PASSWORD` if you set it. Phoenix's account is `admin@localhost`.

| Sign in to Proofdesk as                                  | To                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `maya.okafor@example.org`                                | File a request about a duplicate $87 charge and read the reply         |
| `mateus.rocha@example.org`                               | File one about a $980 duplicate, which needs approval                  |
| `approver@harbor.example`, `approver@tallyfield.example` | Approve refunds, answer tickets the agent handed over, and review them |
| `operator@harbor.example`, `operator@tallyfield.example` | Use the kill switch                                                    |

Sign-in is the authorization code flow with PKCE. The page keeps tokens in memory only, and its content security policy lets it run no script but its own.

With `ANTHROPIC_API_KEY` in the environment or in `.env`, the agent is Claude and a ticket costs about two cents. Without it, or with `SCRIPTED_MODEL=1`, a scripted stand-in handles the demo tickets and nothing is spent. `local:smoke` always uses the stand-in.

## Evaluations on a real model

On the API, with a key:

```sh
echo "ANTHROPIC_API_KEY=..." > .env
pnpm evals --model claude-sonnet-5-5 --effort medium --max-spend 1 --out results.json
```

`--max-spend` is required, in dollars. The command stops starting new attempts once the cap is reached.

`pnpm redteam --target claude-haiku-5-5 --out results.json` runs the adaptive attacker. The held-out suite runs only with `--final`, and every run of it is logged in [held-out/LOG.md](eval-report/held-out/LOG.md).

Without an API key, `--via claude-code` reaches the model through the Claude Code command line, which signs in by itself. Set `CLAUDE_CODE_BIN` if `claude` is not on the path. It is a different route to the model, and its results should not be mixed with the API's.

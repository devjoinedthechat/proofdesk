# Captured cases

Each file here is a ticket the agent handled wrongly in production, with the result a member of staff said was correct. `pnpm evals --suite captured` runs them like any other scenario.

A case is made from a real ticket. `pnpm evals:capture` replaces the customer's name and email address and writes the case with `"textReviewed": false`. A person then reads the subject and body, removes anything else that identifies someone, and sets it to `true`. A case that is not reviewed does not load.

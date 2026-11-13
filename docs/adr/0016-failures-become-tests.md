# 16. A failure in production becomes a test

Status: accepted, 2026-11-13

## Context

The eval suites were written by hand, before the agent met a real ticket. They are nearly saturated: the models pass almost all of them. What the agent actually gets wrong will show up in production, on tickets nobody thought to write.

Those failures are the most valuable test cases there are, and they are usually lost: someone fixes the ticket by hand and moves on.

## Decision

A ticket the agent hands to staff goes into a review queue. A member of staff gives a verdict, and one command turns the reviewed ticket into an eval case that runs with the others.

### The verdict

An approver says whether the agent was right to hand over, and what the correct result was: an outcome, a reason code, and the refunds that should have been made, by payment id and amount.

It is fixed words, identifiers and amounts. There is no free-text note. The verdict is the answer key of a future test, so it has to be exact, and reviewing should not create new text about a customer.

### The case

`pnpm evals:capture --ticket <id>` reads the ticket, the billing records the agent read during its run, and the verdict, and writes a case file:

- **The records, not a pointer to them.** The invoices, payments and refunds the agent saw, with every date turned into an age relative to the ticket. The case can be rebuilt on any day.
- **A new customer.** The case is rebuilt as an ordinary scenario on a generated customer. The original customer's id, the ticket id and the payment ids are not kept. Invoice numbers in the text become placeholders.
- **Judged like every other scenario,** on the final state of the company.

### A real ticket is personal data

The capture replaces the customer's name and email address, and any other email address, in the ticket's text. It cannot know what else a person wrote about themselves.

So a case is written with `textReviewed: false`. A person reads the subject and body, removes what is left, and sets it to true. Until then the case does not load, and a test fails if an unreviewed case, or one holding an email address, is committed.

## What this does not do

- **It captures refund tickets.** A plan-change case would also need the subscription and entitlement the agent saw.
- **Staff can be wrong.** A verdict is one person's judgment. A case that contradicts the written policy should change the policy first, or be dropped.
- **Only handed-over tickets are reviewed.** A ticket the agent resolved wrongly and confidently never enters the queue. Finding those needs sampling of resolved tickets, which is not built.
- **No screen.** The queue and the verdict are HTTP endpoints.

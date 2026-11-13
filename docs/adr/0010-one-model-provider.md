# 10. One model provider

Status: accepted, 2026-11-13

## Context

Two parts of the design assumed a second vendor: failover to another model provider, and an embedding model for help-centre search. Anthropic has no embedding model, so the second needs another account either way.

The system runs on one provider account. This records what that changes and what it does not protect against.

## Decision

- **Failover is between Claude models.** The gateway's backup route is the same provider with another model: Sonnet falls back to Haiku, Haiku to Sonnet.
- **Help-centre search is full-text.** The agent writes the search words. No embedding model is called.
- **The vector path stays in the code and is off.** With no embedder configured, chunks are stored without embeddings and the search runs on words alone.

## Failover

A turn that fails three times as overloaded, rate-limited or timed out is sent to the backup model. The conversation is sent unchanged, including the first model's thinking blocks. The API leaves out thinking the second model cannot read. Removing it in the gateway would lose it for good when the conversation returns to the first model.

A turn answered by a model other than the configured one is written to the audit log.

**What this covers:** one model short of capacity, or one model's rate limit reached.

**What it does not cover:** the provider's API being unreachable, an account-wide rate limit, or a revoked key. Both routes go to the same place. In that case the turn is retried a few times over about a minute, and then the ticket is handed to staff with nothing changed. A ticket is never left open waiting for a model.

The gateway is unchanged by this decision. A route is a provider and a model map, so a second provider is one more route.

## Search

The agent already writes the query: it is the model that calls the search tool. Measured on 28 labelled questions, the customer's own words find the answer for 21. A query written by the model finds it for all 28, on both models. The [retrieval report](../eval-report/retrieval.md) has the numbers and their limits.

The usual case for embeddings is the paraphrase: a question that shares no words with its answer. Here the model closes that gap by adding the words an article would use.

## Cost

- **A smaller model may finish a ticket a larger one started.** The eval suites were run with 40% of Sonnet's turns forced onto Haiku. The [eval report](../eval-report/README.md#failover-between-models) has the result.
- **Search quality depends on the model that writes the query.** A weaker model writes weaker queries.
- **Full-text search matches one language's word stems.** A help centre in several languages, or a customer who writes in another language than the articles, needs embeddings or translation.
- **An exact phrase the model does not think of is not found.** Embeddings fail more softly on this than word matching does.

## When to revisit

- The corpus grows past what word matching ranks well, or becomes multilingual.
- An outage of the one provider costs more than running a second.

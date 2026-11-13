# Retrieval report

Measured 13 November 2026. Raw numbers are in [retrieval.json](retrieval.json) and [queries/](queries).

## What the search is

Help-centre search is full-text search in Postgres, under row-level security. No embedding model is used. The agent writes the search words itself, because it is the one calling the tool. [ADR 10](../adr/0010-one-model-provider.md) has the reasons.

The code also has a vector path: with an embedder configured, the same query ranks by vector similarity too and merges the two rankings. It is tested with a test double and is switched off. Nothing in this report measures how well an embedding model would retrieve.

## Search quality

28 questions with a known answer passage, across two tenants and two audiences. A question counts as answered if the passage holding the answer is among the 4 passages the search tool returns.

Each question was searched two ways:

- **The customer's words.** The question is sent to the search as it was asked.
- **A model-written query.** The model is given the question and the search tool, and writes the query. It may ask for more than one search in a turn.

| Who writes the query   | Answered, of 28 |
| ---------------------- | --------------- |
| The customer's words   | 21              |
| Sonnet 5.5, first turn | 28              |
| Haiku 5.5, first turn  | 28              |

### By how the question is worded

| Wording                                    | Questions | Customer's words | Model-written |
| ------------------------------------------ | --------- | ---------------- | ------------- |
| Uses the passage's own words               | 14        | 14               | 14            |
| Hinges on one exact term, such as "SAML"   | 3         | 2                | 3             |
| Paraphrase that avoids the passage's words | 11        | 5                | 11            |

- **Every miss on the customer's words is a wording gap.** "Where do I send a customer who says they will take us to court?" shares no word with the passage about "legal threats". Sonnet searched for `legal threat lawsuit court sue legal team escalate` and found it first.
- **The models search more than once.** Sonnet asked for 1.9 searches per question in its first turn and Haiku 1.5, usually one for the topic and one for a likely article title.
- **Cost.** $0.10 for Sonnet and $0.005 for Haiku, for all 28 questions twice. In a ticket the query costs nothing extra: it is part of a turn the agent takes anyway.

### What the tool tells the model

The tool's description says the search matches words and not meaning, and asks for search words with likely alternatives. An earlier wording said only "what to look for, in plain words".

| Tool wording | Sonnet, first turn | Haiku, first turn |
| ------------ | ------------------ | ----------------- |
| Earlier      | 28 of 28           | 27 of 28          |
| Current      | 28 of 28           | 28 of 28          |

One question out of 28, on one run, is not a measured difference. The current wording is kept because it is true and costs nothing. This test cannot show that it helps.

## Access rules and the vector index

This part concerns the vector path, which is switched off. It is here because the failure it measures is the first thing to check on the day that path is switched on.

A vector index returns its nearest candidates first and the access rule is applied afterwards. If the caller may see only a small share of the index, most candidates are discarded and the search returns too few results, or none.

The benchmark: 12,000 chunks in one index, with one tenant owning a share of them. For 40 queries, that tenant's true ten nearest chunks are computed exactly and compared with what a search under row-level security returns.

### What Postgres does by itself

| Tenant's share | Plan chosen                     | Found of true top 10 |
| -------------- | ------------------------------- | -------------------- |
| 50%            | Vector index                    | 97.5%                |
| 10%            | Exact sort of the tenant's rows | 100%                 |
| 1%             | Exact sort of the tenant's rows | 100%                 |

When the tenant's share is small, the planner skips the vector index, reads that tenant's rows through an ordinary index, and sorts them exactly. At this size that is both correct and fast.

### What happens when the vector index is used anyway

On a table too large to sort, the planner will use the vector index. Forcing that here shows what is waiting:

| Tenant's share | Plain index scan         | With iterative scan     |
| -------------- | ------------------------ | ----------------------- |
| 50%            | 97.5% found, 10 results  | 97.5% found, 10 results |
| 10%            | 42% found, 4.3 results   | 99% found, 10 results   |
| 1%             | 3.8% found, 0.38 results | 97.5% found, 10 results |

- **Without iterative scan, a small tenant gets almost nothing.** At a 1% share the search returns fewer than one result on average.
- **With it, the index keeps scanning until enough permitted rows are found.** Recall returns to 97.5% or better.

The vector path turns iterative scan on for every query.

## Limits

- **Small corpus, written by the same hand as the questions.** 12 documents and 28 questions. Enough to catch a broken pipeline, not to tune one. A larger corpus has more passages competing for the same words.
- **One run per model.** 28 of 28 on one run does not mean every question is always found.
- **Short, single questions.** In a ticket the question is buried in a longer message, and the agent has to notice it is there.
- **One language.** Full-text search matches English word stems. A question in another language finds nothing unless the model translates its query.
- **The benchmark vectors are synthetic,** clustered around 60 topics to resemble real embeddings. Uniformly random vectors were tried first and discarded: in a thousand dimensions they are all about equally far apart, and every index looks bad on them.
- **No latency numbers.** Nothing here measures speed.

## Reproduce

```sh
node packages/evals/src/retrieval-eval.ts
node --env-file=.env packages/evals/src/query-eval.ts --model claude-sonnet-5-5 \
  --max-spend 0.50 --out docs/eval-report/queries/queries-sonnet-5-5.json
```

The first command calls no model. The second spends about ten cents.

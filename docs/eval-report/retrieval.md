# Retrieval report

Measured 13 November 2026 with `node packages/evals/src/retrieval-eval.ts`. No model is called and nothing is spent. Raw numbers are in [retrieval.json](retrieval.json).

## Read this first

**The embedder is a stand-in.** No embedding API key was available, so vectors come from a deterministic function that only knows which words two texts share. The search-quality numbers below therefore describe hybrid search over word overlap. They are a floor, and they are not what a real embedding model would score.

The second half of this report does not depend on the embedder at all.

## Search quality

28 questions with a known answer passage, across two tenants and two audiences. A question counts as answered at rank k if the passage holding the answer is among the first k results.

| Ranking | Answered at 1 | Answered at 3 | Answered at 5 |
| --- | --- | --- | --- |
| Hybrid (default) | 20 | 23 | 25 |
| Vector only | 19 | 21 | 24 |
| Full-text only | 20 | 20 | 22 |

Hybrid is at least as good as either signal alone at every depth.

### By how the question is worded

| Wording | Questions | Hybrid, answered at 5 |
| --- | --- | --- |
| Uses the passage's own words | 14 | 14 |
| Hinges on one exact term, such as "SAML" | 3 | 3 |
| Paraphrase that avoids the passage's words | 11 | 8 |

**Every miss is a paraphrase.** "Where do I send a customer who says they will take us to court?" does not find the passage about "legal threats", because no word matches. This is the gap a real embedding model exists to close, and the place to look first once one is connected.

## Access rules and the vector index

Permission-aware retrieval has a known failure. A vector index returns its nearest candidates first and the access rule is applied afterwards. If the caller may see only a small share of the index, most candidates are discarded and the search returns too few results, or none.

The benchmark: 12,000 chunks in one index, with one tenant owning a share of them. For 40 queries, that tenant's true ten nearest chunks are computed exactly and compared with what a search under row-level security returns.

### What Postgres does by itself

| Tenant's share | Plan chosen | Found of true top 10 |
| --- | --- | --- |
| 50% | Vector index | 100% |
| 10% | Exact sort of the tenant's rows | 100% |
| 1% | Exact sort of the tenant's rows | 100% |

When the tenant's share is small, the planner skips the vector index, reads that tenant's rows through an ordinary index, and sorts them exactly. At this size that is both correct and fast.

### What happens when the vector index is used anyway

On a table too large to sort, the planner will use the vector index. Forcing that here shows what is waiting:

| Tenant's share | Plain index scan | With iterative scan |
| --- | --- | --- |
| 50% | 100% found, 10 results | 100% found, 10 results |
| 10% | 43% found, 4.3 results | 100% found, 10 results |
| 1% | 3.5% found, 0.35 results | 98% found, 10 results |

- **Without iterative scan, a small tenant gets almost nothing.** At a 1% share the search returns fewer than one result on average.
- **With it, the index keeps scanning until enough permitted rows are found.** Recall returns to 98% or better.

`searchDocuments` turns iterative scan on for every query. The search does not need it at today's size and will not notice the day it does.

## Limits

- **Stand-in embedder,** as above. The quality table needs redoing with a real model.
- **Small corpus.** 12 documents and 28 questions. Enough to catch a broken pipeline, not to tune one.
- **The benchmark vectors are synthetic,** clustered around 60 topics to resemble real embeddings. Uniformly random vectors were tried first and discarded: in a thousand dimensions they are all about equally far apart, and every index looks bad on them.
- **No latency numbers.** Nothing here measures speed.

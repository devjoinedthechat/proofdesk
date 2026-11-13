# 3. Postgres for vectors

Status: accepted, 2026-11-13. Amended by [ADR 10](0010-one-model-provider.md): no embedding model is configured, so search is full-text today and the vector column is empty. The reasons below are why the vector path, when switched on, stays in Postgres.

## Context

The agent retrieves policy documents to decide tickets. Retrieval must respect access rights per tenant and role, and a data-deletion request must remove a person's content from every index.

## Decision

Store embeddings in Postgres with pgvector, next to the document text and its access tags. Search is hybrid, vector similarity plus full-text, in one SQL query under row-level security.

## Why

- **One place for permissions.** Row-level security filters candidates inside the search query. A separate vector store needs its own copy of the access rules, and copies drift.
- **Deletion is one transaction.** Rows and their embeddings go together.
- **Exact terms matter.** Tickets mention invoice numbers and plan names. Full-text search catches what embeddings miss, and both live in the same database.
- **One less system** to run, back up and secure.

## Cost

- **Recall under filtering.** When the access filter removes most candidates, approximate search can return too few results. Iterative index scans address this, and the retrieval evals measure recall under heavy filtering.
- Fewer tuning options than a dedicated vector database.

## When this breaks

pgvector is comfortable into the millions of vectors. Well beyond that, or with many concurrent high-recall searches, a dedicated store is worth its extra access-control work. This corpus is thousands of chunks.

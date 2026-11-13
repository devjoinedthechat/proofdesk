import { createHash } from "node:crypto";
import { type Kysely, sql, type Transaction } from "kysely";
import { chunkMarkdown } from "./chunk.ts";
import { type Embedder, toVectorLiteral } from "./embedder.ts";
import { type Finding, scanDocument } from "./scan.ts";
import type { DocumentsDatabase, Visibility } from "./schema.ts";

export type Audience = "public" | "internal";

/** Limits a transaction to one tenant and one audience, for row-level security. */
export function withDocumentScope<Result>(
  db: Kysely<DocumentsDatabase>,
  scope: { tenantId: string; audience?: Audience },
  fn: (trx: Transaction<DocumentsDatabase>) => Promise<Result>,
): Promise<Result> {
  return db.transaction().execute(async (trx) => {
    await sql`
      select set_config('app.tenant_id', ${scope.tenantId}, true),
             set_config('app.audience', ${scope.audience ?? "public"}, true)
    `.execute(trx);
    return fn(trx);
  });
}

export type IngestInput = {
  tenantId: string;
  visibility: Visibility;
  title: string;
  /** Identifies the document across re-ingestion. */
  sourceUri: string;
  markdown: string;
};

export type IngestResult = {
  documentId: string;
  status: "indexed" | "unchanged" | "quarantined";
  version: number;
  chunks: number;
  findings: Finding[];
};

export type IngestDeps = {
  /** Connection as `documents_ingest`. */
  db: Kysely<DocumentsDatabase>;
  /** Without one, chunks are indexed for full-text search only. */
  embedder?: Embedder;
  clock: () => Date;
  newId: (prefix: string) => string;
  /** Skips the scan. Only for tests that need a poisoned document in the index. */
  unsafeSkipScan?: boolean;
};

/**
 * Takes one document through the pipeline: scan, chunk, embed if an embedder
 * is configured, write.
 *
 * - Unchanged content is skipped, so re-running an import is free.
 * - Changed content replaces the old chunks in one transaction: a search
 *   never sees half of the old version and half of the new.
 * - A document the scan flags is stored without chunks, so it is on record
 *   for review and cannot be retrieved.
 */
export async function ingestDocument(deps: IngestDeps, input: IngestInput): Promise<IngestResult> {
  const contentHash = createHash("sha256")
    .update(`${input.visibility}\n${input.title}\n${input.markdown}`)
    .digest("hex");
  const findings = deps.unsafeSkipScan ? [] : scanDocument(`${input.title}\n${input.markdown}`);
  const status = findings.length > 0 ? ("quarantined" as const) : ("active" as const);

  const existing = await withDocumentScope(deps.db, input, (trx) =>
    trx
      .selectFrom("documents")
      .select(["id", "contentHash", "version", "status"])
      .where("sourceUri", "=", input.sourceUri)
      .executeTakeFirst(),
  );
  if (existing?.contentHash === contentHash && existing.status === status) {
    const { count } = await withDocumentScope(deps.db, input, (trx) =>
      trx
        .selectFrom("chunks")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("documentId", "=", existing.id)
        .executeTakeFirstOrThrow(),
    );
    return {
      documentId: existing.id,
      status: "unchanged",
      version: existing.version,
      chunks: Number(count),
      findings,
    };
  }

  const chunks = status === "active" ? chunkMarkdown(input.title, input.markdown) : [];
  // Embedding happens outside the transaction: it is the slow, fallible step.
  const vectors = await deps.embedder?.embed(
    chunks.map((chunk) => `${chunk.heading}\n\n${chunk.body}`),
    "document",
  );
  const documentId = existing?.id ?? deps.newId("doc");
  const version = (existing?.version ?? 0) + 1;
  const now = deps.clock();

  await withDocumentScope(deps.db, input, async (trx) => {
    if (existing) {
      await trx
        .updateTable("documents")
        .set({
          visibility: input.visibility,
          title: input.title,
          contentHash,
          version,
          status,
          findings: JSON.stringify(findings),
          updatedAt: now,
        })
        .where("id", "=", documentId)
        .execute();
      await trx.deleteFrom("chunks").where("documentId", "=", documentId).execute();
    } else {
      await trx
        .insertInto("documents")
        .values({
          id: documentId,
          tenantId: input.tenantId,
          visibility: input.visibility,
          title: input.title,
          sourceUri: input.sourceUri,
          contentHash,
          version,
          status,
          findings: JSON.stringify(findings),
          createdAt: now,
          updatedAt: now,
        })
        .execute();
    }
    if (chunks.length > 0) {
      await trx
        .insertInto("chunks")
        .values(
          chunks.map((chunk, index) => ({
            id: `${documentId}_v${version}_${chunk.ordinal}`,
            documentId,
            tenantId: input.tenantId,
            visibility: input.visibility,
            ordinal: chunk.ordinal,
            heading: chunk.heading,
            body: chunk.body,
            embedding: vectors ? toVectorLiteral(vectors[index] ?? []) : null,
            embeddingModel: deps.embedder?.model ?? null,
          })),
        )
        .execute();
    }
  });

  return {
    documentId,
    status: status === "active" ? "indexed" : "quarantined",
    version,
    chunks: chunks.length,
    findings,
  };
}

/** Removes a document and, through the foreign key, every chunk and embedding of it. */
export async function deleteDocument(
  db: Kysely<DocumentsDatabase>,
  input: { tenantId: string; sourceUri: string },
): Promise<boolean> {
  const deleted = await withDocumentScope(db, input, (trx) =>
    trx
      .deleteFrom("documents")
      .where("sourceUri", "=", input.sourceUri)
      .returning("id")
      .executeTakeFirst(),
  );
  return deleted !== undefined;
}

export type SearchHit = {
  chunkId: string;
  documentId: string;
  title: string;
  heading: string;
  body: string;
  visibility: Visibility;
  score: number;
};

export type SearchOptions = {
  tenantId: string;
  audience: Audience;
  query: string;
  limit?: number;
  /**
   * Which signals to rank by. The default is full-text when no embedder is
   * configured and hybrid when one is.
   */
  mode?: "hybrid" | "vector" | "fulltext";
  /**
   * Lets the vector index keep scanning when the access filter discards most
   * of what it finds. Off only when measuring what that costs.
   */
  iterativeScan?: boolean;
};

const CANDIDATES = 20;
/** The usual constant for reciprocal rank fusion. */
const RRF_K = 60;

/**
 * Searches the chunks a caller may see. With no embedder this is full-text
 * search. With one, it searches by meaning and by exact words and merges the
 * two rankings.
 *
 * The access rule is not a step before or after this. The query runs as a
 * role under row-level security, in a transaction scoped to one tenant and
 * audience, so a chunk the caller may not see is never a candidate.
 */
export async function searchDocuments(
  deps: { db: Kysely<DocumentsDatabase>; embedder?: Embedder },
  options: SearchOptions,
): Promise<SearchHit[]> {
  const mode = options.mode ?? (deps.embedder ? "hybrid" : "fulltext");
  const limit = Math.min(Math.max(options.limit ?? 5, 1), 10);
  if (mode !== "fulltext" && !deps.embedder) {
    throw new Error(`Search mode "${mode}" needs an embedder, and none is configured`);
  }
  const [vector] =
    mode === "fulltext" ? [[]] : ((await deps.embedder?.embed([options.query], "query")) ?? []);
  const literal = toVectorLiteral(vector ?? []);

  return withDocumentScope(deps.db, options, async (trx) => {
    if (mode !== "fulltext" && options.iterativeScan !== false) {
      await sql`set local hnsw.iterative_scan = relaxed_order`.execute(trx);
    }
    const byVector =
      mode === "fulltext"
        ? sql`select null::text as id, null::bigint as rank where false`
        : sql`
            select id, row_number() over (order by embedding <=> ${literal}::vector) as rank
            from chunks order by embedding <=> ${literal}::vector limit ${CANDIDATES}`;
    // Any of the question's words may match: a question rarely contains only
    // words that all appear in one passage.
    const byText =
      mode === "vector"
        ? sql`select null::text as id, null::bigint as rank where false`
        : sql`
            select c.id, row_number() over (order by ts_rank_cd(c.tsv, q.query) desc, c.id) as rank
            from chunks c,
                 (select to_tsquery('english', nullif(array_to_string(
                    tsvector_to_array(to_tsvector('english', ${options.query})), ' | '), '')) as query) q
            where c.tsv @@ q.query
            order by ts_rank_cd(c.tsv, q.query) desc, c.id limit ${CANDIDATES}`;

    const result = await sql<{
      chunkId: string;
      documentId: string;
      title: string;
      heading: string;
      body: string;
      visibility: Visibility;
      score: number;
    }>`
      with v as (${byVector}), f as (${byText})
      select c.id as "chunkId", c.document_id as "documentId", d.title, c.heading, c.body, c.visibility,
             (coalesce(1.0 / (${RRF_K} + v.rank), 0) + coalesce(1.0 / (${RRF_K} + f.rank), 0))::float8 as score
      from chunks c
      join documents d on d.id = c.document_id
      left join v on v.id = c.id
      left join f on f.id = c.id
      where v.id is not null or f.id is not null
      order by score desc, c.id
      limit ${limit}
    `.execute(trx);
    return result.rows;
  });
}

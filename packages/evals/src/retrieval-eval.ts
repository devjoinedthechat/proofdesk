import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type DocumentsDatabase,
  EMBEDDING_DIMENSIONS,
  searchDocuments,
  toVectorLiteral,
  withDocumentScope,
} from "@proofdesk/documents";
import {
  CATALOG,
  createDocumentsEnv,
  KNOWLEDGE_QUESTIONS,
  prepareTemplates,
} from "@proofdesk/simulator";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { type Kysely, sql } from "kysely";

// Measures retrieval. No model is called and nothing is spent.
//
//   node packages/evals/src/retrieval-eval.ts
//
// Part 1 scores the search as it runs, full-text, on questions with known
// answers, each sent to the search word for word. What a model-written query
// adds is measured separately, by query-eval.ts.
//
// Part 2 is about the vector path, which is built and not switched on. It
// asks what happens to a vector index when access rules hide almost
// everything it finds. It uses synthetic vectors and needs no embedding model.

const OUT = fileURLToPath(new URL("../../../docs/eval-report/retrieval.json", import.meta.url));
const MODES = ["fulltext"] as const;

async function quality(env: Awaited<ReturnType<typeof createDocumentsEnv>>) {
  const sources = new Map(
    (await env.owner.selectFrom("documents").select(["id", "tenantId", "sourceUri"]).execute()).map(
      (row) => [`${row.tenantId}/${row.sourceUri}`, row.id],
    ),
  );
  const rows = [];
  for (const item of KNOWLEDGE_QUESTIONS) {
    const tenantId = CATALOG[item.tenant].tenant.id;
    const ranks: Record<string, number | null> = {};
    for (const mode of MODES) {
      const hits = await searchDocuments(
        { db: env.search },
        { tenantId, audience: item.audience, query: item.question, limit: 10, mode },
      );
      const index = hits.findIndex(
        (hit) =>
          hit.documentId === sources.get(`${tenantId}/${item.sourceUri}`) &&
          `${hit.heading} ${hit.body}`.includes(item.phrase),
      );
      ranks[mode] = index === -1 ? null : index + 1;
    }
    rows.push({ ...item, ranks });
  }
  return rows;
}

function unit(values: number[]): number[] {
  const norm = Math.hypot(...values);
  return values.map((value) => value / norm);
}

/**
 * Vectors that cluster around a set of topics, the way embeddings of real
 * text do. Uniformly random vectors in a thousand dimensions are all about
 * equally far apart, so "nearest" means almost nothing and any index looks
 * bad on them.
 */
function clusteredVectors(random: () => number, topics: number) {
  const centres = Array.from({ length: topics }, () =>
    unit(Array.from({ length: EMBEDDING_DIMENSIONS }, () => random() * 2 - 1)),
  );
  return () => {
    const centre = centres[Math.floor(random() * topics)] ?? [];
    return unit(centre.map((value) => value + (random() * 2 - 1) * 0.04));
  };
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One tenant owns a small share of a large index. For each query the true
 * nearest chunks of that tenant are computed exactly, and compared with what
 * the index returns under row-level security.
 */
async function filtered(env: Awaited<ReturnType<typeof createDocumentsEnv>>, share: number) {
  const random = seeded(7);
  const TOTAL = 12_000;
  const mine = Math.round(TOTAL * share);
  const tenantId = "ten_bench";
  const nextVector = clusteredVectors(random, 60);
  await env.owner.deleteFrom("documents").where("id", "like", "bench_%").execute();

  const vectors: { id: string; tenant: string; vector: number[] }[] = [];
  for (let index = 0; index < TOTAL; index++) {
    vectors.push({
      id: `bench_c${index}`,
      tenant: index < mine ? tenantId : `ten_other_${index % 40}`,
      vector: nextVector(),
    });
  }
  const tenants = [...new Set(vectors.map((item) => item.tenant))];
  await env.owner
    .insertInto("documents")
    .values(
      tenants.map((tenant) => ({
        id: `bench_${tenant}`,
        tenantId: tenant,
        visibility: "public" as const,
        title: "bench",
        sourceUri: "bench",
        contentHash: "bench",
        version: 1,
        status: "active" as const,
        findings: "[]",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      })),
    )
    .execute();
  for (let start = 0; start < vectors.length; start += 500) {
    await env.owner
      .insertInto("chunks")
      .values(
        vectors.slice(start, start + 500).map((item, offset) => ({
          id: item.id,
          documentId: `bench_${item.tenant}`,
          tenantId: item.tenant,
          visibility: "public" as const,
          ordinal: start + offset,
          heading: "bench",
          body: "bench",
          embedding: toVectorLiteral(item.vector),
          embeddingModel: "random",
        })),
      )
      .execute();
  }
  await sql`analyze chunks`.execute(env.owner);

  const own = vectors.filter((item) => item.tenant === tenantId);
  const K = 10;
  const queries = Array.from({ length: 40 }, nextVector);
  const dot = (a: number[], b: number[]) =>
    a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);

  async function run(iterative: boolean, forceIndex: boolean) {
    let found = 0;
    let returned = 0;
    let plan = "";
    for (const query of queries) {
      const truth = new Set(
        [...own]
          .sort((a, b) => dot(b.vector, query) - dot(a.vector, query))
          .slice(0, K)
          .map((item) => item.id),
      );
      const literal = toVectorLiteral(query);
      const ids = await withDocumentScope(
        env.search as Kysely<DocumentsDatabase>,
        { tenantId },
        async (trx) => {
          if (iterative) await sql`set local hnsw.iterative_scan = relaxed_order`.execute(trx);
          if (forceIndex) {
            // Makes the planner use the vector index, as it would by itself on
            // a table too large to sort.
            await sql`set local enable_seqscan = off`.execute(trx);
            await sql`set local enable_bitmapscan = off`.execute(trx);
            await sql`set local enable_sort = off`.execute(trx);
          }
          if (!plan) {
            const explained = await sql<{ "QUERY PLAN": string }>`
            explain select id from chunks order by embedding <=> ${literal}::vector limit ${K}`.execute(
              trx,
            );
            plan = explained.rows.map((row) => row["QUERY PLAN"]).join(" | ");
          }
          const result = await sql<{ id: string }>`
          select id from chunks order by embedding <=> ${literal}::vector limit ${K}`.execute(trx);
          return result.rows.map((row) => row.id);
        },
      );
      returned += ids.length;
      found += ids.filter((id) => truth.has(id)).length;
    }
    return {
      recallAt10: found / (queries.length * K),
      averageReturned: returned / queries.length,
      usesVectorIndex: /hnsw|chunks_embedding_idx/i.test(plan),
    };
  }

  return {
    share,
    totalChunks: TOTAL,
    tenantChunks: mine,
    plannerChoice: {
      plain: await run(false, false),
      iterativeScan: await run(true, false),
    },
    vectorIndexForced: {
      plain: await run(false, true),
      iterativeScan: await run(true, true),
    },
  };
}

const postgres = await new PostgreSqlContainer("pgvector/pgvector:0.8.7-pg17").start();
try {
  await prepareTemplates(postgres.getConnectionUri());
  const env = await createDocumentsEnv(postgres.getConnectionUri());
  try {
    const questions = await quality(env);
    const filteredRecall = [];
    for (const share of [0.5, 0.1, 0.01]) filteredRecall.push(await filtered(env, share));

    const output = {
      measuredAt: new Date().toISOString(),
      questions,
      filteredRecall,
    };
    mkdirSync(fileURLToPath(new URL(".", `file://${OUT}`)), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`);

    for (const mode of MODES) {
      const ranks = questions.map((row) => row.ranks[mode]);
      const at = (k: number) =>
        ranks.filter((rank) => typeof rank === "number" && rank <= k).length;
      console.log(`${mode.padEnd(9)} recall@1 ${at(1)}/${ranks.length}  @3 ${at(3)}  @5 ${at(5)}`);
    }
    for (const row of filteredRecall) console.log(JSON.stringify(row));
  } finally {
    await env.dispose();
  }
} finally {
  await postgres.stop();
}

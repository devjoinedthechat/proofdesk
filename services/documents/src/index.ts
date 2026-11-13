import { fileURLToPath } from "node:url";

export { type Chunk, chunkMarkdown } from "./chunk.ts";
export {
  createHashEmbedder,
  EMBEDDING_DIMENSIONS,
  type Embedder,
  tokenize,
  toVectorLiteral,
} from "./embedder.ts";
export { type Finding, scanDocument } from "./scan.ts";
export type {
  ChunkRow,
  DocumentRow,
  DocumentStatus,
  DocumentsDatabase,
  Visibility,
} from "./schema.ts";
export {
  type Audience,
  deleteDocument,
  type IngestDeps,
  type IngestInput,
  type IngestResult,
  ingestDocument,
  type SearchHit,
  type SearchOptions,
  searchDocuments,
  withDocumentScope,
} from "./store.ts";

export const DOCUMENTS_MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

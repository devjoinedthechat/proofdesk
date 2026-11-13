-- migrate:up
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  -- public: the company's help centre, which customers can read.
  -- internal: staff-only material, never shown to an agent acting for a customer.
  visibility text NOT NULL CHECK (visibility IN ('public', 'internal')),
  title text NOT NULL,
  -- Where the document came from. One document per source per tenant.
  source_uri text NOT NULL,
  content_hash text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  -- A quarantined document was held back by the ingestion scan. It is kept
  -- for review and has no chunks, so it cannot be retrieved.
  status text NOT NULL CHECK (status IN ('active', 'quarantined')),
  findings jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, source_uri)
);

CREATE TABLE chunks (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  -- Tenant and visibility are copied onto every chunk so that the access
  -- rule is checked on the row being ranked, inside the search itself.
  tenant_id text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('public', 'internal')),
  ordinal integer NOT NULL,
  heading text NOT NULL,
  body text NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', heading || ' ' || body)) STORED,
  embedding vector(1024) NOT NULL,
  embedding_model text NOT NULL,
  UNIQUE (document_id, ordinal)
);

CREATE INDEX chunks_tsv_idx ON chunks USING gin (tsv);
CREATE INDEX chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX chunks_tenant_idx ON chunks (tenant_id, visibility);

-- Row-level security. Two transaction-local settings decide what is visible:
-- the tenant, and the audience ('public' or 'internal'). With neither set,
-- nothing matches.
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION doc_visible(row_tenant text, row_visibility text) RETURNS boolean
  LANGUAGE sql STABLE
  RETURN row_tenant = current_setting('app.tenant_id', true)
     AND (row_visibility = 'public' OR current_setting('app.audience', true) = 'internal');

-- documents_app searches. It can read and nothing else.
CREATE POLICY search_documents ON documents FOR SELECT TO documents_app
  USING (status = 'active' AND doc_visible(tenant_id, visibility));
CREATE POLICY search_chunks ON chunks FOR SELECT TO documents_app
  USING (doc_visible(tenant_id, visibility));
GRANT SELECT ON documents, chunks TO documents_app;

-- documents_ingest writes, one tenant at a time.
CREATE POLICY ingest_documents ON documents TO documents_ingest
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY ingest_chunks ON chunks TO documents_ingest
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON documents, chunks TO documents_ingest;

-- migrate:down
DROP TABLE chunks;
DROP TABLE documents;
DROP FUNCTION doc_visible;

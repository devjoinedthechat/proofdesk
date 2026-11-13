-- migrate:up
-- A chunk can be indexed for full-text search with no embedding. That is how
-- the system runs when no embedding model is configured. The vector index
-- skips rows whose embedding is null.
ALTER TABLE chunks ALTER COLUMN embedding DROP NOT NULL;
ALTER TABLE chunks ALTER COLUMN embedding_model DROP NOT NULL;
ALTER TABLE chunks ADD CONSTRAINT chunks_embedding_has_model
  CHECK ((embedding IS NULL) = (embedding_model IS NULL));

-- migrate:down
ALTER TABLE chunks DROP CONSTRAINT chunks_embedding_has_model;
ALTER TABLE chunks ALTER COLUMN embedding SET NOT NULL;
ALTER TABLE chunks ALTER COLUMN embedding_model SET NOT NULL;

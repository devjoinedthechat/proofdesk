-- Runs once, when the data volume is first created.
-- The application database comes from POSTGRES_DB; Keycloak gets its own.
CREATE DATABASE keycloak;

\connect proofdesk
CREATE EXTENSION IF NOT EXISTS vector;

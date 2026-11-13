import { TEST_POSTGRES_URL_ENV } from "@proofdesk/db";
import { prepareTemplates } from "@proofdesk/simulator";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

/** Starts one Postgres for the integration run and builds the template databases in it. */
export default async function setup() {
  const container = await new PostgreSqlContainer("pgvector/pgvector:0.8.7-pg17").start();
  const adminUrl = container.getConnectionUri();
  await prepareTemplates(adminUrl);
  process.env[TEST_POSTGRES_URL_ENV] = adminUrl;

  return async () => {
    await container.stop();
  };
}

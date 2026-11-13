/** Set by the integration test setup to the admin URL of the test Postgres server. */
export const TEST_POSTGRES_URL_ENV = "PROOFDESK_TEST_POSTGRES_URL";

export function testPostgresUrl(): string {
  const url = process.env[TEST_POSTGRES_URL_ENV];
  if (!url) {
    throw new Error(
      `${TEST_POSTGRES_URL_ENV} is not set. Integration tests (*.itest.ts) run through "pnpm test" and need Docker.`,
    );
  }
  return url;
}

/** Password of the service roles on a test or simulation server. Not used anywhere real. */
export const TEST_ROLE_PASSWORD = "simulation-only";

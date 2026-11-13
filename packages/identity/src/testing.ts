/** Set by the integration test setup to the base URL of the test Keycloak server. */
export const TEST_KEYCLOAK_URL_ENV = "PROOFDESK_TEST_KEYCLOAK_URL";

export function testKeycloakUrl(): string {
  const url = process.env[TEST_KEYCLOAK_URL_ENV];
  if (!url) {
    throw new Error(
      `${TEST_KEYCLOAK_URL_ENV} is not set. Integration tests (*.itest.ts) run through "pnpm test" and need Docker.`,
    );
  }
  return url;
}

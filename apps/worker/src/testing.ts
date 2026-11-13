/** Set by the integration test setup to the address of the test Temporal server. */
export const TEST_TEMPORAL_ADDRESS_ENV = "PROOFDESK_TEST_TEMPORAL_ADDRESS";

export function testTemporalAddress(): string {
  const address = process.env[TEST_TEMPORAL_ADDRESS_ENV];
  if (!address) {
    throw new Error(
      `${TEST_TEMPORAL_ADDRESS_ENV} is not set. Integration tests (*.itest.ts) run through "pnpm test" and need Docker.`,
    );
  }
  return address;
}

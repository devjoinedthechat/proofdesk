import { TEST_POSTGRES_URL_ENV } from "@proofdesk/db";
import { TEST_KEYCLOAK_URL_ENV } from "@proofdesk/identity";
import { prepareTemplates } from "@proofdesk/simulator";
import { TEST_TEMPORAL_ADDRESS_ENV } from "@proofdesk/worker";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, Wait } from "testcontainers";

/**
 * Starts one Postgres, one Keycloak and one Temporal dev server for the integration run. Tests isolate
 * themselves inside them: a database copy per test, a realm per test file.
 */
export default async function setup() {
  const [postgres, keycloak, temporal] = await Promise.all([
    // Many tests run at once, each on its own databases with its own pools.
    // The default of 100 connections is not enough for that.
    new PostgreSqlContainer("pgvector/pgvector:0.8.7-pg17")
      .withCommand(["postgres", "-c", "max_connections=400"])
      .start(),
    new GenericContainer("quay.io/keycloak/keycloak:26.8.2")
      .withCommand(["start-dev"])
      .withEnvironment({
        KC_BOOTSTRAP_ADMIN_USERNAME: "admin",
        KC_BOOTSTRAP_ADMIN_PASSWORD: "admin",
      })
      .withExposedPorts(8080)
      .withWaitStrategy(Wait.forHttp("/realms/master", 8080))
      .withStartupTimeout(180_000)
      .start(),
    new GenericContainer("temporalio/temporal:1.10.0")
      .withCommand(["server", "start-dev", "--ip", "0.0.0.0"])
      .withExposedPorts(7233)
      .withWaitStrategy(Wait.forListeningPorts())
      .start(),
  ]);

  // Keycloak demands HTTPS from callers it considers external, which includes
  // the test process reaching it through a mapped port. Turn that off for the
  // master realm from inside the container, where the call counts as local.
  const kcadm = "/opt/keycloak/bin/kcadm.sh";
  const relaxed = await keycloak.exec([
    "bash",
    "-c",
    `${kcadm} config credentials --server http://localhost:8080 --realm master --user admin --password admin && ${kcadm} update realms/master -s sslRequired=NONE`,
  ]);
  if (relaxed.exitCode !== 0)
    throw new Error(`Could not configure test Keycloak: ${relaxed.output}`);

  const adminUrl = postgres.getConnectionUri();
  await prepareTemplates(adminUrl);
  process.env[TEST_POSTGRES_URL_ENV] = adminUrl;
  process.env[TEST_KEYCLOAK_URL_ENV] =
    `http://${keycloak.getHost()}:${keycloak.getMappedPort(8080)}`;

  process.env[TEST_TEMPORAL_ADDRESS_ENV] = `${temporal.getHost()}:${temporal.getMappedPort(7233)}`;

  return async () => {
    await Promise.all([postgres.stop(), keycloak.stop(), temporal.stop()]);
  };
}

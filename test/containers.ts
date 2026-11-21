import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, Wait } from "testcontainers";

/** A server the integration tests run against, and how to stop it. */
export type Started = { url: string; stop(): Promise<unknown> };

export async function startPostgres(): Promise<Started> {
  // Many tests run at once, each on its own databases with its own pools.
  // The default of 100 connections is not enough for that.
  const postgres = await new PostgreSqlContainer("pgvector/pgvector:0.8.7-pg17")
    .withCommand(["postgres", "-c", "max_connections=400"])
    .start();
  return { url: postgres.getConnectionUri(), stop: () => postgres.stop() };
}

export async function startKeycloak(): Promise<Started> {
  const keycloak = await new GenericContainer("quay.io/keycloak/keycloak:26.8.2")
    .withCommand(["start-dev"])
    .withEnvironment({
      KC_BOOTSTRAP_ADMIN_USERNAME: "admin",
      KC_BOOTSTRAP_ADMIN_PASSWORD: "admin",
    })
    .withExposedPorts(8080)
    .withWaitStrategy(Wait.forHttp("/realms/master", 8080))
    .withStartupTimeout(180_000)
    .start();

  // Keycloak demands HTTPS from callers it considers external, which includes
  // the test process reaching it through a mapped port. Turn that off for the
  // master realm from inside the container, where the call counts as local.
  const kcadm = "/opt/keycloak/bin/kcadm.sh";
  const relaxed = await keycloak.exec([
    "bash",
    "-c",
    `${kcadm} config credentials --server http://localhost:8080 --realm master --user admin --password admin && ${kcadm} update realms/master -s sslRequired=NONE`,
  ]);
  if (relaxed.exitCode !== 0) {
    await keycloak.stop();
    throw new Error(`Could not configure test Keycloak: ${relaxed.output}`);
  }
  return {
    url: `http://${keycloak.getHost()}:${keycloak.getMappedPort(8080)}`,
    stop: () => keycloak.stop(),
  };
}

/** Temporal's address is a host and a port, not a URL. */
export async function startTemporal(): Promise<Started> {
  const temporal = await new GenericContainer("temporalio/temporal:1.10.0")
    .withCommand(["server", "start-dev", "--ip", "0.0.0.0"])
    .withExposedPorts(7233)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  return {
    url: `${temporal.getHost()}:${temporal.getMappedPort(7233)}`,
    stop: () => temporal.stop(),
  };
}

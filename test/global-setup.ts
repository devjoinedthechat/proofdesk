import { TEST_POSTGRES_URL_ENV } from "@proofdesk/db";
import { TEST_KEYCLOAK_URL_ENV } from "@proofdesk/identity";
import { prepareTemplates } from "@proofdesk/simulator";
import { TEST_TEMPORAL_ADDRESS_ENV } from "@proofdesk/worker";
import { type Started, startKeycloak, startPostgres, startTemporal } from "./containers.ts";

/**
 * Starts one Postgres, one Keycloak and one Temporal dev server for the integration run. Tests isolate
 * themselves inside them: a database copy per test, a realm per test file.
 *
 * Keycloak and Temporal are reused when a caller has already started them and
 * says where they are. `pnpm prove` runs tests once per removed control, and
 * neither server keeps anything from one run that the next could trip over:
 * realms, task queues and workflow ids are random per file. Postgres is
 * always new, because its templates are built from the migrations, and a
 * removed control can be in a migration.
 */
export default async function setup() {
  const sharedKeycloak = process.env[TEST_KEYCLOAK_URL_ENV];
  const sharedTemporal = process.env[TEST_TEMPORAL_ADDRESS_ENV];
  const shared = (url: string): Started => ({ url, stop: async () => {} });

  const [postgres, keycloak, temporal] = await Promise.all([
    startPostgres(),
    sharedKeycloak ? shared(sharedKeycloak) : startKeycloak(),
    sharedTemporal ? shared(sharedTemporal) : startTemporal(),
  ]);

  await prepareTemplates(postgres.url);
  process.env[TEST_POSTGRES_URL_ENV] = postgres.url;
  process.env[TEST_KEYCLOAK_URL_ENV] = keycloak.url;
  process.env[TEST_TEMPORAL_ADDRESS_ENV] = temporal.url;

  return async () => {
    await Promise.all([postgres.stop(), keycloak.stop(), temporal.stop()]);
  };
}

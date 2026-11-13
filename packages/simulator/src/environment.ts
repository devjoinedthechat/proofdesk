import { randomBytes } from "node:crypto";
import {
  BILLING_MIGRATIONS_DIR,
  type BillingDatabase,
  createBillingApp,
  createBillingClient,
} from "@proofdesk/billing";
import {
  APP_MIGRATIONS_DIR,
  type AppDatabase,
  asRole,
  connect,
  createDatabase,
  DB_ROLES,
  dropDatabase,
  ensureRoles,
  migrate,
  TEST_ROLE_PASSWORD,
} from "@proofdesk/db";
import {
  createEntitlementsApp,
  createEntitlementsClient,
  ENTITLEMENTS_MIGRATIONS_DIR,
  type EntitlementsDatabase,
} from "@proofdesk/entitlements";
import type { Authenticate, Principal } from "@proofdesk/service";
import { generateCompany } from "./generate.ts";
import { type Databases, loadWorld } from "./load.ts";
import { SIM_NOW, type World } from "./world.ts";

/** The seed of the background company every scenario runs on. */
export const BASE_SEED = 20260315;

const PARTS = [
  { key: "app", migrations: APP_MIGRATIONS_DIR },
  { key: "billing", migrations: BILLING_MIGRATIONS_DIR },
  { key: "entitlements", migrations: ENTITLEMENTS_MIGRATIONS_DIR },
] as const;

/** Template databases. `empty` is migrated only; `seeded` also holds the background company. */
export const TEMPLATES = {
  empty: { app: "tpl_app", billing: "tpl_billing", entitlements: "tpl_entitlements" },
  seeded: {
    app: "tpl_seeded_app",
    billing: "tpl_seeded_billing",
    entitlements: "tpl_seeded_entitlements",
  },
} as const;

const SIM_ROLE_PASSWORD = TEST_ROLE_PASSWORD;

let cachedBase: World | undefined;

export function baseWorld(): World {
  cachedBase ??= generateCompany({ seed: BASE_SEED });
  return cachedBase;
}

function open(urls: Record<"app" | "billing" | "entitlements", string>): Databases {
  return {
    app: connect<AppDatabase>(urls.app),
    billing: connect<BillingDatabase>(urls.billing),
    entitlements: connect<EntitlementsDatabase>(urls.entitlements),
  };
}

async function close(dbs: Databases): Promise<void> {
  await Promise.all([dbs.app.destroy(), dbs.billing.destroy(), dbs.entitlements.destroy()]);
}

/**
 * Builds the template databases once per Postgres server. Each simulation then
 * starts from a copy, which takes milliseconds instead of a migrate and reseed.
 */
export async function prepareTemplates(adminUrl: string): Promise<void> {
  await ensureRoles(adminUrl, Object.values(DB_ROLES), SIM_ROLE_PASSWORD);
  const urls = { app: "", billing: "", entitlements: "" };
  for (const part of PARTS) {
    const url = await createDatabase(adminUrl, TEMPLATES.empty[part.key]);
    await migrate(url, part.migrations);
    urls[part.key] = await createDatabase(adminUrl, TEMPLATES.seeded[part.key], {
      template: TEMPLATES.empty[part.key],
    });
  }
  const dbs = open(urls);
  try {
    await loadWorld(baseWorld(), dbs);
  } finally {
    // A template with an open connection cannot be copied.
    await close(dbs);
  }
}

const PRINCIPAL_HEADER = "x-sim-principal";

/**
 * Inside a simulation the caller's identity is simply asserted in a header.
 * This authenticator exists only here; the services have no built-in way to
 * skip authentication.
 */
const simulationAuthenticate: Authenticate = (request) => {
  const header = request.headers.get(PRINCIPAL_HEADER);
  return header ? (JSON.parse(header) as Principal) : null;
};

export type SimEnv = Awaited<ReturnType<typeof createSimEnv>>;

/** An isolated copy of the simulated company, with both services running in-process. */
export async function createSimEnv(
  adminUrl: string,
  options: { seeded?: boolean; now?: Date } = {},
) {
  const now = options.now ?? SIM_NOW;
  const templates = options.seeded === false ? TEMPLATES.empty : TEMPLATES.seeded;
  const suffix = randomBytes(6).toString("hex");
  const names = PARTS.map((part) => ({ key: part.key, name: `sim_${suffix}_${part.key}` }));

  const urls = { app: "", billing: "", entitlements: "" };
  for (const { key, name } of names) {
    urls[key] = await createDatabase(adminUrl, name, { template: templates[key] });
  }
  // `dbs` connects as the owner, for loading history and taking snapshots.
  // The services connect as their own restricted roles, like in production.
  const dbs = open(urls);
  const serviceDbs = {
    billing: connect<BillingDatabase>(asRole(urls.billing, DB_ROLES.billing, SIM_ROLE_PASSWORD)),
    entitlements: connect<EntitlementsDatabase>(
      asRole(urls.entitlements, DB_ROLES.entitlements, SIM_ROLE_PASSWORD),
    ),
  };

  let sequence = 0;
  const clock = () => now;
  const billingApp = createBillingApp({
    db: serviceDbs.billing,
    clock,
    newId: (prefix) => `${prefix}_sim${String(++sequence).padStart(6, "0")}`,
    authenticate: simulationAuthenticate,
  });
  const entitlementsApp = createEntitlementsApp({
    db: serviceDbs.entitlements,
    clock,
    authenticate: simulationAuthenticate,
  });

  return {
    now,
    dbs,
    urls,
    serviceDbs,
    billingApp,
    entitlementsApp,
    /** Service clients that act as the given principal. */
    clientsFor(principal: Principal) {
      const headers = () => ({ [PRINCIPAL_HEADER]: JSON.stringify(principal) });
      return {
        billing: createBillingClient({
          baseUrl: "http://billing.sim",
          fetch: (request) => billingApp.fetch(request),
          headers,
        }),
        entitlements: createEntitlementsClient({
          baseUrl: "http://entitlements.sim",
          fetch: (request) => entitlementsApp.fetch(request),
          headers,
        }),
      };
    },
    async dispose() {
      await Promise.all([serviceDbs.billing.destroy(), serviceDbs.entitlements.destroy()]);
      await close(dbs);
      for (const { name } of names) await dropDatabase(adminUrl, name);
    },
  };
}

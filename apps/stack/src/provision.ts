import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BILLING_MIGRATIONS_DIR, type BillingDatabase } from "@proofdesk/billing";
import {
  APP_MIGRATIONS_DIR,
  type AppDatabase,
  connect,
  DB_ROLES,
  databaseUrl,
  ensureRoles,
  migrate,
} from "@proofdesk/db";
import {
  DOCUMENTS_MIGRATIONS_DIR,
  type DocumentsDatabase,
  ingestDocument,
} from "@proofdesk/documents";
import { ENTITLEMENTS_MIGRATIONS_DIR, type EntitlementsDatabase } from "@proofdesk/entitlements";
import {
  connectKeycloakAdmin,
  type GrantKey,
  generateGrantKey,
  provisionCustomer,
  provisionRealm,
  provisionStaff,
  REALM,
} from "@proofdesk/identity";
import { env } from "@proofdesk/service";
import {
  BASE_SEED,
  CATALOG,
  generateCompany,
  KNOWLEDGE_BASE,
  loadWorld,
  PLAN_CHANGE_SCENARIOS,
  REFUND_SCENARIOS,
  ScenarioBuilder,
  TENANT_SLUGS,
} from "@proofdesk/simulator";
import pg from "pg";

// Takes an empty Postgres and Keycloak to a system ready for its first
// ticket: roles, four databases, their schemas, a seeded company dated today,
// the help centre, the signing key for ticket grants, the Keycloak realm and
// a few accounts to sign in with.
//
// Every step looks before it acts, so running it again changes nothing.

const DATABASES = {
  app: { name: "proofdesk_app", migrations: APP_MIGRATIONS_DIR },
  billing: { name: "proofdesk_billing", migrations: BILLING_MIGRATIONS_DIR },
  entitlements: { name: "proofdesk_entitlements", migrations: ENTITLEMENTS_MIGRATIONS_DIR },
  documents: { name: "proofdesk_documents", migrations: DOCUMENTS_MIGRATIONS_DIR },
} as const;

/** The tickets the demo files. Each scenario adds one customer with the history it needs. */
const DEMOS = {
  refund: { scenario: "refund-duplicate-with-invoice" },
  approval: { scenario: "refund-duplicate-over-limit" },
  // A ticket that does not say which charge, and the answer given when asked.
  reply: {
    scenario: "refund-duplicate-no-invoice",
    subject: "Refund please",
    body: "I think something went wrong with my last payment.",
    answer: "It was charged twice. Please refund the second payment.",
  },
  plan: { scenario: "plan-add-seats" },
  // An account with some history, to be deleted at its owner's request.
  delete: { scenario: "refund-within-window" },
} as const;

export type DemoName = keyof typeof DEMOS;

export type DemoFile = {
  demos: Record<
    DemoName,
    {
      email: string;
      tenantId: string;
      category: "refund" | "plan_change";
      subject: string;
      body: string;
      /** What the customer says when the agent asks a question. */
      answer?: string;
    }
  >;
  staff: Record<string, { approver: string; operator: string }>;
};

const adminUrl = env("POSTGRES_ADMIN_URL");
const stateDir = env("STATE_DIR");
const demoPassword = env("DEMO_PASSWORD");
const log = (message: string) => console.log(`provision: ${message}`);

async function ensureDatabase(name: string): Promise<string> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const found = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    // The name is one of the constants above, never input.
    if (found.rowCount === 0) await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
  return databaseUrl(adminUrl, name);
}

async function databases() {
  await ensureRoles(adminUrl, Object.values(DB_ROLES), env("DB_ROLE_PASSWORD"));
  const urls = {} as Record<keyof typeof DATABASES, string>;
  for (const [key, { name, migrations }] of Object.entries(DATABASES)) {
    const url = await ensureDatabase(name);
    await migrate(url, migrations);
    urls[key as keyof typeof DATABASES] = url;
  }
  log("databases migrated");
  return urls;
}

/** One demo customer, with the history their ticket is about. */
function demoFor(builder: ScenarioBuilder, name: DemoName) {
  const demo: { scenario: string; subject?: string; body?: string; answer?: string } = DEMOS[name];
  const spec = [...REFUND_SCENARIOS, ...PLAN_CHANGE_SCENARIOS].find(
    (candidate) => candidate.id === demo.scenario,
  );
  if (!spec) throw new Error(`No scenario ${demo.scenario}`);
  const built = spec.build(builder);
  return {
    customer: built.customer,
    ticket: {
      category:
        built.ticket.category === "plan_change" ? ("plan_change" as const) : ("refund" as const),
      subject: demo.subject ?? built.ticket.subject,
      body: demo.body ?? built.ticket.body,
      ...(demo.answer ? { answer: demo.answer } : {}),
    },
  };
}

/** The company and the demo customers, dated from now so that refund windows are open. */
function world(now: Date) {
  const base = generateCompany({ seed: BASE_SEED, now });
  // One builder for all of them: invoice numbers run on from the company's,
  // and two demo customers of one company must not be given the same one.
  const builder = new ScenarioBuilder(base, "local-demos", now);
  const demos = {
    refund: demoFor(builder, "refund"),
    approval: demoFor(builder, "approval"),
    reply: demoFor(builder, "reply"),
    plan: demoFor(builder, "plan"),
    delete: demoFor(builder, "delete"),
  };
  return { base, demos, added: builder.added };
}

async function seed(urls: Record<keyof typeof DATABASES, string>) {
  const app = connect<AppDatabase>(urls.app, { maxConnections: 2 });
  const billing = connect<BillingDatabase>(urls.billing, { maxConnections: 2 });
  const entitlements = connect<EntitlementsDatabase>(urls.entitlements, { maxConnections: 2 });
  const documents = connect<DocumentsDatabase>(urls.documents, { maxConnections: 2 });
  const file = join(stateDir, "demo.json");
  try {
    const seeded = await app.selectFrom("tenants").select("id").executeTakeFirst();
    if (seeded) {
      log("company already seeded");
      return null;
    }
    const now = new Date();
    const { base, demos, added } = world(now);
    const dbs = { app, billing, entitlements };
    await loadWorld(base, dbs);
    // The demo customers file their own tickets, so none are loaded for them.
    await loadWorld({ ...added, tickets: [] }, dbs);

    let sequence = 0;
    for (const document of KNOWLEDGE_BASE) {
      await ingestDocument(
        {
          db: documents,
          clock: () => now,
          newId: (prefix) => `${prefix}_kb${String(++sequence).padStart(3, "0")}`,
        },
        { ...document, tenantId: CATALOG[document.tenant].tenant.id },
      );
    }

    const staff = Object.fromEntries(
      TENANT_SLUGS.map((slug) => [
        CATALOG[slug].tenant.id,
        { approver: `approver@${slug}.example`, operator: `operator@${slug}.example` },
      ]),
    );
    const demoFile: DemoFile = {
      demos: Object.fromEntries(
        Object.entries(demos).map(([name, demo]) => [
          name,
          { email: demo.customer.email, tenantId: demo.customer.tenantId, ...demo.ticket },
        ]),
      ) as DemoFile["demos"],
      staff,
    };
    writeFileSync(file, `${JSON.stringify(demoFile, null, 2)}\n`);
    log(`company seeded: ${base.customers.length} customers, ${KNOWLEDGE_BASE.length} documents`);
    return { demos, staff };
  } finally {
    await Promise.all([
      app.destroy(),
      billing.destroy(),
      entitlements.destroy(),
      documents.destroy(),
    ]);
  }
}

async function grantKey(): Promise<{ key: GrantKey; created: boolean }> {
  const file = join(stateDir, "grant-key.json");
  if (existsSync(file)) {
    return { key: JSON.parse(readFileSync(file, "utf8")) as GrantKey, created: false };
  }
  const key = await generateGrantKey();
  writeFileSync(file, JSON.stringify(key), { mode: 0o600 });
  return { key, created: true };
}

async function identity(seeded: Awaited<ReturnType<typeof seed>>) {
  const admin = await connectKeycloakAdmin({
    url: env("KEYCLOAK_URL"),
    username: env("KEYCLOAK_ADMIN_USER"),
    password: env("KEYCLOAK_ADMIN_PASSWORD"),
  });
  const exists = await admin.call("GET", `/realms/${REALM}`).then(
    () => true,
    () => false,
  );
  const { key, created } = await grantKey();
  if (exists) {
    if (created || seeded) {
      throw new Error(
        "The Keycloak realm exists but the rest of the state does not match it. Reset the stack and start again.",
      );
    }
    log("realm already provisioned");
    return;
  }
  if (!seeded) {
    throw new Error(
      "The company is seeded but Keycloak has no realm. Reset the stack and start again.",
    );
  }

  await provisionRealm(admin, {
    grantIssuer: env("GRANT_ISSUER"),
    grantPublicKey: key.publicKeySpki,
    grantKeyId: key.kid,
    secrets: {
      worker: env("WORKER_CLIENT_SECRET"),
      billingMcp: env("BILLING_MCP_CLIENT_SECRET"),
      entitlementsMcp: env("ENTITLEMENTS_MCP_CLIENT_SECRET"),
      accountDeletion: env("ACCOUNT_DELETION_CLIENT_SECRET"),
    },
    // This is a local stack: password sign-in and plain HTTP are for it only.
    devLogin: true,
    insecureHttp: true,
  });
  for (const demo of Object.values(seeded.demos)) {
    await provisionCustomer(admin, { ...demo.customer, password: demoPassword });
  }
  for (const [tenantId, emails] of Object.entries(seeded.staff)) {
    for (const [role, email] of Object.entries(emails)) {
      await provisionStaff(admin, {
        tenantId,
        email,
        name: `Local ${role}`,
        role,
        password: demoPassword,
      });
    }
  }
  log("realm provisioned");
}

mkdirSync(stateDir, { recursive: true });
const seeded = await seed(await databases());
await identity(seeded);
log("ready");

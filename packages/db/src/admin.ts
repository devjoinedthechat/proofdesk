import pg from "pg";

const SAFE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

function quote(name: string): string {
  if (!SAFE_NAME.test(name)) throw new Error(`Unsafe database name: ${name}`);
  return `"${name}"`;
}

async function withAdmin<T>(adminUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Returns `serverUrl` pointed at another database on the same server. */
export function databaseUrl(serverUrl: string, database: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Creates a database, optionally as a copy of a template. Copying a migrated
 * and seeded template is how each test gets its own isolated state quickly.
 * Postgres refuses to copy a template that has open connections.
 */
export async function createDatabase(
  adminUrl: string,
  name: string,
  options: { template?: string } = {},
): Promise<string> {
  const template = options.template ? ` TEMPLATE ${quote(options.template)}` : "";
  await withAdmin(adminUrl, (client) => client.query(`CREATE DATABASE ${quote(name)}${template}`));
  return databaseUrl(adminUrl, name);
}

export async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  await withAdmin(adminUrl, (client) =>
    client.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`),
  );
}

/**
 * Creates the login roles the services connect as. Roles belong to the server,
 * not to one database, so they must exist before any migration grants to them.
 */
export async function ensureRoles(
  adminUrl: string,
  roles: readonly string[],
  password: string,
): Promise<void> {
  await withAdmin(adminUrl, async (client) => {
    for (const role of roles) {
      const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
      if (exists.rowCount === 0) {
        const literal = await client.query("SELECT quote_literal($1) AS value", [password]);
        await client.query(`CREATE ROLE ${quote(role)} LOGIN PASSWORD ${literal.rows[0].value}`);
      }
    }
  });
}

import { fileURLToPath } from "node:url";

export type { Entitlement, SetEntitlementRequest } from "./api.ts";
export { createEntitlementsApp, ENTITLEMENTS_SCOPES, type EntitlementsDeps } from "./app.ts";
export { createEntitlementsClient, type EntitlementsClient } from "./client.ts";
export type { EntitlementRow, EntitlementStatus, EntitlementsDatabase } from "./schema.ts";

export const ENTITLEMENTS_MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

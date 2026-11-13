export type EntitlementStatus = "active" | "suspended";

export type EntitlementRow = {
  tenantId: string;
  customerId: string;
  planCode: string;
  seats: number;
  status: EntitlementStatus;
  version: number;
  updatedAt: Date;
  updatedBy: string;
};

export type EntitlementWriteRow = {
  tenantId: string;
  idempotencyKey: string;
  customerId: string;
  requestFingerprint: string;
  result: unknown;
  createdAt: Date;
};

export type EntitlementsDatabase = {
  entitlements: EntitlementRow;
  entitlementWrites: EntitlementWriteRow;
};

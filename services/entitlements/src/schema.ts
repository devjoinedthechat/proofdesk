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

export type EntitlementsDatabase = {
  entitlements: EntitlementRow;
};

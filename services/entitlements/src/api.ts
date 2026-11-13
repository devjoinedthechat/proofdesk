import { z } from "zod";

export const entitlement = z.object({
  customerId: z.string(),
  planCode: z.string(),
  seats: z.number().int().positive(),
  status: z.enum(["active", "suspended"]),
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
});

export const setEntitlementRequest = z.strictObject({
  planCode: z.string().min(1),
  seats: z.number().int().positive(),
  /**
   * The version the caller read. The write is refused if it has moved on.
   * Optional when the request carries an idempotency key, which protects
   * against repeats in a different way.
   */
  expectedVersion: z.number().int().positive().optional(),
});

export const entitlementResult = z.object({ entitlement });

export type Entitlement = z.infer<typeof entitlement>;
export type SetEntitlementRequest = z.infer<typeof setEntitlementRequest>;

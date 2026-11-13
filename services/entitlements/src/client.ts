import { type ClientOptions, callService } from "@proofdesk/service";
import {
  type Entitlement,
  entitlementErased,
  entitlementResult,
  type SetEntitlementRequest,
} from "./api.ts";

export type EntitlementsClient = ReturnType<typeof createEntitlementsClient>;

export function createEntitlementsClient(options: ClientOptions) {
  const path = (customerId: string) => `/customers/${encodeURIComponent(customerId)}/entitlement`;
  return {
    /** Removes the customer's access. Safe to repeat. */
    async eraseEntitlement(customerId: string) {
      const result = await callService(options, entitlementErased, {
        method: "DELETE",
        path: path(customerId),
      });
      return result.erased;
    },

    async getEntitlement(customerId: string): Promise<Entitlement> {
      const result = await callService(options, entitlementResult, {
        method: "GET",
        path: path(customerId),
      });
      return result.entitlement;
    },

    /** With an idempotency key, safe to retry: the write is applied at most once. */
    async setEntitlement(
      customerId: string,
      request: SetEntitlementRequest,
      idempotencyKey?: string,
    ): Promise<Entitlement> {
      const result = await callService(options, entitlementResult, {
        method: "PUT",
        path: path(customerId),
        body: request,
        ...(idempotencyKey ? { headers: { "idempotency-key": idempotencyKey } } : {}),
      });
      return result.entitlement;
    },
  };
}

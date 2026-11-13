import { type ClientOptions, callService } from "@proofdesk/service";
import { type Entitlement, entitlementResult, type SetEntitlementRequest } from "./api.ts";

export type EntitlementsClient = ReturnType<typeof createEntitlementsClient>;

export function createEntitlementsClient(options: ClientOptions) {
  const path = (customerId: string) => `/customers/${encodeURIComponent(customerId)}/entitlement`;
  return {
    async getEntitlement(customerId: string): Promise<Entitlement> {
      const result = await callService(options, entitlementResult, {
        method: "GET",
        path: path(customerId),
      });
      return result.entitlement;
    },

    async setEntitlement(customerId: string, request: SetEntitlementRequest): Promise<Entitlement> {
      const result = await callService(options, entitlementResult, {
        method: "PUT",
        path: path(customerId),
        body: request,
      });
      return result.entitlement;
    },
  };
}

-- migrate:up
-- Removing a customer's access at their request, with the record of the
-- writes that set it.
GRANT DELETE ON entitlements, entitlement_writes TO entitlements_app;

-- migrate:down
REVOKE DELETE ON entitlements, entitlement_writes FROM entitlements_app;

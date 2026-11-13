-- migrate:up
-- Closing an account at the customer's request. Payment records are kept,
-- because the company must keep them. What ends is what the customer can end:
-- their subscriptions, and the free text they typed onto invoices.
--
-- The service role still cannot cancel a subscription or edit an invoice by
-- itself. It may only call this function, and only for the tenant and
-- customer its transaction is scoped to.
CREATE FUNCTION close_customer_account(p_tenant text, p_customer text, p_at timestamptz)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  n_subscriptions integer;
  n_references integer;
BEGIN
  IF NOT (app_tenant_matches(p_tenant) AND app_customer_matches(p_customer)) THEN
    RAISE EXCEPTION 'The transaction is not scoped to this customer'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE subscriptions SET status = 'canceled', canceled_at = p_at
    WHERE tenant_id = p_tenant AND customer_id = p_customer AND status <> 'canceled';
  GET DIAGNOSTICS n_subscriptions = ROW_COUNT;
  UPDATE invoices SET reference = NULL
    WHERE tenant_id = p_tenant AND customer_id = p_customer AND reference IS NOT NULL;
  GET DIAGNOSTICS n_references = ROW_COUNT;
  RETURN jsonb_build_object(
    'subscriptionsCanceled', n_subscriptions, 'referencesCleared', n_references
  );
END;
$$;

REVOKE ALL ON FUNCTION close_customer_account FROM PUBLIC;
GRANT EXECUTE ON FUNCTION close_customer_account TO billing_app;

-- migrate:down
DROP FUNCTION close_customer_account;

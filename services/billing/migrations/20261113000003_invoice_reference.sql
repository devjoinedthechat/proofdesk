-- migrate:up
-- A free-text reference the customer types at checkout, such as a purchase
-- order number. It is printed on the invoice, so it is text an outsider
-- controls that the agent will read.
ALTER TABLE invoices ADD COLUMN reference text;

-- migrate:down
ALTER TABLE invoices DROP COLUMN reference;

-- Rules the database itself enforces, whatever the application code does.

-- 1. Ledger entries, ledger transactions, shipment events and audit logs are append-only.
CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER shipment_events_append_only BEFORE UPDATE OR DELETE ON shipment_events
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint

-- 2. Every ledger transaction balances (debits = credits per currency), checked at commit.
CREATE OR REPLACE FUNCTION ledger_transaction_balances() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bad record;
BEGIN
  SELECT currency, sum(amount_minor) AS total INTO bad
    FROM ledger_entries WHERE transaction_id = NEW.transaction_id
    GROUP BY currency HAVING sum(amount_minor) <> 0 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ledger transaction % does not balance in % (off by %)', NEW.transaction_id, bad.currency, bad.total;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_balance AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_transaction_balances();
--> statement-breakpoint

-- 3. Money and status sanity.
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_nonzero CHECK (amount_minor <> 0);
--> statement-breakpoint
ALTER TABLE shipments ADD CONSTRAINT shipments_max_positive CHECK (max_price_minor > 0);
--> statement-breakpoint
ALTER TABLE shipments ADD CONSTRAINT shipments_funded_nonnegative CHECK (funded_minor >= 0);
--> statement-breakpoint
ALTER TABLE shipments ADD CONSTRAINT shipments_status_check CHECK (status IN
  ('draft','awaiting_payment','searching','booked','in_transit','delivered','completed','expired','cancelled'));
--> statement-breakpoint
ALTER TABLE offers ADD CONSTRAINT offers_status_check CHECK (status IN
  ('pending_customer','approved','booked','rejected','expired','superseded','withdrawn'));
--> statement-breakpoint
ALTER TABLE payments ADD CONSTRAINT payments_amount_positive CHECK (amount_minor > 0);
--> statement-breakpoint
ALTER TABLE bookings ADD CONSTRAINT bookings_price_adds_up CHECK (net_minor = payout_minor + platform_fee_minor AND total_minor = net_minor + vat_minor);
--> statement-breakpoint
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK (role IN ('owner','admin','dispatcher','finance','member','driver'));
--> statement-breakpoint
ALTER TABLE organisations ADD CONSTRAINT organisations_kind_check CHECK (kind IN ('shipper','carrier','customs_provider','platform'));

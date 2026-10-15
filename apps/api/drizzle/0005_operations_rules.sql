-- What drivers record on the road is evidence: it can be added to, never changed or deleted.
CREATE TRIGGER trip_events_append_only BEFORE UPDATE OR DELETE ON trip_events
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
ALTER TABLE shipments DROP CONSTRAINT shipments_status_check;
--> statement-breakpoint
ALTER TABLE shipments ADD CONSTRAINT shipments_status_check CHECK (status IN
  ('draft','awaiting_payment','searching','booked','in_transit','delivered','completed','expired','cancelled','disputed'));
--> statement-breakpoint
ALTER TABLE carrier_obligations ADD CONSTRAINT carrier_obligations_status_check CHECK (status IN
  ('committed','payable','paid','cancelled','disputed','on_hold'));
--> statement-breakpoint
ALTER TABLE payouts ADD CONSTRAINT payouts_status_check CHECK (status IN ('pending','paid','failed'));

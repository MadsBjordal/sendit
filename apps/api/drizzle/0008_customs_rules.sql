ALTER TABLE carrier_obligations ADD CONSTRAINT carrier_obligations_one_source CHECK (
  (kind = 'carrier' AND booking_id IS NOT NULL AND customs_job_id IS NULL) OR
  (kind = 'customs' AND customs_job_id IS NOT NULL AND booking_id IS NULL));
--> statement-breakpoint
ALTER TABLE customs_procedures ADD CONSTRAINT customs_procedures_status_check CHECK (status IN
  ('NOT_REQUIRED','INFORMATION_MISSING','DOCUMENTS_PENDING','BROKER_ASSIGNED','DECLARATION_PREPARING','DECLARATION_SUBMITTED',
   'DECLARATION_ACCEPTED','BORDER_ACTION_REQUIRED','BORDER_HOLD','RELEASED','PROCEDURE_COMPLETED'));
--> statement-breakpoint
ALTER TABLE customs_jobs ADD CONSTRAINT customs_jobs_status_check CHECK (status IN
  ('awaiting_payment','open','assigned','completed','cancelled','expired'));
--> statement-breakpoint
ALTER TABLE customs_jobs ADD CONSTRAINT customs_jobs_budget_positive CHECK (budget_minor > 0);

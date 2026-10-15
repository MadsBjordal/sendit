CREATE TABLE "customs_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"version" integer NOT NULL,
	"file_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reference" text,
	"valid_until" date,
	"note" text,
	"uploaded_by" uuid NOT NULL,
	"uploaded_by_org_id" uuid,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customs_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"procedure_ids" uuid[] NOT NULL,
	"service" text NOT NULL,
	"country" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"budget_minor" bigint NOT NULL,
	"funded_minor" bigint DEFAULT 0 NOT NULL,
	"listed_fee_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"provider_org_id" uuid,
	"price_minor" bigint,
	"provider_fee_minor" bigint,
	"platform_fee_minor" bigint,
	"notes" text,
	"assigned_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customs_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"role" text NOT NULL,
	"org_id" uuid,
	"name" text NOT NULL,
	"email" text,
	"eori" text,
	"ack_token_hash" text,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_name" text,
	"assigned_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customs_procedures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"territory" text,
	"country" text,
	"certainty" text NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"status_reason" text,
	"arrangement" text,
	"reference" text,
	"reference_type" text,
	"handled_by_org_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customs_provider_profiles" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"countries" text[] DEFAULT '{}'::text[] NOT NULL,
	"services" text[] DEFAULT '{}'::text[] NOT NULL,
	"prices" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"working_hours" text,
	"daily_capacity" integer DEFAULT 20 NOT NULL,
	"contact_phone" text,
	"contact_email" text,
	"active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customs_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"provider_org_id" uuid NOT NULL,
	"fee_minor" bigint NOT NULL,
	"total_minor" bigint NOT NULL,
	"note" text,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "carrier_obligations" ALTER COLUMN "booking_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "carrier_obligations" ADD COLUMN "kind" text DEFAULT 'carrier' NOT NULL;--> statement-breakpoint
ALTER TABLE "carrier_obligations" ADD COLUMN "customs_job_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "customs_job_id" uuid;--> statement-breakpoint
ALTER TABLE "customs_documents" ADD CONSTRAINT "customs_documents_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customs_jobs" ADD CONSTRAINT "customs_jobs_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customs_jobs" ADD CONSTRAINT "customs_jobs_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customs_parties" ADD CONSTRAINT "customs_parties_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customs_procedures" ADD CONSTRAINT "customs_procedures_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customs_provider_profiles" ADD CONSTRAINT "customs_provider_profiles_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customs_quotes" ADD CONSTRAINT "customs_quotes_job_id_customs_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."customs_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customs_quotes" ADD CONSTRAINT "customs_quotes_provider_org_id_organisations_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customs_documents_version_key" ON "customs_documents" USING btree ("shipment_id","doc_type","version");--> statement-breakpoint
CREATE INDEX "customs_jobs_status_idx" ON "customs_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "customs_jobs_shipment_idx" ON "customs_jobs" USING btree ("shipment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customs_parties_role_key" ON "customs_parties" USING btree ("shipment_id","role");--> statement-breakpoint
CREATE INDEX "customs_procedures_shipment_idx" ON "customs_procedures" USING btree ("shipment_id");--> statement-breakpoint
ALTER TABLE "carrier_obligations" ADD CONSTRAINT "carrier_obligations_customs_job_id_unique" UNIQUE("customs_job_id");
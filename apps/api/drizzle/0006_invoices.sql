CREATE TABLE "invoice_sequences" (
	"series" text NOT NULL,
	"year" integer NOT NULL,
	"last" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"kind" text NOT NULL,
	"org_id" uuid NOT NULL,
	"shipment_id" uuid,
	"ref_type" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"net_minor" bigint NOT NULL,
	"vat_minor" bigint NOT NULL,
	"total_minor" bigint NOT NULL,
	"vat_bp" integer NOT NULL,
	"tax_note" text NOT NULL,
	"lines" jsonb NOT NULL,
	"file_id" uuid,
	"issued_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_sequences_key" ON "invoice_sequences" USING btree ("series","year");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_ref_key" ON "invoices" USING btree ("kind","ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "invoices_org_idx" ON "invoices" USING btree ("org_id","issued_at");
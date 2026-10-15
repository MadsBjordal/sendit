CREATE TABLE "payout_accounts" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"holder_name" text NOT NULL,
	"iban" text NOT NULL,
	"bic" text,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"obligation_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text,
	"status" text NOT NULL,
	"iban_masked" text NOT NULL,
	"failure_reason" text,
	"initiated_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_obligation_id_carrier_obligations_id_fk" FOREIGN KEY ("obligation_id") REFERENCES "public"."carrier_obligations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payouts_org_idx" ON "payouts" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_one_live" ON "payouts" USING btree ("obligation_id") WHERE "payouts"."status" in ('pending', 'paid');
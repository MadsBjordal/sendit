CREATE TABLE "saved_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"label" text NOT NULL,
	"address_line" text NOT NULL,
	"postcode" text NOT NULL,
	"city" text NOT NULL,
	"country" text NOT NULL,
	"lat" real NOT NULL,
	"lng" real NOT NULL,
	"contact_name" text,
	"contact_phone" text,
	"has_forklift" boolean DEFAULT false NOT NULL,
	"has_loading_dock" boolean DEFAULT false NOT NULL,
	"instructions" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notification_prefs" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_addresses" ADD CONSTRAINT "saved_addresses_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_addresses_org_idx" ON "saved_addresses" USING btree ("org_id");
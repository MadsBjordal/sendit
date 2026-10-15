CREATE TABLE "drivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"licence_categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"licence_valid_until" date,
	"cpc_valid_until" date,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"shipment_id" uuid,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"file_name" text,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "message_reads" (
	"shipment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"sender_user_id" uuid NOT NULL,
	"sender_org_id" uuid,
	"sender_role" text NOT NULL,
	"body" text NOT NULL,
	"file_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracking_positions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"shipment_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"lat" real NOT NULL,
	"lng" real NOT NULL,
	"accuracy_m" real,
	"speed_kmh" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trip_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"client_event_id" text NOT NULL,
	"action" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lat" real,
	"lng" real,
	"counted_units" integer,
	"discrepancy" text,
	"damage" boolean DEFAULT false NOT NULL,
	"damage_note" text,
	"recipient_name" text,
	"signature_file_id" uuid,
	"photo_file_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"delay_minutes" integer,
	"note" text,
	"country" text,
	"recorded_by" uuid NOT NULL,
	"recorded_as" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "driver_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "collected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "pod_file_id" uuid;--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking_positions" ADD CONSTRAINT "tracking_positions_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_events" ADD CONSTRAINT "trip_events_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drivers_org_idx" ON "drivers" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drivers_org_email_key" ON "drivers" USING btree ("org_id",lower("email"));--> statement-breakpoint
CREATE INDEX "files_shipment_idx" ON "files" USING btree ("shipment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_reads_key" ON "message_reads" USING btree ("shipment_id","user_id");--> statement-breakpoint
CREATE INDEX "messages_shipment_idx" ON "messages" USING btree ("shipment_id","created_at");--> statement-breakpoint
CREATE INDEX "tracking_positions_shipment_idx" ON "tracking_positions" USING btree ("shipment_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "trip_events_client_key" ON "trip_events" USING btree ("shipment_id","client_event_id");--> statement-breakpoint
CREATE INDEX "trip_events_shipment_idx" ON "trip_events" USING btree ("shipment_id","occurred_at");
CREATE TABLE "follow_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"channel" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appointments" ALTER COLUMN "scheduled_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
UPDATE "properties" SET "availability" = '{"timezone":"Asia/Dubai","weekly":{}}'::jsonb WHERE "availability" IS NULL;--> statement-breakpoint
ALTER TABLE "properties" ALTER COLUMN "availability" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "duration_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "telnyx_call_control_id" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "reference" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "currency" text DEFAULT 'AED' NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "amenities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_call_logs" ADD COLUMN "external_call_id" text;--> statement-breakpoint
UPDATE "properties" SET
	"reference" = 'LEGACY-' || upper(substr("id"::text, 1, 8)),
	"title" = coalesce("location", 'Legacy property'),
	"description" = 'Property imported before structured listing details were added.'
WHERE "reference" IS NULL;--> statement-breakpoint
ALTER TABLE "properties" ALTER COLUMN "reference" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ALTER COLUMN "title" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ALTER COLUMN "description" SET NOT NULL;--> statement-breakpoint
UPDATE "tool_call_logs" SET "external_call_id" = "id"::text WHERE "external_call_id" IS NULL;--> statement-breakpoint
ALTER TABLE "tool_call_logs" ALTER COLUMN "external_call_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_property_slot_active_uidx" ON "appointments" USING btree ("property_id","scheduled_at") WHERE "appointments"."status" in ('proposed', 'confirmed');--> statement-breakpoint
CREATE UNIQUE INDEX "properties_org_reference_uidx" ON "properties" USING btree ("organization_id","reference");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_call_logs_call_external_uidx" ON "tool_call_logs" USING btree ("call_id","external_call_id");

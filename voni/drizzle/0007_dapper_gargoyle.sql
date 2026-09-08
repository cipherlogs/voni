CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "background_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"creator_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"title" text NOT NULL,
	"target_url" text,
	"idempotency_key" text NOT NULL,
	"related_id" text,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error_code" text,
	"error_message" text,
	"stage" text,
	"progress_total" integer,
	"progress_done" integer,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"seen_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "deployment_status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "deployment_error" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "config_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "deployment_lease" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "last_deployed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "background_jobs_org_creator_key_uidx" ON "background_jobs" USING btree ("organization_id","creator_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "background_jobs_creator_status_idx" ON "background_jobs" USING btree ("organization_id","creator_id","status","created_at");--> statement-breakpoint
-- Agents already deployed to AssemblyAI keep serving calls: mark them ready.
-- Everything else starts as a draft awaiting its first deployment job.
UPDATE "agents" SET "deployment_status" = 'ready' WHERE "assemblyai_agent_id" IS NOT NULL;
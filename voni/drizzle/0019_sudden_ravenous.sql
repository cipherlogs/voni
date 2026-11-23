CREATE TYPE "public"."click_producer" AS ENUM('grafana', 'github', 'oneoff');--> statement-breakpoint
CREATE TABLE "email_sources" (
	"producer" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"interval_seconds" integer DEFAULT 60 NOT NULL,
	"window_seconds" integer DEFAULT 43200 NOT NULL,
	"window_start_hour" integer DEFAULT 7 NOT NULL,
	"last_dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "affiliate_clicks" ADD COLUMN "producer" "click_producer" DEFAULT 'grafana' NOT NULL;--> statement-breakpoint
ALTER TABLE "affiliate_clicks" ADD COLUMN "runner_os" text;--> statement-breakpoint
CREATE INDEX "affiliate_clicks_producer_ran_at_idx" ON "affiliate_clicks" USING btree ("producer","ran_at" DESC NULLS LAST);
--> statement-breakpoint
-- The one source this app schedules is seeded disabled: a migration may create
-- the row, but nothing clicks from GitHub until an operator enables it. The
-- conflict clause keeps a re-run from duplicating config a later ticket edited.
INSERT INTO "email_sources" ("producer", "enabled", "interval_seconds", "window_seconds", "window_start_hour")
VALUES ('github', false, 60, 43200, 7)
ON CONFLICT ("producer") DO NOTHING;
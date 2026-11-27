ALTER TABLE "email_sources" ADD COLUMN "segment_seconds" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "email_sources" ADD COLUMN "restart_seconds" integer DEFAULT 60 NOT NULL;
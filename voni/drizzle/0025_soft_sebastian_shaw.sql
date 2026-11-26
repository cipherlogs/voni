CREATE TABLE "tuxler_pool_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"producer" text DEFAULT 'github' NOT NULL,
	"runner_os" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"report" jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tuxler_pool_reports_producer_runner_os_uidx" ON "tuxler_pool_reports" USING btree ("producer","runner_os");
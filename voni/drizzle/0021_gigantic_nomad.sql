-- The console's page-level settings: one row, read by every producer.
--
-- No seed row on purpose. An absent `target_selection` means nobody has ever
-- chosen a rotation mode, which is what keeps an existing Grafana script
-- running — and being reported — in whatever mode it already carries. A seeded
-- default would claim a choice the operator never made.
CREATE TABLE "email_settings" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"target_selection" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TYPE "public"."click_failure_reason" AS ENUM('no-us-exit', 'quota-spent', 'relay-silent', 'not-ready', 'exit-unavailable');--> statement-breakpoint
CREATE TYPE "public"."click_proxy_kind" AS ENUM('pool', 'manual', 'none');--> statement-breakpoint
ALTER TABLE "affiliate_clicks" ADD COLUMN "exit_ip" text;--> statement-breakpoint
ALTER TABLE "affiliate_clicks" ADD COLUMN "exit_country" text;--> statement-breakpoint
ALTER TABLE "affiliate_clicks" ADD COLUMN "exit_asn" text;--> statement-breakpoint
ALTER TABLE "affiliate_clicks" ADD COLUMN "proxy_kind" "click_proxy_kind" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "affiliate_clicks" ADD COLUMN "failure_reason" "click_failure_reason";
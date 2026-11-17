CREATE TABLE "affiliate_clicks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target" text NOT NULL,
	"source" text,
	"final_url" text,
	"status" integer,
	"ms" integer,
	"ran_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "affiliate_clicks_ran_at_idx" ON "affiliate_clicks" USING btree ("ran_at" DESC NULLS LAST);
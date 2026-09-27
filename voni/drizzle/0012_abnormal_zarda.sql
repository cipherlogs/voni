CREATE TABLE "demo_test_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tag" text NOT NULL,
	"language" text NOT NULL,
	"issued_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"matched_from" text,
	"matched_message_id" text,
	"matched_thread_id" text,
	"matched_at" timestamp,
	"linked_tag_id" uuid
);
--> statement-breakpoint
CREATE INDEX "demo_test_tags_expires_idx" ON "demo_test_tags" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "demo_test_tags_matched_from_idx" ON "demo_test_tags" USING btree ("matched_from");
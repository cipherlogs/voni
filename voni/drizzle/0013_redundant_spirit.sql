CREATE TABLE "demo_calls" (
	"call_id" text PRIMARY KEY NOT NULL,
	"tag_id" uuid,
	"language" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"reply_started_at" timestamp,
	"reply_message_id" text,
	"code_attempts" integer DEFAULT 0 NOT NULL,
	"code_verified_at" timestamp
);

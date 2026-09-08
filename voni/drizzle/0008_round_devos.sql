CREATE TABLE "copilot_voice_prefs" (
	"user_id" text PRIMARY KEY NOT NULL,
	"voice_id" text DEFAULT 'ivy' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "copilot_voice_prefs" ADD CONSTRAINT "copilot_voice_prefs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
CREATE TYPE "public"."integration_check_status" AS ENUM('passed', 'failed');--> statement-breakpoint
CREATE TABLE "integration_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service" text NOT NULL,
	"status" "integration_check_status" NOT NULL,
	"latency_ms" integer NOT NULL,
	"error" text,
	"tested_by" text NOT NULL,
	"tested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"timezone" text DEFAULT 'Asia/Dubai' NOT NULL,
	"human_transfer_number" text,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_configuration" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"groq_model" text DEFAULT 'llama-3.3-70b-versatile' NOT NULL,
	"cerebras_model" text DEFAULT 'llama-3.3-70b' NOT NULL,
	"gemini_model" text DEFAULT 'gemini-2.0-flash' NOT NULL,
	"openrouter_model" text DEFAULT 'meta-llama/llama-3.3-70b-instruct:free' NOT NULL,
	"llm_provider_order" jsonb DEFAULT '["groq","cerebras","gemini","openrouter"]'::jsonb NOT NULL,
	"telnyx_connection_id" text,
	"telnyx_caller_number" text,
	"cartesia_voice_id" text,
	"bridge_organization_id" text,
	"bridge_agent_id" uuid,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_credentials" (
	"name" text PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_checks" ADD CONSTRAINT "integration_checks_tested_by_user_id_fk" FOREIGN KEY ("tested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_configuration" ADD CONSTRAINT "platform_configuration_bridge_organization_id_organization_id_fk" FOREIGN KEY ("bridge_organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_configuration" ADD CONSTRAINT "platform_configuration_bridge_agent_id_agents_id_fk" FOREIGN KEY ("bridge_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_configuration" ADD CONSTRAINT "platform_configuration_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_credentials" ADD CONSTRAINT "platform_credentials_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
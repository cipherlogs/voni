CREATE TABLE "demo_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"credential" text NOT NULL,
	"status" text,
	"returning" boolean DEFAULT false NOT NULL,
	"sent" boolean DEFAULT false NOT NULL,
	"ok" boolean NOT NULL,
	"code" text,
	"latency_ms" integer,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "demo_tool_calls" ADD CONSTRAINT "demo_tool_calls_call_id_demo_calls_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."demo_calls"("call_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "demo_tool_calls_call_tool_uidx" ON "demo_tool_calls" USING btree ("call_id","tool_call_id");--> statement-breakpoint
CREATE INDEX "demo_tool_calls_call_idx" ON "demo_tool_calls" USING btree ("call_id");
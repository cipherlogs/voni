-- The proxy card's two columns on the one console settings row.
--
-- `proxy_country` is written as US and read back as a constraint rather than a
-- choice: the client refuses an exit in any other country, so a hand-edited row
-- must not become a value the page passes down. `proxy_pool_target` is nullable
-- on purpose — absent means "never chosen", which reads as the plan's five.
ALTER TABLE "email_settings" ADD COLUMN "proxy_country" text;--> statement-breakpoint
ALTER TABLE "email_settings" ADD COLUMN "proxy_pool_target" integer;
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/auth-schema";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    // Passed explicitly rather than relying on db._.fullSchema inference, so a
    // future change to what src/lib/db/schema.ts re-exports can't silently
    // detach the adapter from its tables.
    schema,
  }),
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
    },
  },
  // Google-only sign-in per plan Section N — no email/password flow.
  emailAndPassword: {
    enabled: false,
  },
  plugins: [
    organization({
      // Auto-create an org for a brand-new user on first sign-in — see
      // src/lib/auth-hooks.ts wiring (database hook) once first customer
      // onboarding is built; left as the default (no auto-org) for now so
      // this file stays a clean starting point until DATABASE_URL exists.
    }),
  ],
});

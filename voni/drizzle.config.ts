import { defineConfig } from "drizzle-kit";

// drizzle-kit only loads `.env` itself, and this project keeps its values in
// `.env.local` (see ENVIRONMENT.md). Node's own loader leaves existing
// environment values alone, so CI/deployed values still win.
try {
  process.loadEnvFile(".env.local");
} catch {
  // Absent in CI and on a fresh clone; the real environment is used there.
}

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});

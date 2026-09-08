import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

// Lazy: avoids throwing at module-import time (e.g. during `next build`
// route analysis, which imports every route module regardless of whether
// it's ever invoked). The error only surfaces when a query actually runs
// without DATABASE_URL set, which is the correct time to fail loudly.
const sql = neon(
  process.env.DATABASE_URL ??
    "postgresql://user:password@host.neon.tech/placeholder",
);

export const db = drizzle(sql, { schema });

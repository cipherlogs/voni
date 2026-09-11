import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The repo has no jsdom/component setup, so the notify() suppression
// contract lives in ui-helpers.test.ts against the real helper. This file
// only pins the wiring: notify() delegates to shouldSuppressJobToast.
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "jobs-provider.tsx"), "utf8");

test("provider notify delegates suppression to shouldSuppressJobToast", () => {
  const notify = source.slice(source.indexOf("const notify = useCallback"));
  assert.ok(notify.includes("shouldSuppressJobToast(job.kind, job.status,"));
  assert.ok(notify.includes('from "@/lib/jobs/ui-helpers"') || source.includes('from "@/lib/jobs/ui-helpers"'));
});

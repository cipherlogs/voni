/**
 * A deploy mid-session leaves every open tab holding Server Action ids the new
 * build no longer has. On /email that surfaced as
 *
 *   Something went wrong
 *   Server Action "6087ff…" was not found on the server.
 *
 * while the operator was saving the click interval — the value was fine, the
 * page was old. These tests pin the real messages Next emits, because the
 * detection runs on strings we do not control.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isStaleServerActionError } from "./server-action-error";

const here = dirname(fileURLToPath(import.meta.url));
const routeError = readFileSync(
  join(here, "..", "components", "route-error.tsx"),
  "utf8",
);

test("both of Next's stale-action wordings are recognised", () => {
  // Client-side copy, including the docs link Next appends.
  assert.equal(
    isStaleServerActionError(
      new Error(
        'Server Action "6087ff7fe40bc2cd9d012957b020e76ae2206f82c8" was not found on the server. Read more: https://nextjs.org/docs/messages/failed-to-find-server-action',
      ),
    ),
    true,
  );
  // Server-side copy.
  assert.equal(
    isStaleServerActionError(
      new Error(
        'Failed to find Server Action "6087ff7fe40bc2cd9d012957b020e76ae2206f82c8". This request might be from an older or newer version of the app.',
      ),
    ),
    true,
  );
  // The bare wording, with no id quoted.
  assert.equal(isStaleServerActionError("Failed to find Server Action"), true);
});

test("ordinary failures are not mistaken for a stale build", () => {
  for (const message of [
    "GitHub refused the burst dispatch (403): needs Actions write access.",
    "Select at least one US load zone.",
    "Too many attempts. Try again in 4 minutes.",
    "This page could not be loaded. Try again.",
    "",
  ]) {
    assert.equal(
      isStaleServerActionError(new Error(message)),
      false,
      `not stale: ${message}`,
    );
  }
  assert.equal(isStaleServerActionError(undefined), false);
  assert.equal(isStaleServerActionError(null), false);
});

test("the boundary offers a reload instead of a doomed retry", () => {
  // Load-bearing: `retry()` re-renders with the same dead action id, so a
  // stale page that shows "Try again" is a page that cannot recover.
  assert.match(routeError, /isStaleServerActionError\(error\)/);
  assert.match(routeError, /window\.location\.reload\(\)/);
  assert.match(routeError, /older version/);
  assert.match(routeError, /Nothing was saved/);
});

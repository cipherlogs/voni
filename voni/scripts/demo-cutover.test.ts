import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseMonthlyProductionRecord } from "../src/lib/demo/verification/release";
import { parseCutoverOptions } from "./lib/cutover-options";

/**
 * The cutover command's contract: one action per invocation, a committed
 * monthly record that parses, and an empty record that is pending-human (exit
 * 3), never a green.
 */

const VONI = resolve(fileURLToPath(import.meta.url), "../..");

test("the cutover command accepts exactly one action", () => {
  assert.equal(parseCutoverOptions(["--streak"]).action, "--streak");
  assert.equal(parseCutoverOptions(["--gate", "--image", "sha256:abc"]).image, "sha256:abc");
  assert.throws(() => parseCutoverOptions([]), /exactly one action/);
  assert.throws(() => parseCutoverOptions(["--streak", "--monthly"]), /exactly one action/);
  assert.throws(() => parseCutoverOptions(["--nope"]), /unknown option/);
  assert.throws(() => parseCutoverOptions(["--streak", "--target", "prod"]), /unknown target/);
});

test("the committed monthly record parses and starts empty", () => {
  const raw = JSON.parse(
    readFileSync(resolve(VONI, "evidence/cutover/monthly-production.json"), "utf8"),
  ) as unknown;
  const record = parseMonthlyProductionRecord(raw);
  assert.equal(record.cron, "0 4 1 * *");
  assert.equal(record.timezone, "UTC");
  assert.deepEqual(record.entries, []);
});

test("the monthly action on the empty record is pending-human and exit 3", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/demo-cutover.mts", "--monthly"],
    { cwd: VONI, encoding: "utf8" },
  );
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stdout, /pending-human/);
  assert.match(result.stdout, /0 4 1 \* \*/);
});

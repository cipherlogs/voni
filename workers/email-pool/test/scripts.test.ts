import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_REGION_HINTS,
  REGION_HINTS,
  readBaseConfig,
  regionHintFor,
  regionHints,
  writeInstanceConfig,
} from "../scripts/wrangler-bin.mjs";

const realHints = process.env.EMAIL_POOL_REGION_HINTS;

afterEach(() => {
  if (realHints === undefined) delete process.env.EMAIL_POOL_REGION_HINTS;
  else process.env.EMAIL_POOL_REGION_HINTS = realHints;
});

test("regionHints defaults to enam,wnam,weur", () => {
  delete process.env.EMAIL_POOL_REGION_HINTS;
  assert.deepEqual(regionHints(), ["enam", "wnam", "weur"]);
  assert.deepEqual(regionHints(), [...DEFAULT_REGION_HINTS]);
});

test("regionHints trims a comma-separated list and ignores blanks", () => {
  process.env.EMAIL_POOL_REGION_HINTS = " weur , apac ,,";
  assert.deepEqual(regionHints(), ["weur", "apac"]);
});

test("regionHints fails by name on an unknown hint", () => {
  process.env.EMAIL_POOL_REGION_HINTS = "enam,north";
  assert.throws(
    () => regionHints(),
    (error: Error) =>
      /EMAIL_POOL_REGION_HINTS has unknown hint\(s\): north/.test(error.message) &&
      error.message.includes(REGION_HINTS.join(", ")),
  );
});

test("regionHintFor cycles the list across instances", () => {
  const hints = ["enam", "wnam", "weur"];
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((index) => regionHintFor(index, hints)),
    ["enam", "wnam", "weur", "enam", "wnam"],
  );
  // a single-hint list pins every instance to it
  assert.equal(regionHintFor(2, ["apac"]), "apac");
});

test("each generated instance config carries a distinct POOL_REGION_HINT", () => {
  const base = readBaseConfig();
  const dir = mkdtempSync(join(tmpdir(), "email-pool-config-"));

  try {
    const hints = ["enam", "wnam", "weur"];
    const vars = hints.map((hint, index) =>
      JSON.parse(
        readFileSync(
          writeInstanceConfig(dir, base, {
            name: `email-pool-0${index + 1}`,
            index,
            vars: { POOL_REGION_HINT: regionHintFor(index, hints) },
          }),
          "utf8",
        ),
      ),
    );

    assert.deepEqual(
      vars.map((config: { vars: Record<string, string> }) => config.vars.POOL_REGION_HINT),
      ["enam", "wnam", "weur"],
    );
    // POOL_INDEX still tracks the instance, and the base vars survive
    assert.deepEqual(
      vars.map((config: { vars: Record<string, string> }) => config.vars.POOL_INDEX),
      ["0", "1", "2"],
    );
    assert.equal(vars[0].vars.POOL_USER_AGENT, base.vars.POOL_USER_AGENT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generated configs spread both DO bindings and both migrations", () => {
  const base = readBaseConfig();
  const dir = mkdtempSync(join(tmpdir(), "email-pool-config-"));

  try {
    const path = writeInstanceConfig(dir, base, {
      name: "email-pool-01",
      index: 0,
      vars: { POOL_REGION_HINT: "enam" },
    });
    const config = JSON.parse(readFileSync(path, "utf8"));

    assert.deepEqual(
      config.durable_objects.bindings.map(
        (binding: { name: string; class_name: string }) => [
          binding.name,
          binding.class_name,
        ],
      ),
      [
        ["POOL_REGION", "RegionProbe"],
        ["POOL_CLICK", "PinnedClick"],
      ],
    );
    assert.deepEqual(
      config.migrations.map((migration: { tag: string }) => migration.tag),
      ["v1", "v2"],
    );
    assert.deepEqual(config.migrations[1].new_sqlite_classes, ["PinnedClick"]);
    assert.equal(config.name, "email-pool-01");
    assert.equal(config.main, base.main);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

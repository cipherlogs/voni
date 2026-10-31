/**
 * Ticket 23's hard line: the Studio is absent from the deployed build.
 *
 * "Local-only" is not a flag checked at runtime; it is a property of where the
 * code lives. Next compiles `src/app` and what it imports. The Studio lives
 * under `scripts/studio`, imports no app code except the shared digest, and no
 * app file imports it, so no route, page or client bundle can contain it.
 *
 * These are static assertions on the graph the bundler walks. The positive
 * controls (the app layout exists and the scanner can see it) make an empty
 * scan impossible; the negative assertions fail if anyone adds a `/studio`
 * route, imports the studio from `src/`, or wires it into the Next config.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { STUDIO_NOT_LOCAL, assertLocalOnly } from "./http";

const HERE = dirname(fileURLToPath(import.meta.url));
const VONI = resolve(HERE, "../..");
const APP = join(VONI, "src/app");
const SRC = join(VONI, "src");

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, out);
    else if (/\.(ts|tsx|mts|cts|js|jsx|mjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}

test("the deployed app has no Studio route or page", async () => {
  const files = await walk(APP);
  assert.ok(
    files.some((file) => file === join(APP, "layout.tsx")),
    "positive control: the scanner sees the app tree; an empty scan cannot pass this test",
  );
  const studioFiles = files.filter((file) => /(^|[/\\])studio([/\\]|\.)/i.test(relative(APP, file)));
  assert.deepEqual(studioFiles, [], "no file under src/app may name a Studio route; the Studio is not a page");

  const contents = await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")] as const));
  const referencing = contents
    .filter(([, text]) => /["'`]\/studio[/"'`]/.test(text) || /from\s+["'][^"']*scripts\/studio/.test(text))
    .map(([file]) => relative(VONI, file));
  assert.deepEqual(referencing, [], "the app may not link to or import the Studio");
});

test("no app source imports the Studio's scripts", async () => {
  const files = await walk(SRC);
  assert.ok(files.length > 50, "positive control: the scanner sees app source");
  const offenders: string[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (/from\s+["'][^"']*scripts\/studio/.test(text) || /import\(\s*["'][^"']*scripts\/studio/.test(text)) {
      offenders.push(relative(VONI, file));
    }
  }
  assert.deepEqual(offenders, [], "scripts/studio is outside the app's module graph; importing it would ship the Studio");
});

test("the Studio entry is a scripts command, not a Next route or build input", async () => {
  const pkg = JSON.parse(await readFile(join(VONI, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const command = pkg.scripts["demo:studio"];
  assert.equal(command, "node --import tsx scripts/studio/server.mts");

  const entry = join(VONI, "scripts/studio/server.mts");
  assert.ok((await stat(entry)).isFile());
  assert.ok(!relative(VONI, entry).startsWith(`src${"/"}`), "the entry lives outside src/app and outside Next's module graph");

  for (const name of [
    "server.mts",
    "http.ts",
    "take-store.ts",
    "dialogues.ts",
    "record.html",
    "rate.ts",
    "rating-store.ts",
    "rate.html",
    "corpus.html",
  ]) {
    const path = join(HERE, name);
    assert.ok((await stat(path)).isFile(), `${name} is a Studio file`);
    assert.ok(relative(VONI, path).startsWith(`scripts${"/"}`), `${name} lives under scripts/, never under src/`);
  }

  const config = await readFile(join(VONI, "next.config.ts"), "utf8");
  assert.doesNotMatch(config, /studio/i, "next.config.ts carries no Studio rewrite, route or alias");
});

test("a production environment is refused by name before the store or a socket exists", () => {
  for (const env of [
    { NODE_ENV: "production" },
    { VONI_STUDIO_TARGET: "production" },
    { STUDIO_TARGET: "production" },
  ]) {
    assert.throws(
      () => assertLocalOnly(env),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as { code?: string }).code, STUDIO_NOT_LOCAL);
        assert.match(error.message, /local-only/);
        assert.match(error.message, /deployed build/);
        return true;
      },
    );
  }
  assert.doesNotThrow(() => assertLocalOnly({ NODE_ENV: "development" }));
});

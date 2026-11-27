/**
 * A timer that settles an awaited promise must never be `unref`'d.
 *
 * This is not style: CI was red for a day because of it. `unref` lets the event
 * loop drain while the caller is still awaiting, and Node reports that as
 * `cancelledByParent` — a count `npm test` hides behind a passing summary on a
 * different Node version. Locally on Node 26 the suite was green; on CI's Node 22
 * it printed `fail 0, cancelled 1` and exited 1, with the log truncated before the
 * test name.
 *
 * The rule the allowlist encodes: a *background* timer may be unref'd (a heartbeat,
 * a reset poll, a voice floor clock — none of them anyone's awaited promise). A
 * timeout that resolves or rejects something a caller waits on must keep the loop
 * alive, so the caller sees its answer instead of a silent hang.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");

/**
 * The `unref` calls that are deliberately background. Each is named by the file it
 * belongs to: allowing the generic `timer` shape anywhere is how the bug would walk
 * back in through a new file.
 */
const ALLOWED: ReadonlyArray<{ file: string; line: string; why: string }> = [
  {
    file: "control.ts",
    line: "(heartbeat as unknown as { unref?: () => void }).unref?.();",
    why: "keepalive beat nobody awaits",
  },
  {
    file: "control.ts",
    line: "(watchdog as unknown as { unref?: () => void }).unref?.();",
    why: "health watchdog nobody awaits",
  },
  {
    file: "fake-relay.ts",
    line: "(timer as unknown as { unref?: () => void }).unref?.();",
    why: "a test fixture's staged fault action",
  },
  {
    file: "pool.ts",
    line: "(timer as unknown as { unref?: () => void }).unref?.();",
    why: "the bucket reset poll",
  },
];

function sources(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) out.push(path);
  }
  return out;
}

test("no awaited timer is unref'd, so a caller always gets its answer", () => {
  const offenders: string[] = [];
  for (const file of [...sources(join(repo, "src", "lib", "tuxler"))]) {
    const text = readFileSync(file, "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      if (!line.includes("unref?.()")) continue;
      const allowed = ALLOWED.some(
        (entry) => line.trim() === entry.line && file.endsWith(entry.file),
      );
      // The `voice` timers are a floor clock and a caption clock: background by
      // design, and they live outside this directory.
      if (!allowed) {
        offenders.push(`${file.replace(repo, "")}:${index + 1} ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a timer that settles an awaited promise must not be unref'd: the event loop can " +
      "drain first, and Node reports the caller as cancelled instead of failing it",
  );
});

test("the two voice timers are the only unrefs outside the tuxler directory", () => {
  const text = readFileSync(join(repo, "src", "lib", "voice", "session.ts"), "utf8");
  const lines = text.split("\n").filter((line) => line.includes("unref?.()"));
  assert.equal(lines.length, 2, "floor and caption clocks, both background");
  for (const line of lines) {
    assert.match(line, /(this\.floorTimer|this\.captionTimer)/, line);
  }
});

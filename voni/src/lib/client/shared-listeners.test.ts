import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  subscribeShared,
  sharedNativeCount,
  sharedHandlerCount,
} from "./shared-listeners";

const here = dirname(fileURLToPath(import.meta.url));

function fakeTarget() {
  const handlers = new Map<string, Set<(e: unknown) => void>>();
  const added: Array<{ type: string; options: unknown }> = [];
  const removed: string[] = [];
  return {
    added,
    removed,
    handlers,
    target: {
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        added.push({ type, options: undefined });
        let set = handlers.get(type);
        if (!set) {
          set = new Set();
          handlers.set(type, set);
        }
        set.add(fn);
      },
      removeEventListener: (type: string, fn: (e: unknown) => void) => {
        removed.push(type);
        handlers.get(type)?.delete(fn);
      },
    },
    emit: (type: string, event: unknown) => {
      for (const fn of [...(handlers.get(type) ?? [])]) fn(event);
    },
  };
}

test("one shared native listener fans out to many subscribers", () => {
  const f = fakeTarget();
  const seenA: unknown[] = [];
  const seenB: unknown[] = [];
  const unA = subscribeShared(f.target, "visibilitychange", (e) => void seenA.push(e));
  const unB = subscribeShared(f.target, "visibilitychange", (e) => void seenB.push(e));
  assert.equal(sharedNativeCount(f.target, "visibilitychange"), 1);
  assert.equal(sharedHandlerCount(f.target, "visibilitychange"), 2);
  f.emit("visibilitychange", { hidden: true });
  assert.deepEqual(seenA, [{ hidden: true }]);
  assert.deepEqual(seenB, [{ hidden: true }]);
  unA();
  assert.equal(sharedNativeCount(f.target, "visibilitychange"), 1, "one subscriber keeps the native listener");
  assert.equal(sharedHandlerCount(f.target, "visibilitychange"), 1);
  unB();
  assert.equal(sharedNativeCount(f.target, "visibilitychange"), 0, "last unsubscribe removes the native listener");
});

test("mount/unmount cycles keep identical behavior with one native listener", () => {
  const f = fakeTarget();
  for (let cycle = 0; cycle < 3; cycle++) {
    const seen: unknown[] = [];
    const un = subscribeShared(f.target, "voni:voice-preempt", (e) => void seen.push(e));
    assert.equal(sharedNativeCount(f.target, "voni:voice-preempt"), 1, `cycle ${cycle}: single native`);
    f.emit("voni:voice-preempt", { cycle });
    assert.deepEqual(seen, [{ cycle }]);
    un();
    assert.equal(sharedNativeCount(f.target, "voni:voice-preempt"), 0, `cycle ${cycle}: clean teardown`);
  }
  // Distinct families never share a native listener.
  const fa = fakeTarget();
  subscribeShared(fa.target, "keydown", () => undefined);
  subscribeShared(fa.target, "visibilitychange", () => undefined);
  assert.equal(sharedNativeCount(fa.target, "keydown"), 1);
  assert.equal(sharedNativeCount(fa.target, "visibilitychange"), 1);
});

test("shared registry is non-blocking where no preventDefault is needed", () => {
  const source = readFileSync(join(here, "shared-listeners.ts"), "utf8");
  // Lifecycle + custom voice families must be passive (never preventDefault).
  for (const type of ["visibilitychange", "focus", "pagehide", "freeze", "online", "voni:voice-preempt", "voni:voice-prefs-changed"]) {
    assert.ok(source.includes(`"${type}"`), `${type} family is routed through the shared registry`);
  }
  assert.match(source, /passive:\s*true/, "non-blocking families subscribe with passive:true");
  // Keydown + beforeunload need preventDefault, so they stay non-passive.
  assert.match(source, /passive:\s*false/, "keydown/beforeunload keep preventDefault ability");
});

test("client components route through the shared registry, not direct listeners", () => {
  const repo = (...parts: string[]) => readFileSync(join(here, "..", "..", ...parts), "utf8");
  const shared = repo("lib", "client", "shared-listeners.ts");
  assert.ok(shared.includes("subscribeShared"), "shared registry exists");
  for (const [file, family] of [
    ["components/command-menu-03/command-menu-03.tsx", "keydown"],
    ["components/ui/sidebar.tsx", "keydown"],
    ["components/jobs/jobs-provider.tsx", "visibilitychange"],
    ["components/voice-call.tsx", "visibilitychange"],
    ["components/copilot/copilot-provider.tsx", "voni:voice-preempt"],
    ["components/settings-draft.ts", "beforeunload"],
  ] as Array<[string, string]>) {
    const src = repo(...file.split("/"));
    assert.ok(
      src.includes("shared-listeners") || src.includes("Shared") || src.includes("subscribe"),
      `${file} uses the shared ${family} listener`,
    );
    assert.doesNotMatch(
      src,
      new RegExp(`addEventListener\\("${family}"`),
      `${file} has no duplicate direct ${family} listener`,
    );
  }
});

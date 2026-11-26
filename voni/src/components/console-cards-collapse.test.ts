/**
 * Every `/email` console card folds, starts folded, and keeps its header facts
 * outside the fold.
 *
 * Source-text guards, like `source-card.test.ts`: the runner cannot render a
 * client component. The fold itself is the Base UI collapsible (a real button
 * with `aria-expanded`/`aria-controls`), the state is remembered per card by
 * `useCardDisclosure`, and the one rule that collapsing must never break —
 * volume and failure stay in the header — is checked by position.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8");

const files = {
  source: read("./source-card.tsx"),
  targets: read("./targets-card.tsx"),
  rotation: read("./rotation-card.tsx"),
  proxy: read("./proxy-card.tsx"),
} as const;

const title = read("./collapsible-card-title.tsx");

test("every console card folds through the house collapsible", () => {
  for (const [name, source] of Object.entries(files)) {
    assert.match(source, /<Collapsible\b/, `${name} has a collapsible root`);
    assert.match(
      source,
      /<CollapsibleContent>/,
      `${name} folds its body, not its whole card`,
    );
    assert.match(
      source,
      /useCardDisclosure\(/,
      `${name} remembers its own fold state`,
    );
    assert.match(
      source,
      /className="group\/card grid gap-\(--card-spacing\)"/,
      `${name} scopes the chevron rotation to its own root`,
    );
  }
});

test("the trigger is a real button and the chevron follows the primitive", () => {
  assert.match(
    title,
    /<CollapsibleTrigger[\s\S]*?data-testid=\{testId\}/,
    "the title is the Base UI trigger, so aria-expanded/aria-controls come from it",
  );
  assert.match(
    title,
    /group-data-\[panel-open\]\/card:rotate-180/,
    "the chevron rotates from the root's open state, not a second boolean",
  );
  assert.match(
    title,
    /focus-visible:ring-2/,
    "the trigger keeps a visible keyboard focus ring",
  );
  assert.doesNotMatch(title, /asChild/, "Base UI composition is render=, not asChild");
});

test("each card is remembered under its own stable key", () => {
  const keys = [
    ["source-card.tsx", "useCardDisclosure(testId)"],
    ["targets-card.tsx", 'useCardDisclosure("email-targets-card")'],
    ["rotation-card.tsx", 'useCardDisclosure("email-rotation-card")'],
    ["proxy-card.tsx", 'useCardDisclosure("email-proxy-card")'],
  ] as const;

  for (const [file, call] of keys) {
    const source = read(`./${file}`);
    assert.ok(source.includes(call), `${file} keys its state on ${call}`);
  }
});

test("a folded card still shows its status, volume and health", () => {
  const folded = (source: string): number => {
    const at = source.indexOf("<CollapsibleContent>");
    assert.ok(at > 0, "the card has a folded body");
    return at;
  };

  const targets = files.targets;
  assert.ok(
    targets.indexOf("email-targets-volume") < folded(targets),
    "the aggregate volume and Pause all stay in the Targets header",
  );
  assert.ok(
    targets.indexOf("active} of {targets.length} active") < folded(targets),
    "the active count stays in the Targets header",
  );

  const rotation = files.rotation;
  assert.ok(
    rotation.indexOf("TARGET_SELECTION_LABELS[mode]") < folded(rotation),
    "the running rotation mode stays in the header",
  );

  const proxy = files.proxy;
  assert.ok(
    proxy.indexOf("email-proxy-status") < folded(proxy),
    "the pool status badge stays in the Tuxler header",
  );
  assert.ok(
    proxy.indexOf("email-proxy-exits") < folded(proxy),
    "the ready-exit count stays in the Tuxler header",
  );
  assert.ok(
    proxy.indexOf("email-proxy-headline") < folded(proxy),
    "a failed pool verdict stays in the Tuxler header",
  );

  const source = files.source;
  for (const fact of [
    "summary.status.label",
    "summary.volume.value",
    "summary.health.label",
  ]) {
    const at = source.indexOf(fact);
    assert.ok(at > 0 && at < folded(source), `${fact} stays in the source header`);
  }
});

test("the exit card names Tuxler in its title and keeps its testid", () => {
  assert.match(files.proxy, /<Card data-testid="email-proxy-card">/);
  assert.match(files.proxy, /Tuxler exits/, "the card title names the provider");
  assert.doesNotMatch(files.proxy, />\s*Proxy exits\s*</, "the old title is gone");
  assert.match(files.proxy, /PROXY_PROVIDER/, "the provider is still stated");
  assert.match(files.proxy, /email-proxy-trigger/);
});

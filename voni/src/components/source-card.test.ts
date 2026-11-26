import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * Source-text guards for the `/email` console shell.
 *
 * The one invariant this ticket exists to protect: a collapsed source card may
 * hide its controls, but never its name, its enabled state, its volume or its
 * worst health. There is no runtime test for a client component in this repo,
 * so the shell's shape is asserted where it is written — the summary facts must
 * sit outside `CollapsibleContent`, because that is the only part that folds.
 *
 * The second guard is the layout dependency: one shared target list above the
 * sources, and one shared click surface that is not inside any one source's
 * card.
 */

const shell = readFileSync(new URL("./source-card.tsx", import.meta.url), "utf8");
const panel = readFileSync(
  new URL("./affiliate-control-panel.tsx", import.meta.url),
  "utf8",
);
const burst = readFileSync(new URL("./burst-card.tsx", import.meta.url), "utf8");
const page = readFileSync(
  new URL("../app/email/page.tsx", import.meta.url),
  "utf8",
);

test("a source card keeps its header facts outside the collapsible body", () => {
  const contentAt = shell.indexOf("<CollapsibleContent>");
  assert.ok(contentAt > 0, "the shell has a collapsible body");

  // Collapsing unmounts what is inside CollapsibleContent and nothing else, so
  // position is the proof: every header fact is rendered before that tag.
  for (const fact of [
    "summary.status.label",
    "summary.volume.value",
    "summary.volume.label",
    "summary.health.label",
  ]) {
    const at = shell.indexOf(fact);
    assert.ok(at > 0, `${fact} is rendered in the header`);
    assert.ok(
      at < contentAt,
      `${fact} is outside the collapsible body, so a collapsed card still shows it`,
    );
  }

  assert.match(
    shell,
    /<CollapsibleCardTitle/,
    "the header carries the toggle",
  );
  assert.match(shell, /\{name\}/, "the header always names the source");
});

test("collapsing is the Base UI collapsible, not a tab strip", () => {
  assert.match(shell, /from "@\/components\/ui\/collapsible"/);
  for (const [file, source] of [
    ["source-card.tsx", shell],
    ["affiliate-control-panel.tsx", panel],
    ["burst-card.tsx", burst],
    ["page.tsx", page],
  ] as const) {
    assert.doesNotMatch(
      source,
      /components\/ui\/tabs/,
      `${file} uses the house collapsible, not the retired tab primitive`,
    );
  }
});

test("both sources render through the one source card shell", () => {
  assert.match(
    panel,
    /<SourceCard[\s\S]*?testId="email-control-source-grafana"/,
    "Grafana is a source card",
  );
  assert.match(
    burst,
    /<SourceCard[\s\S]*?testId="email-burst-card"/,
    "Burst is a source card",
  );
  // The summary is what the folded header states, so it must be derived from
  // the same values the body shows rather than a hard-coded label.
  assert.match(panel, /health: worstHealth\(stats\.byStatus\)/);
  assert.match(panel, /formatCount\(perDay\)/);
  assert.match(burst, /plan\.clicks\.toLocaleString\("en-US"\)/);
});

test("the click table is its own surface, not the Grafana card's footer", () => {
  const surfaceAt = panel.indexOf("export function ClickSurface");
  const panelAt = panel.indexOf("export function AffiliateControlPanel");
  assert.ok(surfaceAt > 0, "ClickSurface is exported for the page to place");
  assert.ok(panelAt > surfaceAt, "the source card follows the shared surface");

  assert.ok(
    panel.slice(surfaceAt).includes("<table"),
    "the shared click surface owns the table",
  );
  assert.ok(
    !panel.slice(panelAt).includes("<table"),
    "the Grafana source card renders no click table of its own",
  );
});

test("the page orders targets, then sources, then the shared click history", () => {
  const order = [
    "<TargetsCard",
    "<AffiliateControlPanel",
    "<BurstCard",
    '<ClickSurface',
  ].map((needle) => page.indexOf(needle));

  for (const [index, at] of order.entries()) {
    assert.ok(at > 0, `${index} is rendered by the page`);
    if (index > 0) {
      assert.ok(
        at > order[index - 1]!,
        "the shared target list comes first, the click history last",
      );
    }
  }

  // Targets are rendered once. A second copy (one per source) is the hierarchy
  // this layout exists to remove.
  assert.equal(page.split("<TargetsCard").length - 1, 1);
});

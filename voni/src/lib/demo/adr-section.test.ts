/**
 * One writer for a decision record's owned section: replace it in place, or
 * append it once. A prose mention of the heading must never be mistaken for
 * the section, because the walk would then leave a stale body and a duplicate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { replaceAdrSection } from "./adr-section";

test("a section is appended when the record does not have one", () => {
  const markdown = "# Title\n\n**Status: accepted.**\n";
  const next = replaceAdrSection(markdown, "## Gate", "## Gate\n\nnew\n");
  assert.equal(next, "# Title\n\n**Status: accepted.**\n\n## Gate\n\nnew\n");
});

test("an existing section is replaced, not stacked", () => {
  const markdown = "# Title\n\n## Gate\n\nold\n\n## Other\n\nkeep\n";
  const next = replaceAdrSection(markdown, "## Gate", "## Gate\n\nnew\n");
  assert.equal(next, "# Title\n\n## Other\n\nkeep\n\n## Gate\n\nnew\n");
  assert.equal(next.match(/## Gate/g)?.length, 1);
});

test("a prose mention of the heading is not the section", () => {
  const markdown = "# Title\n\nsee ## Gate below for the rule.\n\n## Gate\n\nold\n";
  const next = replaceAdrSection(markdown, "## Gate", "## Gate\n\nnew\n");
  assert.match(next, /see ## Gate below for the rule\./);
  assert.equal(next.match(/## Gate\n\nold/), null);
  assert.equal(next.match(/\n## Gate\n/g)?.length, 1);
});

test("an empty document accepts the section alone", () => {
  assert.equal(replaceAdrSection("", "## Gate", "## Gate\n\nnew\n"), "## Gate\n\nnew\n");
});

/**
 * The decision records are the standing record, so the index and the two
 * records it points at are pinned. A demo/cascade ADR missing from the index,
 * an ADR-0011 that stops naming its tenant-only scope, or an ADR-0012 that
 * drops the reason Italian is not offered would make the record say something
 * the product does not do.
 */
const ADR_DIR = new URL("../../../../docs/adr/", import.meta.url);

function readRecord(name: string): string {
  return readFileSync(new URL(name, ADR_DIR), "utf8");
}

test("the ADR index lists the demo-cascade record", () => {
  const index = readRecord("README.md");
  assert.match(
    index,
    /0012-demo-cascade-only\.md/,
    "the index points at the demo-cascade ADR",
  );
});

test("ADR-0011 keeps the tenant path as its only scope", () => {
  const record = readRecord("0011-owned-cascade-with-meta-muse.md");
  assert.match(record, /tenant path only/i, "ADR-0011 says which surface it still governs");
  assert.match(record, /0012-demo-cascade-only\.md/, "and points the demo at ADR-0012");
});

test("ADR-0012 withdraws Italian for its market reason, not a weak locale", () => {
  const record = readRecord("0012-demo-cascade-only.md");
  assert.match(record, /Italian/, "the withdrawn Locale is named");
  assert.match(
    record,
    /Italian[^.]*not a target market|not a target market[^.]*Italian/i,
    "the reason is that Italian is not a target market for the demo",
  );
  assert.match(
    record,
    /remain[^.]*in the code[^.]*unused|stay[^.]*in the code[^.]*unused/i,
    "the renderings stay in the code unused, so nothing shipped is hidden",
  );
});

test("ADR-0012 cites the trace and cost evidence by producer", () => {
  const record = readRecord("0012-demo-cascade-only.md");
  for (const producer of ["EventWriter", "CallEventLog", "cascade.cost.cost_call"]) {
    assert.match(record, new RegExp(producer.replace(".", "\\.")), `cites ${producer}`);
  }
  assert.match(record, /cost\.priced/, "names the priced row");
  assert.match(record, /check:real-legs/, "names the key-gated proof (ticket 22)");
});

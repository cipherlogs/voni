/**
 * One writer for a decision record's owned section: replace it in place, or
 * append it once. A prose mention of the heading must never be mistaken for
 * the section, because the walk would then leave a stale body and a duplicate.
 */
import test from "node:test";
import assert from "node:assert/strict";

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

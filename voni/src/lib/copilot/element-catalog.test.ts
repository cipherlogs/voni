import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCatalog,
  catalogPage,
  classifyControl,
  elementIdentity,
  findByLabel,
  formatCatalogForModel,
  MAX_CATALOG_CONTROLS,
  parseSpokenRef,
  resolveRef,
} from "./element-catalog";

test("refs are stable sequence numbers in harvest order", () => {
  const catalog = buildCatalog(
    [
      { role: "tab", label: "Voice copilot" },
      { role: "button", label: "Save" },
    ],
    { version: 4 },
  );
  assert.equal(catalog.version, 4);
  assert.deepEqual(
    catalog.elements.map((e) => e.ref),
    ["e1", "e2"],
  );
  assert.equal(catalog.truncated, false);
});

test("duplicate labels get ordinals; singles get none", () => {
  const catalog = buildCatalog([
    { role: "button", label: "Delete" },
    { role: "button", label: "Save" },
    { role: "button", label: "Delete" },
  ]);
  assert.equal(catalog.elements[0]?.ordinal?.index, 1);
  assert.equal(catalog.elements[0]?.ordinal?.of, 2);
  assert.equal(catalog.elements[1]?.ordinal, null);
  assert.equal(catalog.elements[2]?.ordinal?.index, 2);
});

test("duplicate detection ignores case and extra whitespace", () => {
  const catalog = buildCatalog([
    { role: "button", label: "  Save " },
    { role: "button", label: "save" },
  ]);
  assert.equal(catalog.elements[0]?.ordinal?.of, 2);
  assert.equal(catalog.elements[1]?.ordinal?.index, 2);
});

test("catalog retains overflow and pages at the response budget", () => {
  const items = Array.from({ length: MAX_CATALOG_CONTROLS + 10 }, (_, i) => ({
    role: "button",
    label: `Action ${i}`,
  }));
  const catalog = buildCatalog(items);
  assert.equal(catalog.elements.length, 70);
  const first = catalogPage(catalog, "s1");
  assert.equal(first.elements.length, MAX_CATALOG_CONTROLS);
  assert.equal(first.total, 70);
  const second = catalogPage(catalog, "s1", { continuation: first.continuation! });
  assert.equal(second.elements.length, 10);
  assert.equal(second.continuation, null);
  assert.equal(new Set([...first.elements, ...second.elements].map((e) => e.ref)).size, 70);
  assert.throws(() => catalogPage(catalog, "s2", { continuation: first.continuation! }), /Stale/);
});

test("classifier: view-state taps run direct, everything else proposes", () => {
  assert.equal(classifyControl("tab"), "direct");
  assert.equal(classifyControl("link"), "direct");
  assert.equal(classifyControl("button", { expanded: false }), "propose");
  assert.equal(classifyControl("button", { expanded: true, effect: "view" }), "direct");
  assert.equal(classifyControl("button"), "propose");
  assert.equal(classifyControl("menuitem"), "propose");
  assert.equal(classifyControl("checkbox"), "propose");
  assert.equal(classifyControl("radio"), "propose");
  assert.equal(classifyControl("switch"), "propose");
  assert.equal(classifyControl("textbox"), "propose");
  assert.equal(classifyControl("select"), "propose");
  // Unknown roles fail closed — propose-first, never direct.
  assert.equal(classifyControl("mystery-role"), "propose");
});

test("resolveRef finds by ref and misses cleanly", () => {
  const catalog = buildCatalog([{ role: "button", label: "Save" }]);
  assert.equal(resolveRef(catalog, "e1")?.label, "Save");
  assert.equal(resolveRef(catalog, "e9"), null);
  assert.equal(resolveRef(catalog, "tap e1"), null);
});

test("spoken ordinals parse from words, digits, and hashes", () => {
  assert.deepEqual(parseSpokenRef("second delete"), { ordinal: 2, label: "delete" });
  assert.deepEqual(parseSpokenRef("2nd delete"), { ordinal: 2, label: "delete" });
  assert.deepEqual(parseSpokenRef("#3 save"), { ordinal: 3, label: "save" });
  assert.deepEqual(parseSpokenRef("3 save"), { ordinal: 3, label: "save" });
  assert.deepEqual(parseSpokenRef("tenth row"), { ordinal: 10, label: "row" });
  assert.deepEqual(parseSpokenRef("save"), { ordinal: null, label: "save" });
  assert.deepEqual(parseSpokenRef("  First   Name "), { ordinal: 1, label: "name" });
});

test("findByLabel: single match found, unknown missing", () => {
  const catalog = buildCatalog([{ role: "button", label: "Save" }]);
  const found = findByLabel(catalog, "save");
  assert.equal(found.status, "found");
  assert.equal(found.status === "found" && found.element.ref, "e1");
  assert.equal(findByLabel(catalog, "delete").status, "missing");
});

test("findByLabel: duplicates need an ordinal, accept one when given", () => {
  const catalog = buildCatalog([
    { role: "button", label: "Delete" },
    { role: "button", label: "Delete" },
    { role: "button", label: "Delete" },
  ]);
  const ambiguous = findByLabel(catalog, "delete");
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(
    ambiguous.status === "ambiguous" ? ambiguous.options.length : -1,
    3,
  );
  const picked = findByLabel(catalog, "second delete");
  assert.equal(picked.status, "found");
  assert.equal(picked.status === "found" && picked.element.ref, "e2");
  // Out-of-range ordinal is missing, not a guess.
  assert.equal(findByLabel(catalog, "fourth delete").status, "missing");
});

test("element identity is stable for target readers", () => {
  const catalog = buildCatalog([
    { role: "button", label: "Delete" },
    { role: "button", label: "Delete" },
  ]);
  assert.equal(elementIdentity(catalog.elements[0]!), "catalog:item-1");
  assert.equal(elementIdentity(catalog.elements[1]!), "catalog:item-2");
});

test("model formatting names the ref, the label, and the cost", () => {
  const catalog = buildCatalog([
    { role: "tab", label: "Voice copilot" },
    { role: "button", label: "Save" },
  ]);
  const text = formatCatalogForModel(catalog);
  assert.match(text, /e1/);
  assert.match(text, /Voice copilot/);
  assert.match(text, /applies at once/);
  assert.match(text, /needs confirmation/);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  harvestCatalog,
  resolveByIdentity,
  resolveTapInput,
  summarizeFill,
  summarizeTap,
  type HarvestSource,
} from "./ui-actuation";

function fakeEl(
  tagName: string,
  attrs: Record<string, string> = {},
  textContent: string | null = null,
  extra: Record<string, unknown> = {},
): HarvestSource {
  return {
    tagName,
    getAttribute: (name: string) => attrs[name] ?? null,
    textContent,
    ...extra,
  } as HarvestSource;
}

function fakeRoot(els: HarvestSource[]) {
  return { querySelectorAll: () => els };
}

test("explicit roles win; tags imply the rest", () => {
  const { catalog } = harvestCatalog(
    fakeRoot([
      fakeEl("DIV", { role: "tab" }, "Voice copilot"),
      fakeEl("BUTTON", {}, "Save"),
      fakeEl("A", { href: "/leads" }, "Leads"),
      fakeEl("INPUT", { type: "checkbox", "aria-label": "Active" }),
      fakeEl("INPUT", { type: "text", placeholder: "Name" }),
      fakeEl("TEXTAREA", { "aria-label": "Notes" }),
      fakeEl("SELECT", { "aria-label": "Service" }),
      fakeEl("INPUT", { type: "radio", "aria-label": "Yes" }),
    ]),
    { version: 9 },
  );
  assert.deepEqual(
    catalog.elements.map((e) => [e.role, e.label]),
    [
      ["tab", "Voice copilot"],
      ["button", "Save"],
      ["link", "Leads"],
      ["checkbox", "Active"],
      ["textbox", "Name"],
      ["textbox", "Notes"],
      ["select", "Service"],
      ["radio", "Yes"],
    ],
  );
  assert.equal(catalog.version, 9);
});

test("accessible-name priority: aria-label beats content beats placeholder", () => {
  const { catalog } = harvestCatalog(
    fakeRoot([
      fakeEl("BUTTON", { "aria-label": "Close dialog" }, "X"),
      fakeEl("INPUT", { type: "text", placeholder: "Search leads" }),
      fakeEl("INPUT", { type: "submit", value: "Send" }),
    ]),
  );
  assert.deepEqual(
    catalog.elements.map((e) => e.label),
    ["Close dialog", "Search leads", "Send"],
  );
});

test("hidden, aria-hidden, and unlabeled controls are skipped", () => {
  const { catalog } = harvestCatalog(
    fakeRoot([
      fakeEl("INPUT", { type: "hidden" }, null),
      fakeEl("BUTTON", { "aria-hidden": "true" }, "Ghost"),
      fakeEl("BUTTON", {}, "   "),
      fakeEl("BUTTON", {}, "Real"),
    ]),
  );
  assert.deepEqual(
    catalog.elements.map((e) => e.label),
    ["Real"],
  );
});

test("expanders resolve their disposition at harvest time", () => {
  const { catalog } = harvestCatalog(
    fakeRoot([
      fakeEl("BUTTON", { "aria-expanded": "false", "data-copilot-effect": "view" }, "More filters"),
      fakeEl("BUTTON", {}, "Delete"),
    ]),
  );
  assert.equal(catalog.elements[0]?.disposition, "direct");
  assert.equal(catalog.elements[1]?.disposition, "propose");
});

test("harvested nodes stay aligned with catalog refs", () => {
  const clicked: string[] = [];
  const { catalog, nodes } = harvestCatalog(
    fakeRoot([
      fakeEl("BUTTON", {}, "First", { click: () => clicked.push("first") }),
      fakeEl("BUTTON", {}, "Second", { click: () => clicked.push("second") }),
    ]),
  );
  assert.equal(nodes.length, catalog.elements.length);
  nodes[1]?.activate();
  assert.deepEqual(clicked, ["second"]);
});

test("identity follows a row on reorder and refuses replacement", () => {
  const first = fakeEl("BUTTON", {}, "Delete");
  const second = fakeEl("BUTTON", {}, "Delete");
  const original = harvestCatalog(fakeRoot([first, second]));
  const identity = original.catalog.elements[1].identity;
  assert.equal(resolveByIdentity(fakeRoot([second, first]), identity)?.source, second);
  assert.equal(resolveByIdentity(fakeRoot([first, fakeEl("BUTTON", {}, "Delete")]), identity), null);
  assert.equal(resolveByIdentity(fakeRoot([first, second]), "button::delete::2"), null);
});

test("resolveTapInput: refs win, labels fall back, dupes disambiguate", () => {
  const { catalog } = harvestCatalog(
    fakeRoot([
      fakeEl("BUTTON", {}, "Delete"),
      fakeEl("BUTTON", {}, "Delete"),
      fakeEl("BUTTON", {}, "Save"),
    ]),
  );
  const byRef = resolveTapInput(catalog, "e3");
  assert.equal(byRef.status, "resolved");
  assert.equal(byRef.status === "resolved" && byRef.element.label, "Save");
  const byLabel = resolveTapInput(catalog, "second delete");
  assert.equal(byLabel.status, "resolved");
  assert.equal(byLabel.status === "resolved" && byLabel.element.ref, "e2");
  const ambiguous = resolveTapInput(catalog, "delete");
  assert.equal(ambiguous.status, "disambiguate");
  assert.match(
    ambiguous.status === "disambiguate" ? ambiguous.prompt : "",
    /Which one\?.*e1.*e2/,
  );
  assert.equal(resolveTapInput(catalog, "e9").status, "stale");
  assert.equal(resolveTapInput(catalog, "launch rockets").status, "stale");
});

test("proposal summaries name the control for the readback", () => {
  const { catalog } = harvestCatalog(fakeRoot([fakeEl("BUTTON", {}, "Delete")]));
  const element = catalog.elements[0]!;
  assert.equal(summarizeTap(element), 'Tap "Delete" (button)');
  assert.equal(summarizeFill(element, "Sara"), 'Set "Delete" to "Sara"');
});

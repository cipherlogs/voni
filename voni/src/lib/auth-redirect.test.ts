import assert from "node:assert/strict";
import test from "node:test";
import { safeNextPath } from "./auth-redirect";

test("safeNextPath preserves local paths, query strings, and fragments", () => {
  assert.equal(safeNextPath("/calls/123?tab=activity#event"), "/calls/123?tab=activity#event");
});

test("safeNextPath rejects protocol-relative, absolute, slash-confused, and control-character paths", () => {
  for (const value of [
    "https://attacker.example",
    "//attacker.example/path",
    "/\\attacker.example",
    "/safe\nunsafe",
    "dashboard",
  ]) {
    assert.equal(safeNextPath(value), "/dashboard");
  }
});

test("safeNextPath uses the caller fallback for absent input", () => {
  assert.equal(safeNextPath(undefined, "/login"), "/login");
});

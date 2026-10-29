import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SENSITIVE_CAPTURE_FLOOR,
  sensitiveCaptureWindows,
  type BodyTurnDetection,
} from "./capture-windows";

/**
 * The phone bridge's test reads this same file. One body in, one window pair
 * out, on both transports — that is the parity proof (ticket 71, ADR 0007).
 */
const FIXTURE = JSON.parse(
  readFileSync(new URL("./capture-window-cases.json", import.meta.url), "utf8"),
) as {
  floor: Record<string, number | boolean>;
  cases: Array<{
    name: string;
    body_turn_detection: BodyTurnDetection;
    capture: Record<string, number | boolean>;
    restore: BodyTurnDetection;
  }>;
};

test("the browser floor is the fixture both transports read", () => {
  assert.deepEqual({ ...SENSITIVE_CAPTURE_FLOOR }, FIXTURE.floor);
});

test("every shared body produces the same sensitive-capture windows", () => {
  for (const item of FIXTURE.cases) {
    assert.deepEqual(
      sensitiveCaptureWindows(item.body_turn_detection),
      item.capture,
      item.name,
    );
  }
});

test("the capture floor is never narrowed by a body setting", () => {
  const narrow = FIXTURE.cases.find(
    (entry) => entry.name === "the latency experiment's narrow windows",
  );
  assert.ok(narrow);
  assert.deepEqual(sensitiveCaptureWindows(narrow.body_turn_detection), FIXTURE.floor);
});

test("an absent body setting is the Turn preset", () => {
  assert.deepEqual(sensitiveCaptureWindows(undefined), FIXTURE.floor);
});

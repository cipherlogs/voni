import test from "node:test";
import assert from "node:assert/strict";
import { REAL_ESTATE_TEMPLATE } from "@/lib/agents/config";
import {
  SENSITIVE_CAPTURE_TOOL,
  compileVoiceTools,
  validateToolArguments,
} from "./definitions";
import { isWithinRecurringAvailability } from "./execute";

test("compiles only selected business tools plus sensitive pacing", () => {
  const tools = compileVoiceTools({
    ...REAL_ESTATE_TEMPLATE,
    tools: ["search_properties", "book_viewing", "invented_tool"],
    detect: [
      { key: "phone", label: "Phone", description: "", sensitive: true },
      { key: "location", label: "Location", description: "", sensitive: false },
    ],
  });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["search_properties", "book_viewing", SENSITIVE_CAPTURE_TOOL],
  );
  assert.equal(tools.at(-1)?.execution_mode, "hold");
  assert.deepEqual(
    (tools.at(-1)?.parameters.properties as Record<string, { enum: string[] }>)[
      "field_key"
    ].enum,
    ["phone"],
  );
});

test("does not register pacing without a sensitive field", () => {
  const tools = compileVoiceTools({
    ...REAL_ESTATE_TEMPLATE,
    tools: ["check_calendar"],
    detect: [],
  });
  assert.deepEqual(tools.map((tool) => tool.name), ["check_calendar"]);
});

test("validates strict tool arguments", () => {
  assert.equal(
    validateToolArguments("book_viewing", {
      reference: "VONI-AUH-001",
      datetime: "2026-09-06T10:00:00+04:00",
    }).ok,
    true,
  );
  assert.equal(
    validateToolArguments("book_viewing", {
      reference: "VONI-AUH-001",
      datetime: "2026-09-06T10:00:00",
    }).ok,
    false,
  );
  assert.equal(validateToolArguments("update_lead", {}).ok, false);
  assert.equal(
    validateToolArguments("search_properties", {
      min_price_aed: 2_000_000,
      max_price_aed: 1_000_000,
    }).ok,
    false,
  );
});

test("applies Dubai recurring viewing boundaries", () => {
  const schedule = {
    timezone: "Asia/Dubai",
    weekly: { sunday: [{ start: "10:00", end: "18:00" }] },
  };
  assert.equal(
    isWithinRecurringAvailability(
      new Date("2026-09-06T10:00:00+04:00"),
      schedule,
    ),
    true,
  );
  assert.equal(
    isWithinRecurringAvailability(
      new Date("2026-09-06T17:00:00+04:00"),
      schedule,
    ),
    true,
  );
  assert.equal(
    isWithinRecurringAvailability(
      new Date("2026-09-06T17:30:00+04:00"),
      schedule,
    ),
    false,
  );
  assert.equal(
    isWithinRecurringAvailability(
      new Date("2026-09-11T10:00:00+04:00"),
      schedule,
    ),
    false,
  );
});


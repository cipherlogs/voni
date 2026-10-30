import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  RESUME_HISTORY_TURNS,
  boundedResumeHistory,
} from "./resume-history";

const here = dirname(fileURLToPath(import.meta.url));
const REGISTRY = JSON.parse(
  readFileSync(
    join(here, "../../../../voice-pipeline/cascade/thresholds.json"),
    "utf8",
  ),
) as { bounds: Record<string, { value?: unknown }> };

test("a hold return carries the newest bounded turns in order", () => {
  const turns = Array.from({ length: RESUME_HISTORY_TURNS + 8 }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("agent" as const),
    text: `turn ${index}`,
  }));

  const history = boundedResumeHistory(turns);

  assert.equal(history.length, RESUME_HISTORY_TURNS);
  assert.deepEqual(
    history[0],
    {
      role: turns[turns.length - RESUME_HISTORY_TURNS].role === "user" ? "user" : "assistant",
      content: `turn ${turns.length - RESUME_HISTORY_TURNS}`,
    },
    "the oldest carried turn is the first of the recent window",
  );
  assert.deepEqual(history.at(-1), { role: "assistant", content: `turn ${turns.length - 1}` });
  assert.deepEqual(
    history.map((message) => message.content),
    turns.slice(-RESUME_HISTORY_TURNS).map((turn) => turn.text),
    "the window is the most recent turns, never a sample",
  );
});

test("empty turns never become messages and the shape is the vendor's", () => {
  const history = boundedResumeHistory([
    { role: "user", text: "Hello" },
    { role: "agent", text: "   " },
    { role: "user", text: "" },
    { role: "agent", text: "Hi there" },
  ]);
  assert.deepEqual(history, [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there" },
  ]);
  assert.ok(history.every((message) => Object.keys(message).sort().join(",") === "content,role"));
});

test("the turn bound is the pipeline registry value, never a literal", () => {
  assert.equal(RESUME_HISTORY_TURNS, REGISTRY.bounds["resume.history_turns"].value);
});

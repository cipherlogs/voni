import assert from "node:assert/strict";
import test from "node:test";
import { chipSlots, DEMO_CHIPS } from "./chips";

test("chips follow the 2nd and 4th finalized agent replies", () => {
  const chips = DEMO_CHIPS["real-estate"];
  const a = { role: "agent" as const };
  const u = { role: "user" as const };
  const slots = chipSlots([a, u, a, u, a, u, a, { role: "agent", live: true }], chips);
  assert.deepEqual(
    slots.map((c) => c?.done ?? null),
    [null, null, "2 viewings open", null, null, null, "Booked Sat 10:30", null],
  );
});

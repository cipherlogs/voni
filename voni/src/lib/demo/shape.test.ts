/**
 * The one shape guard both demo readers use (meta-cascade M12).
 *
 * `artifact-reader.ts` and `event-envelope.ts` refuse different documents but
 * the same way. This test pins the shared contract: a non-object is named by
 * the value that failed, and every refusal is a `ShapeError` carrying the
 * source and field, so a reader cannot quietly grow a second guard.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseScoreboardArtifact, ArtifactReadError } from "./artifact-reader";
import { parseEventEnvelope, EventEnvelopeError } from "./event-envelope";
import { objectOf, optionalObjectOf, showValue, ShapeError } from "./shape";

function refusal(run: () => unknown): ShapeError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ShapeError, "the refusal is a shared ShapeError");
    return error;
  }
  assert.fail("expected the shape guard to refuse");
}

test("the one guard returns a plain object and refuses null, an array or a primitive by value", () => {
  assert.deepEqual(
    objectOf({ a: 1 }, "not a record", () => assert.fail("an object passes")),
    { a: 1 },
  );
  assert.equal(showValue(undefined), "missing");
  assert.equal(showValue(null), "null");
  assert.equal(showValue("x"), '"x"');
  assert.equal(showValue(Number.NaN), "NaN");

  for (const bad of [null, [], "text", 4]) {
    const reason = (() => {
      try {
        objectOf(bad, "captures is not an object", (why) => {
          throw new Error(why);
        });
      } catch (error) {
        return (error as Error).message;
      }
      return "";
    })();
    assert.match(reason, /^captures is not an object \(/);
  }
  assert.equal(
    optionalObjectOf(undefined, "run is not an object", () => assert.fail("absent passes")),
    undefined,
  );
});

test("both readers refuse a non-object through the same shared error base", () => {
  const artifact = refusal(() => parseScoreboardArtifact([], "artifact.json"));
  assert.ok(artifact instanceof ArtifactReadError);
  assert.equal(artifact.source, "artifact.json");
  assert.equal(artifact.field, "artifact");
  assert.match(artifact.reason, /not a scoreboard artifact object \(\[\]\)/);

  const event = refusal(() => parseEventEnvelope(null, "stream:1"));
  assert.ok(event instanceof EventEnvelopeError);
  assert.equal(event.source, "stream:1");
  assert.equal(event.field, "event");
  assert.equal(event.reason, "not an event envelope object (null)");
});

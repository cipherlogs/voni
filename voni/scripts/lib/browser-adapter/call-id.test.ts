/**
 * The browser report carries the call id the mint signed, even when the marks
 * upload never lands. The marks are evidence the id was observed; they are
 * never the source of the identity.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { reportCallId } from "./call-id";

const CALL_ID = "33333333-3333-4333-8333-333333333333";

test("a lost marks upload still reports the id minted into the demo call token", () => {
  assert.equal(
    reportCallId({
      mintedDemoCallToken: `${CALL_ID}.1761771700.tag-id.mac`,
      marksCallId: null,
    }),
    CALL_ID,
  );
});

test("the minted id wins over the marks artifact's copy", () => {
  assert.equal(
    reportCallId({
      mintedDemoCallToken: `${CALL_ID}.1761771700.tag-id.mac`,
      marksCallId: "44444444-4444-4444-8444-444444444444",
    }),
    CALL_ID,
  );
});

test("a malformed minted token does not invent an id", () => {
  assert.equal(reportCallId({ mintedDemoCallToken: "../escape.x.y", marksCallId: null }), null);
});

test("an older report with only the marks artifact keeps its id", () => {
  assert.equal(reportCallId({ mintedDemoCallToken: null, marksCallId: CALL_ID }), CALL_ID);
});

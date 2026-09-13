import test from "node:test";
import assert from "node:assert/strict";
import { dialOutcomeLabel, dispatchIdleLabel } from "./outcome-label";

// Pure label units: no DB, no session.
test("dispatcher idle states map to operator sentences", () => {
  assert.equal(
    dispatchIdleLabel("no active campaigns"),
    "No active campaigns — activate a campaign to start dialling",
  );
  assert.equal(
    dispatchIdleLabel("a call is already in progress"),
    "A call is already in progress — the next lead dials when it ends",
  );
  assert.equal(
    dispatchIdleLabel("agent is not deployed"),
    "The agent is not deployed — publish it before dialling",
  );
  assert.equal(
    dispatchIdleLabel("no leads due"),
    "No leads due right now — the queue refills when backoff or the calling window opens",
  );
});

test("campaign-qualified fragments keep the campaign name as subject", () => {
  assert.equal(
    dispatchIdleLabel("Acme: no leads due"),
    "Acme — No leads due right now — the queue refills when backoff or the calling window opens",
  );
  assert.equal(
    dispatchIdleLabel("Acme: no leads due; Beta: agent is not deployed"),
    "Acme — No leads due right now — the queue refills when backoff or the calling window opens; Beta — The agent is not deployed — publish it before dialling",
  );
});

test("campaign-qualified calling-window verdicts map through the same table", () => {
  assert.equal(
    dispatchIdleLabel('Acme: 08:00 in Asia/Dubai is outside 09:00-18:00'),
    "Acme — Outside calling hours (08:00, window 09:00-18:00) — will retry when the window opens",
  );
});

test("unknown idle shapes pass through as null", () => {
  assert.equal(dispatchIdleLabel(null), null);
  assert.equal(dispatchIdleLabel(""), null);
  assert.equal(
    dispatchIdleLabel("Acme: something entirely new"),
    null,
  );
});

test("dial outcomes are unchanged (regression guard)", () => {
  assert.equal(dialOutcomeLabel("no_answer"), "No answer — will retry");
  assert.equal(
    dialOutcomeLabel("consent revoked"),
    "Consent withdrawn — do not call",
  );
});

/**
 * What the account says about itself, taken from the relay's own frames.
 *
 * The number that matters is `ipLocationChangesLimit`: the client sizes its ledger
 * from it and must never assume the free tier's ten. The account identifier and
 * password ride in the same frames, and none of them may survive parsing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAccountFrame,
  changesRemaining,
  emptyAccountState,
  type TuxlerAccountState,
} from "./account";
import { parseFrame } from "./frames";

const EMAIL = "probe.someone@example.test";
const PASSWORD = "not-a-real-password";

function feed(
  state: TuxlerAccountState,
  raw: string,
): TuxlerAccountState {
  return applyAccountFrame(state, parseFrame(raw));
}

test("the change limit comes from the limits frame, not from a default", () => {
  const state = feed(
    emptyAccountState(),
    '<message>LIMITS_INFO<details>{"ipLocationPoolLimit":50,"ipLocationChangesLimit":7,"bandwidthLimit":-1,"isIPSharingActive":false}</details></message>',
  );
  assert.equal(state.changesLimit, 7);
  assert.equal(state.bandwidthLimit, -1);
});

test("usage comes from the account info frame", () => {
  const state = feed(
    emptyAccountState(),
    '<message>ACCOUNT_INFO<details>{"currentIPLocationChanges":4,"currentBandwidth":2048}</details></message>',
  );
  assert.equal(state.changesUsed, 4);
});

test("remaining changes is the reported limit minus the reported usage", () => {
  let state = feed(
    emptyAccountState(),
    '<message>LIMITS_INFO<details>{"ipLocationChangesLimit":10}</details></message>',
  );
  state = feed(
    state,
    '<message>ACCOUNT_INFO<details>{"currentIPLocationChanges":3}</details></message>',
  );
  assert.equal(changesRemaining(state), 7);
});

test("an unlimited meter reports no remaining count instead of a huge number", () => {
  let state = feed(
    emptyAccountState(),
    '<message>LIMITS_INFO<details>{"ipLocationChangesLimit":-1}</details></message>',
  );
  assert.equal(state.changesLimit, -1);
  assert.equal(changesRemaining(state), null);
  state = feed(
    state,
    '<message>ACCOUNT_INFO<details>{"currentIPLocationChanges":12}</details></message>',
  );
  assert.equal(changesRemaining(state), null);
});

test("the reset time is read from the bare date the relay sends", () => {
  const state = feed(
    emptyAccountState(),
    "<message>RESET_INFO<details>2026-11-26T08:26:00-05:00</details></message>",
  );
  assert.equal(state.resetAt, "2026-11-26T13:26:00.000Z");
});

test("a reset time the relay sends in a legacy format is still understood", () => {
  const state = feed(
    emptyAccountState(),
    "<message>RESET_INFO<details>Thu Nov 26 2026 08:26:00 GMT-0500 (Eastern Standard Time)</details></message>",
  );
  assert.equal(state.resetAt, "2026-11-26T13:26:00.000Z");
});

test("a reset time that is not a date is reported as unknown, not as 1970", () => {
  const state = feed(emptyAccountState(), "<message>RESET_INFO<details>later</details></message>");
  assert.equal(state.resetAt, null);
});

test("the tier comes from the account frame and defaults to unknown", () => {
  assert.equal(emptyAccountState().tier, "unknown");
  const free = feed(
    emptyAccountState(),
    `<message>RECEIVED_ACCOUNT_INFO<details>passok:1;premium:0;email:${EMAIL};password:${PASSWORD};</details></message>`,
  );
  assert.equal(free.tier, "free");
  assert.equal(free.premium, false);
  const premium = feed(
    emptyAccountState(),
    `<message>RECEIVED_ACCOUNT_INFO<details>passok:1;premium:1;email:${EMAIL};password:${PASSWORD};</details></message>`,
  );
  assert.equal(premium.tier, "premium");
  assert.equal(premium.premium, true);
});

test("no account identifier or password survives into the account state", () => {
  const state = feed(
    emptyAccountState(),
    `<message>RECEIVED_ACCOUNT_INFO<details>passok:1;premium:0;email:${EMAIL};password:${PASSWORD};</details></message>`,
  );
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes(EMAIL), "email leaked into account state");
  assert.ok(!serialized.includes(PASSWORD), "password leaked into account state");
});

test("malformed JSON leaves the previous state alone instead of throwing", () => {
  const before = feed(
    emptyAccountState(),
    '<message>LIMITS_INFO<details>{"ipLocationChangesLimit":7}</details></message>',
  );
  assert.deepEqual(
    feed(before, "<message>LIMITS_INFO<details>{not json</details></message>"),
    before,
  );
  assert.deepEqual(feed(before, "<message>ACCOUNT_INFO<details></details></message>"), before);
});

test("a frame the client has no use for is not mistaken for account state", () => {
  const before = emptyAccountState();
  assert.deepEqual(feed(before, "<message>UNBANNED_IP_HOSTING<details></details></message>"), before);
});

/**
 * The change reply, variant by variant.
 *
 * The probe understood two of the nine replies the relay can send; the rest
 * collapsed into "not ok". These tests pin every variant to its own outcome, so a
 * limit, an overload, an unavailable exit and a reply that moved nothing can never
 * be mistaken for an exit — and a success without a usable port never becomes one.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseFrame } from "./frames";
import {
  encodeChangeRequest,
  isChangeReplyTag,
  parseChangeReply,
  type ChangeOutcome,
} from "./change";

function reply(tag: string, details: string): ChangeOutcome {
  return parseChangeReply(
    parseFrame(`<message>${tag}<details>${details}</details></message>`),
  );
}

const US_LOCATION =
  "<country>United States</country><countryiso>US</countryiso>" +
  "<region>Texas</region><city>Dallas</city>";

test("the change request is the relay's exact literal", () => {
  assert.equal(
    encodeChangeRequest({ country: "US", city: "any", nearby: false }),
    "next_nearby:0;country:US;city:any;",
  );
  assert.equal(
    encodeChangeRequest(),
    "next_nearby:0;country:US;city:any;",
    "the default asks for the US only, never `any` country",
  );
  assert.equal(
    encodeChangeRequest({ country: "US", city: "New York", nearby: true }),
    "next_nearby:1;country:US;city:New%20York;",
  );
});

test("a successful change carries the address, the location and the relay's own port", () => {
  const outcome = reply(
    "IP_CHANGED_SUCCESSFULLY",
    `<status>OK</status><ip>198.51.100.7</ip><location>${US_LOCATION}</location><port>40123</port>`,
  );
  assert.equal(outcome.kind, "changed");
  if (outcome.kind !== "changed") return;
  assert.equal(outcome.ip, "198.51.100.7");
  assert.equal(outcome.port, 40123, "the port is a string on the wire and a number here");
  assert.equal(outcome.location.countryIso, "US");
  assert.equal(outcome.location.city, "Dallas");
  assert.equal(outcome.lastOfBucket, false);
});

test("the last change of a bucket is still an exit, and says so", () => {
  const outcome = reply(
    "IP_CHANGED_SUCCESSFULLY_BUT_LIMIT",
    `<status>OK</status><ip>203.0.113.44</ip><location>${US_LOCATION}</location><port>40400</port>`,
  );
  assert.equal(outcome.kind, "changed");
  if (outcome.kind !== "changed") return;
  assert.equal(outcome.lastOfBucket, true);
});

test("a success that names no usable port is not an exit", () => {
  for (const details of [
    `<status>OK</status><ip>198.51.100.7</ip><location>${US_LOCATION}</location>`,
    `<status>OK</status><ip>198.51.100.7</ip><location>${US_LOCATION}</location><port></port>`,
    `<status>OK</status><ip>198.51.100.7</ip><location>${US_LOCATION}</location><port>0</port>`,
    `<status>OK</status><ip>198.51.100.7</ip><location>${US_LOCATION}</location><port>NaN</port>`,
    `<status>FAILED</status><ip>198.51.100.7</ip><location>${US_LOCATION}</location><port>40123</port>`,
  ]) {
    const outcome = reply("IP_CHANGED_SUCCESSFULLY", details);
    assert.equal(outcome.kind, "incomplete", details);
  }
});

test("every rejection the relay can send has its own outcome", () => {
  assert.equal(reply("IP_NOT_CHANGED_LIMITS", "<status>NOK</status>").kind, "limit");
  assert.equal(reply("IP_NOT_CHANGED_NOT_AVAILABLE", "").kind, "not-available");
  assert.equal(reply("IP_NOT_CHANGED_OVERLOADED", "").kind, "overloaded");
  assert.equal(reply("IP_CHANGED_FAILED_FREE", "").kind, "not-entitled");

  const unavailable = reply("IP_BECAME_UNAVAILABLE", "");
  assert.equal(unavailable.kind, "exit-unavailable");
  if (unavailable.kind === "exit-unavailable") assert.equal(unavailable.limitReached, false);

  const exhausted = reply("IP_BECAME_UNAVAILABLE_AND_YOU_HAVE_REACHED_LIMITS", "");
  assert.equal(exhausted.kind, "exit-unavailable");
  if (exhausted.kind === "exit-unavailable") assert.equal(exhausted.limitReached, true);
});

test("a reply that moved nothing is a no-change, never an exit", () => {
  const outcome = reply(
    "IP_CHANGED_SUCCESSFULLY_ALREADY_USING",
    `<status>OK</status><ip>198.51.100.7</ip><location>${US_LOCATION}</location><port>40123</port>`,
  );
  assert.equal(outcome.kind, "no-change");
  if (outcome.kind !== "no-change") return;
  assert.equal(outcome.ip, "198.51.100.7");
});

test("an unknown reply is unrecognised, not a success", () => {
  assert.equal(reply("IP_SOMETHING_NEW", "<port>40123</port>").kind, "unrecognised");
});

test("only change traffic is treated as a change reply", () => {
  for (const tag of [
    "IP_CHANGED_SUCCESSFULLY",
    "IP_CHANGED_SUCCESSFULLY_BUT_LIMIT",
    "IP_NOT_CHANGED_LIMITS",
    "IP_BECAME_UNAVAILABLE",
  ]) {
    assert.equal(isChangeReplyTag(tag), true, tag);
  }
  for (const tag of ["TIMEVAL", "YOUR_IP", "ACCOUNT_INFO", "I_AM_ALIVE"]) {
    assert.equal(isChangeReplyTag(tag), false, tag);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { jevMatch, jevSpoof, parseFromHeader, parseGmailMessage } from "./inbox";
import type { InboxMessage } from "./email-test";

test("From headers parse with and without a display name", () => {
  assert.deepEqual(parseFromHeader('"Andres Garcia" <Andres@Acme.com>'), { from: "andres@acme.com", fromName: "Andres Garcia" });
  assert.deepEqual(parseFromHeader("Andres Garcia <andres@acme.com>"), { from: "andres@acme.com", fromName: "Andres Garcia" });
  assert.deepEqual(parseFromHeader("andres@acme.com"), { from: "andres@acme.com", fromName: "" });
});

test("a Gmail metadata message becomes an inbox message", () => {
  const m = parseGmailMessage({
    id: "m1",
    threadId: "t1",
    internalDate: "1700000000000",
    payload: {
      headers: [
        { name: "From", value: "Andres <andres@acme.com>" },
        { name: "Subject", value: "hi Voni" },
        { name: "Authentication-Results", value: "mx.google.com; spf=pass" },
        { name: "Authentication-Results", value: "mx.google.com; dmarc=pass" },
      ],
    },
  });
  assert.deepEqual(m, {
    id: "m1",
    threadId: "t1",
    from: "andres@acme.com",
    fromName: "Andres",
    subject: "hi Voni",
    receivedAt: 1700000000000,
    authResults: "mx.google.com; spf=pass; mx.google.com; dmarc=pass",
    snippet: "",
  });
});

const candidate: InboxMessage = {
  id: "m1", threadId: "t1", from: "andres@acme.com", fromName: "", subject: "", receivedAt: 0, authResults: "",
};
const gateway = (answer: unknown) => ({
  apiKey: "k",
  gatewayUrl: "https://gw.test",
  fetchImpl: (async () => Response.json({ answers: { judge: answer } })) as typeof fetch,
});

test("Jev's match pick maps to an id, none, or a throw (fallback)", async () => {
  assert.equal(await jevMatch("andres@acme.com", [candidate], gateway({ pick: "m1" })), "m1");
  assert.equal(await jevMatch("andres@acme.com", [candidate], gateway({ pick: "none" })), null);
  await assert.rejects(jevMatch("andres@acme.com", [candidate], gateway({ pick: "m9" })));
  await assert.rejects(jevMatch("andres@acme.com", [candidate], { gatewayUrl: "https://gw.test" }), "no key → throws");
  assert.equal(await jevMatch("andres@acme.com", [], gateway({ pick: "m1" })), null, "no candidates → no call");
});

test("Jev's spoof flag needs a confident probability", async () => {
  assert.equal(await jevSpoof(candidate, gateway({ probability: 0.9 })), true);
  assert.equal(await jevSpoof(candidate, gateway({ probability: 0.6 })), false);
  await assert.rejects(jevSpoof(candidate, gateway({})));
});

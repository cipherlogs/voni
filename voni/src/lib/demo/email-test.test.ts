import test from "node:test";
import assert from "node:assert/strict";
import {
  EMAIL_TEST_START,
  PROVISIONAL_TALK_S,
  checkEmail,
  checkResultFromData,
  checkResultToData,
  emailTestAfterCheck,
  fallbackMatch,
  isFreeEmailDomain,
  nameFromAddress,
  normalizeClaim,
  spoofedByHeaders,
  talkLimitS,
  type InboxMessage,
} from "./email-test";
import { TALK_BASE_S } from "./talk-clock";

const msg = (id: string, from: string, receivedAt: number, extra: Partial<InboxMessage> = {}): InboxMessage => ({
  id,
  threadId: `t_${id}`,
  from,
  fromName: "",
  subject: "hello",
  receivedAt,
  authResults: "mx.google.com; dkim=pass; spf=pass; dmarc=pass",
  ...extra,
});

test("a spoken or written claim normalizes to one address", () => {
  assert.equal(normalizeClaim("Andres@Acme-Realty.com"), "andres@acme-realty.com");
  assert.equal(normalizeClaim("andres at acme dash realty dot com"), "andres@acme-realty.com");
  assert.equal(normalizeClaim(" andres.garcia @ acme.co.uk. "), "andres.garcia@acme.co.uk");
  assert.equal(normalizeClaim("andres underscore g at acme dot io"), "andres_g@acme.io");
  assert.equal(normalizeClaim("my work email"), null);
  assert.equal(normalizeClaim("andres@acme"), null, "a domain needs a dot");
});

test("the free-email gate is a plain domain list", () => {
  for (const d of ["gmail.com", "googlemail.com", "outlook.com", "hotmail.co.uk", "yahoo.fr", "icloud.com", "proton.me", "gmx.de"]) {
    assert.equal(isFreeEmailDomain(d), true, d);
  }
  for (const d of ["acme-realty.com", "voni.cc", "gmail.acme.com"]) {
    assert.equal(isFreeEmailDomain(d), false, d);
  }
});

test("the name comes from the address, else the display name, never a role box", () => {
  assert.equal(nameFromAddress("andres@acme.com"), "Andres");
  assert.equal(nameFromAddress("andres.garcia@acme.com"), "Andres");
  assert.equal(nameFromAddress("a.garcia@acme.com"), null, "an initial is not a name");
  assert.equal(nameFromAddress("info@acme.com"), null);
  assert.equal(nameFromAddress("sales@acme.com"), null);
  assert.equal(nameFromAddress("x42@acme.com"), null);
  assert.equal(nameFromAddress("info@acme.com", "Maria Lopez"), "Maria");
  assert.equal(nameFromAddress("andres@acme.com", "Bob Stone"), "Andres", "the address wins");
  assert.equal(nameFromAddress("info@acme.com", "info@acme.com"), null, "an address as display name is ignored");
});

test("Gmail's own DMARC/SPF verdict flags a spoof", () => {
  assert.equal(spoofedByHeaders("mx.google.com; dkim=pass; spf=pass; dmarc=pass"), false);
  assert.equal(spoofedByHeaders("mx.google.com; spf=pass; dmarc=fail (p=NONE)"), true);
  assert.equal(spoofedByHeaders("mx.google.com; spf=fail smtp.mailfrom=x"), true);
  assert.equal(spoofedByHeaders("mx.google.com; dkim=pass; spf=fail"), false, "forwarded mail: DKIM still vouches");
  assert.equal(spoofedByHeaders(""), false, "no verdict is not a fail");
});

test("the fallback matcher finds the caller among others, tolerating near misses", () => {
  const inbox = [
    msg("m3", "someone@other.com", 3000),
    msg("m2", "andres@acme-realty.com", 2000),
    msg("m1", "andres@acme-realty.com", 1000),
  ];
  assert.deepEqual(fallbackMatch("andres@acme-realty.com", inbox), { message: inbox[1], exact: true }, "newest exact");
  assert.deepEqual(fallbackMatch("andress@acme-realty.com", inbox), { message: inbox[1], exact: false }, "one letter off");
  assert.deepEqual(fallbackMatch("andres@acmerealty.com", inbox), { message: inbox[1], exact: false }, "dash dropped");
  assert.equal(fallbackMatch("bob@acme-realty.com", inbox), null);
});

const listed = (messages: InboxMessage[]) => async () => messages;

test("check: an unparseable claim asks again", async () => {
  const result = await checkEmail("dunno", { listInbox: listed([]) });
  assert.deepEqual(result, { status: "invalid" });
});

test("check: a free-email claim hits the gate without touching the inbox", async () => {
  const result = await checkEmail("andres at gmail dot com", {
    listInbox: async () => assert.fail("inbox read on a free claim"),
  });
  assert.deepEqual(result, { status: "free", address: "andres@gmail.com" });
});

test("check: a business claim whose email is not in yet", async () => {
  const result = await checkEmail("andres@acme.com", { listInbox: listed([msg("m1", "else@other.com", 1)]) });
  assert.deepEqual(result, { status: "not_arrived", address: "andres@acme.com", name: "Andres" });
});

test("check: an unreadable inbox reads as not arrived, never as a crash", async () => {
  const result = await checkEmail("andres@acme.com", {
    listInbox: async () => {
      throw new Error("gmail down");
    },
  });
  assert.equal(result.status, "not_arrived");
});

test("check: an exact sender is found without asking Jev", async () => {
  const result = await checkEmail("andres@acme.com", {
    listInbox: listed([msg("m1", "andres@acme.com", 1, { fromName: "Andres Garcia" })]),
    jevMatch: async () => assert.fail("Jev asked about an exact match"),
  });
  assert.deepEqual(result, {
    status: "found",
    address: "andres@acme.com",
    from: "andres@acme.com",
    name: "Andres",
    exact: true,
    messageId: "m1",
    threadId: "t_m1",
  });
});

test("check: the fallback's near miss stands when Jev is down, named from the claim only", async () => {
  const result = await checkEmail("andress@acme.com", {
    listInbox: listed([msg("m1", "andres@acme.com", 1, { fromName: "Bob Stone" })]),
    jevMatch: async () => {
      throw new Error("jev down");
    },
  });
  assert.equal(result.status === "found" && result.exact, false);
  assert.equal(result.status === "found" && result.name, "Andress", "never the other sender's display name");
});

test("check: Jev weighs near misses, bounded to plausible senders", async () => {
  const inbox = [msg("m3", "zed@elsewhere.org", 3), msg("m2", "andy@acme.com", 2), msg("m1", "anders@acme.com", 1)];
  const pick = (id: string | null) => ({ listInbox: listed(inbox), jevMatch: async () => id });
  const picked = await checkEmail("andres@acme.com", pick("m2"));
  assert.equal(picked.status === "found" && picked.from, "andy@acme.com");
  assert.equal((await checkEmail("andres@acme.com", pick("m3"))).status, "not_arrived", "an unrelated pick is refused");
  assert.equal((await checkEmail("andres@acme.com", pick(null))).status, "not_arrived", "Jev's none overrides a near miss");
});

test("check: only email that arrived during this call counts", async () => {
  const since = 1_000_000;
  const before = msg("m1", "andres@acme.com", since - 5 * 60_000);
  assert.equal((await checkEmail("andres@acme.com", { listInbox: listed([before]), since })).status, "not_arrived");
  const during = msg("m2", "andres@acme.com", since + 1000);
  assert.equal((await checkEmail("andres@acme.com", { listInbox: listed([before, during]), since })).status, "found");
});

test("check: a header-spoofed email is never a candidate", async () => {
  const result = await checkEmail("andres@acme.com", {
    listInbox: listed([msg("m1", "andres@acme.com", 1, { authResults: "spf=fail; dmarc=fail" })]),
    jevMatch: async (_claim, candidates) => {
      assert.equal(candidates.length, 0);
      return null;
    },
  });
  assert.equal(result.status, "not_arrived");
});

test("check: a match Jev flags as spoof/spam is not treated as a match", async () => {
  const result = await checkEmail("andres@acme.com", {
    listInbox: listed([msg("m1", "andres@acme.com", 1)]),
    jevSpoof: async () => true,
  });
  assert.equal(result.status, "not_arrived");
});

test("check: our own inbox's mail is never the caller's", async () => {
  const result = await checkEmail("nedalk.js@gmail.com", { listInbox: listed([]) });
  assert.equal(result.status, "free");
});

test("extension: a business claim is provisional (~4 min), free and invalid change nothing", () => {
  assert.equal(talkLimitS(EMAIL_TEST_START), TALK_BASE_S);
  const free = emailTestAfterCheck(EMAIL_TEST_START, { status: "free", address: "a@gmail.com" });
  assert.deepEqual(free, EMAIL_TEST_START);
  const invalid = emailTestAfterCheck(EMAIL_TEST_START, { status: "invalid" });
  assert.deepEqual(invalid, EMAIL_TEST_START);
  const claimed = emailTestAfterCheck(EMAIL_TEST_START, { status: "not_arrived", address: "a@acme.com", name: null });
  assert.deepEqual(claimed, { invited: false, claim: "a@acme.com", found: false });
  assert.equal(talkLimitS(claimed), PROVISIONAL_TALK_S);
  const found = emailTestAfterCheck(claimed, {
    status: "found",
    address: "a@acme.com",
    from: "a@acme.com",
    name: null,
    exact: true,
    messageId: "m1",
    threadId: "t1",
  });
  assert.deepEqual(found, { invited: false, claim: "a@acme.com", found: true });
  assert.equal(talkLimitS(found), PROVISIONAL_TALK_S);
  const near = emailTestAfterCheck(claimed, {
    status: "found",
    address: "a@acme.com",
    from: "b@acme.com",
    name: null,
    exact: false,
    messageId: "m1",
    threadId: "t1",
  });
  assert.equal(near.found, false, "a near miss waits for the spelled-out address");
});

test("extension: once found, a later check never un-finds it", () => {
  const found = { invited: true, claim: "a@acme.com", found: true };
  assert.deepEqual(emailTestAfterCheck(found, { status: "not_arrived", address: "a@acme.com", name: null }), found);
});

test("the browser reads a check back from the tool route's data", () => {
  assert.deepEqual(checkResultFromData({ status: "not_arrived", address: "a@acme.com", name: "Ann" }), {
    status: "not_arrived",
    address: "a@acme.com",
    name: "Ann",
  });
  assert.equal(checkResultFromData({ status: "found", address: "a@acme.com", exact: true }).status, "found");
  assert.deepEqual(checkResultFromData({ status: "found" }), { status: "invalid" }, "no address");
  assert.deepEqual(checkResultFromData({}), { status: "invalid" });
});

test("the route's data and the browser's read agree, and never carry message ids", () => {
  const results = [
    { status: "invalid" },
    { status: "free", address: "a@gmail.com" },
    { status: "not_arrived", address: "a@b.com", name: "Ann" },
    { status: "found", address: "a@b.com", from: "a@b.com", name: null, exact: false, messageId: "m", threadId: "t" },
  ] as const;
  for (const r of results) {
    const data = checkResultToData(r);
    assert.equal("messageId" in data || "threadId" in data || "from" in data, false, "no ids, no sender");
    const back = checkResultFromData(data);
    assert.deepEqual(back, r.status === "found" ? { ...r, from: "", messageId: "", threadId: "" } : r);
  }
});

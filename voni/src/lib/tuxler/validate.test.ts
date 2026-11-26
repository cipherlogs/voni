/**
 * US, and residential.
 *
 * Two independent checks decide whether a change reply is an exit we may use: the
 * reply's own country code, and the address's ASN class. The classifier is
 * injected, so nothing here touches DNS; the one test that does exercise the real
 * lookup drives it through a fake resolver instead.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  HOSTING_ASNS,
  classifyAsn,
  cymruLookup,
  parseCymruOrigin,
  validateExit,
  type AsnRecord,
} from "./validate";

const CONSUMER: AsnRecord = {
  asn: 7018,
  prefix: "99.44.0.0/14",
  country: "US",
  name: "ATT-INTERNET4 - AT&T Services, Inc.",
};

const HOSTING: AsnRecord = {
  asn: 16509,
  prefix: "54.211.0.0/16",
  country: "US",
  name: "AMAZON-02 - Amazon.com, Inc.",
};

test("a US address on a consumer ISP is accepted", async () => {
  const verdict = await validateExit({
    ip: "99.44.12.7",
    countryIso: "US",
    lookup: async () => CONSUMER,
  });
  assert.equal(verdict.accepted, true);
  if (!verdict.accepted) return;
  assert.equal(verdict.asn.asn, 7018);
});

test("a non-US reply is rejected even when the ASN is a consumer ISP", async () => {
  const verdict = await validateExit({
    ip: "99.44.12.7",
    countryIso: "DE",
    lookup: async () => CONSUMER,
  });
  assert.equal(verdict.accepted, false);
  if (verdict.accepted) return;
  assert.equal(verdict.reason, "not-us");
});

test("a reply with no country at all is rejected rather than assumed US", async () => {
  const verdict = await validateExit({
    ip: "99.44.12.7",
    countryIso: null,
    lookup: async () => CONSUMER,
  });
  assert.equal(verdict.accepted, false);
  if (verdict.accepted) return;
  assert.equal(verdict.reason, "not-us");
});

test("a US address in a hosting ASN is rejected", async () => {
  const verdict = await validateExit({
    ip: "54.211.170.155",
    countryIso: "US",
    lookup: async () => HOSTING,
  });
  assert.equal(verdict.accepted, false);
  if (verdict.accepted) return;
  assert.equal(verdict.reason, "hosting");
});

test("a US address whose ASN name says hosting is rejected", async () => {
  const verdict = await validateExit({
    ip: "45.9.9.9",
    countryIso: "US",
    lookup: async () => ({
      asn: 400000,
      prefix: "45.9.9.0/24",
      country: "US",
      name: "SOME-VPS Hosting Solutions LLC",
    }),
  });
  assert.equal(verdict.accepted, false);
  if (verdict.accepted) return;
  assert.equal(verdict.reason, "hosting");
});

test("a US address in an unlisted ASN whose name query failed is rejected, not assumed consumer", async () => {
  // The origin resolves, but the AS-name query does not answer. An unlisted ASN
  // must never be read as a consumer ISP on a failed lookup.
  const lookup = cymruLookup({
    resolveTxt: async (name: string) => {
      if (name.includes("origin.asn.cymru.com")) {
        return [["400000 | 45.9.9.0/24 | US | arin | 2020-01-01"]];
      }
      throw new Error("queryTxt ETIMEOUT");
    },
  });

  const verdict = await validateExit({
    ip: "45.9.9.9",
    countryIso: "US",
    lookup,
  });

  assert.equal(verdict.accepted, false);
  if (verdict.accepted) return;
  assert.equal(verdict.reason, "name-lookup-failed");
});

test("a resolved consumer ISP is still accepted when its name query answered", async () => {
  const lookup = cymruLookup({
    resolveTxt: async (name: string) => {
      if (name.includes("origin.asn.cymru.com")) {
        return [["7018 | 99.44.0.0/14 | US | arin | 1992-12-01"]];
      }
      return [["7018 | US | arin | 2000-03-30 | ATT-INTERNET4, US"]];
    },
  });

  const verdict = await validateExit({ ip: "99.44.12.7", countryIso: "US", lookup });
  assert.equal(verdict.accepted, true);
});

test("a resolved hosting ASN is rejected when the name query answered", async () => {
  const lookup = cymruLookup({
    resolveTxt: async (name: string) => {
      if (name.includes("origin.asn.cymru.com")) {
        return [["16509 | 54.211.0.0/16 | US | arin | 2000-01-01"]];
      }
      return [["16509 | US | arin | 2000-01-01 | AMAZON-02, US"]];
    },
  });

  const verdict = await validateExit({ ip: "54.211.170.155", countryIso: "US", lookup });
  assert.equal(verdict.accepted, false);
  if (verdict.accepted) return;
  assert.equal(verdict.reason, "hosting");
});

test("a failed ASN lookup fails closed, with its own reason", async () => {
  const verdict = await validateExit({
    ip: "99.44.12.7",
    countryIso: "US",
    lookup: async () => {
      throw new Error("queryTxt ENOTFOUND");
    },
  });
  assert.equal(verdict.accepted, false);
  if (verdict.accepted) return;
  assert.equal(verdict.reason, "lookup-failed");
});

test("an ASN the lookup could not identify is a failed lookup, not a consumer ISP", async () => {
  const verdict = await validateExit({
    ip: "99.44.12.7",
    countryIso: "US",
    lookup: async () => ({ asn: 0, prefix: "", country: null, name: null }),
  });
  assert.equal(verdict.accepted, false);
  if (verdict.accepted) return;
  assert.equal(verdict.reason, "lookup-failed");
});

test("a hosting address is rejected even before its name is consulted", () => {
  assert.equal(classifyAsn(HOSTING), "hosting");
  assert.equal(classifyAsn(CONSUMER), "consumer");
  assert.equal(
    classifyAsn({ asn: 400000, prefix: "45.9.9.0/24", country: "US", name: null }),
    "unclassifiable",
    "an unlisted ASN with no name is not a consumer ISP by default",
  );
  assert.ok(HOSTING_ASNS.has(16509), "Amazon must be on the hosting list");
  assert.ok(HOSTING_ASNS.has(15169), "Google must be on the hosting list");
});

test("a Team Cymru origin answer is read as ASN, prefix and country", () => {
  assert.deepEqual(parseCymruOrigin(["7018 | 99.44.0.0/14 | US | arin | 1992-12-01"]), {
    asn: 7018,
    prefix: "99.44.0.0/14",
    country: "US",
  });
  assert.equal(parseCymruOrigin(["garbage"]), null);
  assert.equal(parseCymruOrigin([]), null);
});

test("the real lookup asks Team Cymru by reversed address and answers from cache", async () => {
  const asked: string[] = [];
  const lookup = cymruLookup({
    resolveTxt: async (name: string) => {
      asked.push(name);
      if (name.includes("origin.asn.cymru.com")) {
        return [["7018 | 99.44.0.0/14 | US | arin | 1992-12-01"]];
      }
      return [["7018 | US | arin | 2000-03-30 | ATT-INTERNET4, US"]];
    },
  });

  const first = await lookup("99.44.12.7");
  assert.equal(first.asn, 7018);
  assert.equal(first.prefix, "99.44.0.0/14");
  assert.match(asked[0], /^7\.12\.44\.99\.origin\.asn\.cymru\.com$/);

  const second = await lookup("99.44.12.8");
  assert.equal(second.asn, 7018);
  assert.equal(asked.length, 2, "a second address in the same /24 needs no new query");
});

test("the real lookup rejects when Team Cymru cannot be reached", async () => {
  const lookup = cymruLookup({
    resolveTxt: async () => {
      throw new Error("timeout");
    },
  });
  await assert.rejects(lookup("99.44.12.7"));
});

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
  dohTxtResolver,
  parseCymruOrigin,
  systemThenDohTxtResolver,
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
  let lookups = 0;
  const verdict = await validateExit({
    ip: "99.44.12.7",
    countryIso: "DE",
    lookup: async () => {
      lookups += 1;
      return CONSUMER;
    },
  });
  assert.equal(verdict.accepted, false);
  if (verdict.accepted) return;
  assert.equal(verdict.reason, "not-us");
  assert.equal(lookups, 0, "a relay that names another country is refused without a lookup");
});

test("a reply with no country is accepted when the registry places the address in the US", async () => {
  const verdict = await validateExit({
    ip: "99.44.12.7",
    countryIso: null,
    lookup: async () => CONSUMER,
  });
  assert.equal(verdict.accepted, true);
  if (!verdict.accepted) return;
  assert.equal(verdict.asn.country, "US");
});

test("a reply with no country is rejected when the registry places the address elsewhere", async () => {
  const verdict = await validateExit({
    ip: "102.69.220.138",
    countryIso: null,
    lookup: async () => ({
      asn: 328494,
      prefix: "102.69.220.0/24",
      country: "GH",
      name: "SOME-CONSUMER-ISP, GH",
    }),
  });
  assert.equal(verdict.accepted, false);
  if (verdict.accepted) return;
  assert.equal(verdict.reason, "not-us");
  assert.match(verdict.detail, /registry places 102\.69\.220\.138 in GH/);
});

test("a reply with no country is rejected when the registry names no country either", async () => {
  const verdict = await validateExit({
    ip: "99.44.12.7",
    countryIso: null,
    lookup: async () => ({ ...CONSUMER, country: null }),
  });
  assert.equal(verdict.accepted, false);
  if (verdict.accepted) return;
  assert.equal(verdict.reason, "not-us");
  assert.match(verdict.detail, /registry named no country for 99\.44\.12\.7/);
});

test("a US reply is rejected when the registry disagrees", async () => {
  const verdict = await validateExit({
    ip: "102.69.220.138",
    countryIso: "US",
    lookup: async () => ({
      asn: 328494,
      prefix: "102.69.220.0/24",
      country: "GH",
      name: "SOME-CONSUMER-ISP, GH",
    }),
  });
  assert.equal(verdict.accepted, false);
  if (verdict.accepted) return;
  assert.equal(verdict.reason, "not-us");
  assert.match(verdict.detail, /in GH/);
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

/** A JSON-DNS response body, as both DoH providers send it. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/dns-json" },
  });
}

/** One `type: 16` answer entry; `data` is exactly what the provider sends. */
function txtAnswer(data: string): unknown {
  return {
    Status: 0,
    Answer: [{ name: "origin.asn.cymru.com", type: 16, TTL: 300, data }],
  };
}

const CYMRU_NAME = "102.69.220.0.138.origin.asn.cymru.com";

// The live values from the operator's machine: Cloudflare quotes the TXT data,
// Google does not, and the same prefix has both a /24 and a /22 answer.
const GH_RECORD_24 = "328494 | 102.69.220.0/24 | GH | afrinic | 2019-06-03";
const GH_RECORD_22 = "328494 | 102.69.220.0/22 | GH | afrinic | 2019-06-03";

test("the DoH resolver reads a Cloudflare-quoted TXT answer", async () => {
  const urls: string[] = [];
  const accepts: Array<string | undefined> = [];
  const resolver = dohTxtResolver({
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      accepts.push(new Headers(init?.headers).get("accept") ?? undefined);
      return jsonResponse(txtAnswer(`"${GH_RECORD_24}"`));
    }) as typeof fetch,
  });

  const answers = await resolver(CYMRU_NAME);
  assert.deepEqual(answers, [[GH_RECORD_24]]);
  assert.equal(answers[0].join(""), GH_RECORD_24);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/cloudflare-dns\.com\/dns-query\?name=/);
  assert.match(urls[0], /&type=TXT$/);
  assert.equal(accepts[0], "application/dns-json");
});

test("the DoH resolver reads Google's unquoted TXT answer without stripping it", async () => {
  const resolver = dohTxtResolver({
    fetchImpl: (async () => jsonResponse(txtAnswer(GH_RECORD_24))) as typeof fetch,
  });

  const answers = await resolver(CYMRU_NAME);
  assert.deepEqual(answers, [[GH_RECORD_24]]);
  assert.equal(answers[0].join(""), GH_RECORD_24);
});

test("one string[] per TXT answer keeps both prefix records, in order", async () => {
  const resolver = dohTxtResolver({
    fetchImpl: (async () =>
      jsonResponse({
        Status: 0,
        Answer: [
          { name: "origin.asn.cymru.com", type: 16, TTL: 300, data: GH_RECORD_24 },
          { name: "origin.asn.cymru.com", type: 16, TTL: 300, data: GH_RECORD_22 },
        ],
      })) as typeof fetch,
  });

  const answers = await resolver(CYMRU_NAME);
  assert.deepEqual(answers, [[GH_RECORD_24], [GH_RECORD_22]]);
  assert.equal(answers[0].join(""), GH_RECORD_24);
  assert.equal(answers[1].join(""), GH_RECORD_22);
});

test("a multi-chunk quoted TXT value reassembles with join", async () => {
  const resolver = dohTxtResolver({
    fetchImpl: (async () =>
      jsonResponse(txtAnswer(`"${GH_RECORD_24}" " | 2019-06-03"`))) as typeof fetch,
  });

  const answers = await resolver(CYMRU_NAME);
  assert.equal(answers[0].length, 2, "the value is two quoted chunks");
  assert.equal(
    answers[0].join(""),
    "328494 | 102.69.220.0/24 | GH | afrinic | 2019-06-03 | 2019-06-03",
  );
});

test("escaped quotes and backslashes are unescaped, not treated as chunk ends", async () => {
  const resolver = dohTxtResolver({
    fetchImpl: (async () => jsonResponse(txtAnswer('"a \\"quoted\\" value \\\\ here"'))) as typeof fetch,
  });

  const answers = await resolver(CYMRU_NAME);
  assert.deepEqual(answers, [['a "quoted" value \\ here']]);
});

test("a failing system resolver falls through to DoH and succeeds", async () => {
  let systemCalls = 0;
  let dohCalls = 0;
  const resolver = systemThenDohTxtResolver({
    system: async () => {
      systemCalls += 1;
      throw new Error("queryTxt ESERVFAIL");
    },
    fetchImpl: async () => {
      dohCalls += 1;
      return jsonResponse(txtAnswer(`"${GH_RECORD_24}"`));
    },
  });

  const answers = await resolver(CYMRU_NAME);
  assert.equal(systemCalls, 1);
  assert.equal(dohCalls, 1);
  assert.deepEqual(answers, [[GH_RECORD_24]]);
});

test("an intermittent system resolver is asked again on the next call", async () => {
  const results: Array<string | Error> = [new Error("queryTxt ESERVFAIL"), GH_RECORD_24];
  const resolver = systemThenDohTxtResolver({
    system: async () => {
      const next = results.shift();
      if (next instanceof Error) throw next;
      return [[next ?? ""]];
    },
    fetchImpl: async () => jsonResponse(txtAnswer(`"${GH_RECORD_24}"`)),
  });

  const failed = await resolver(CYMRU_NAME);
  assert.deepEqual(failed, [[GH_RECORD_24]], "the throw fell through to DoH");

  const answered = await resolver(CYMRU_NAME);
  assert.deepEqual(answered, [[GH_RECORD_24]], "the system resolver is tried again");
});

test("a failing Cloudflare endpoint falls through to Google", async () => {
  const seen: string[] = [];
  const resolver = dohTxtResolver({
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      if (url.startsWith("https://cloudflare-dns.com/")) {
        return new Response("bad gateway", { status: 502 });
      }
      return jsonResponse(txtAnswer(GH_RECORD_24));
    }) as typeof fetch,
  });

  const answers = await resolver(CYMRU_NAME);
  assert.equal(seen.length, 2, "Cloudflare was tried, then Google");
  assert.match(seen[1], /^https:\/\/dns\.google\/resolve\?name=/);
  assert.deepEqual(answers, [[GH_RECORD_24]]);
});

test("DoH failures reject rather than answer an empty set", async () => {
  const cases: Array<[string, () => Response]> = [
    ["Status !== 0", () => jsonResponse({ Status: 2, Answer: [] })],
    ["non-JSON body", () => new Response("<html>nope</html>", { status: 200 })],
    ["empty Answer", () => jsonResponse({ Status: 0, Answer: [] })],
    ["no TXT entry", () => jsonResponse({ Status: 0, Answer: [{ type: 1, data: "1.2.3.4" }] })],
    ["HTTP 500", () => new Response("", { status: 500 })],
    [
      "network throw",
      () => {
        throw new Error("ECONNRESET");
      },
    ],
  ];

  for (const [label, respond] of cases) {
    const resolver = dohTxtResolver({
      fetchImpl: (async () => respond()) as typeof fetch,
    });
    await assert.rejects(resolver(CYMRU_NAME), /DNS-over-HTTPS TXT lookup/, label);
  }
});

test("a DoH failure is still lookup-failed through the classifier, never a pass", async () => {
  const lookup = cymruLookup({
    resolveTxt: dohTxtResolver({
      fetchImpl: (async () => jsonResponse({ Status: 2, Answer: [] })) as typeof fetch,
    }),
  });

  const verdict = await validateExit({ ip: "102.69.220.138", countryIso: "US", lookup });
  assert.equal(verdict.accepted, false);
  if (verdict.accepted) return;
  assert.equal(verdict.reason, "lookup-failed");
});

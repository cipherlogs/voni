import test from "node:test";
import assert from "node:assert/strict";
import { looksParked, pageText, preReadFor, readerText, readWebsite, siteDomain } from "./website";

test("the site to read is the sender's own domain, never a free-email one", () => {
  assert.equal(siteDomain("Andres@Acme-Realty.com"), "acme-realty.com");
  assert.equal(siteDomain("andres@gmail.com"), null);
  assert.equal(siteDomain("andres@hotmail.co.uk"), null);
  assert.equal(siteDomain("not an email"), null);
  assert.equal(siteDomain("a@localhost"), null, "a dotless host is not a public site");
  assert.equal(siteDomain("a@10.0.0.1"), null, "no IP literals");
});

test("page text keeps the title, the description and the visible words only", () => {
  const html = `<html><head><title>Acme Realty &amp; Homes</title>
    <meta name="description" content="Lisbon apartments for expats">
    <style>.x{color:red}</style><script>track()</script></head>
    <body><nav>Home</nav><h1>Find&nbsp;your home</h1><!-- hidden --><p>Since 1998.</p><noscript>enable js</noscript></body></html>`;
  const text = pageText(html);
  assert.match(text, /Acme Realty & Homes/);
  assert.match(text, /Lisbon apartments for expats/);
  assert.match(text, /Find your home/);
  assert.match(text, /Since 1998\./);
  assert.doesNotMatch(text, /color:red|track\(\)|hidden|enable js|</);
});

test("parked, for-sale and empty pages are no site", () => {
  assert.ok(looksParked("This domain is for sale! Buy acme.com today."));
  assert.ok(looksParked("acme.com - parked free, courtesy of GoDaddy"));
  assert.ok(looksParked("Coming soon"));
  assert.ok(looksParked(""));
  assert.ok(!looksParked("Acme Realty helps expats find apartments in Lisbon. ".repeat(5)));
});

const PAGE = `<title>Acme Realty</title><p>${"Acme Realty helps expats rent and buy apartments in Lisbon. ".repeat(8)}</p>`;

test("a real site is fetched and summarized", async () => {
  const tried: string[] = [];
  const result = await readWebsite("acme.com", {
    fetchPage: async (url) => (tried.push(url), PAGE),
    summarize: async (domain, text) => {
      assert.equal(domain, "acme.com");
      assert.match(text, /expats/);
      return { business: true, summary: "Acme Realty rents and sells Lisbon apartments to expats." };
    },
  });
  assert.deepEqual(result, { status: "read", summary: "Acme Realty rents and sells Lisbon apartments to expats." });
  assert.deepEqual(tried, ["https://acme.com/"]);
});

test("the www host is tried when the bare domain doesn't answer", async () => {
  const tried: string[] = [];
  const result = await readWebsite("acme.com", {
    fetchPage: async (url) => (tried.push(url), url.includes("www.") ? PAGE : null),
    summarize: async () => ({ business: true, summary: "Lisbon apartments." }),
  });
  assert.equal(result.status, "read");
  assert.deepEqual(tried, ["https://acme.com/", "https://www.acme.com/"]);
});

test("no reachable site, a parked page, or a summarizer that finds no business: no site, nothing invented", async () => {
  let summarized = 0;
  const summarize = async () => (summarized++, { business: true, summary: "made up" });
  assert.deepEqual(await readWebsite("acme.com", { fetchPage: async () => null, summarize }), { status: "none" });
  assert.deepEqual(
    await readWebsite("acme.com", { fetchPage: async () => "<p>This domain is for sale</p>", summarize }),
    { status: "none" },
  );
  assert.equal(summarized, 0, "a parked or missing page never reaches the summarizer");
  assert.deepEqual(
    await readWebsite("acme.com", { fetchPage: async () => PAGE, summarize: async () => ({ business: false, summary: "x" }) }),
    { status: "none" },
  );
});

test("a fetch or summary that throws or runs past the budget is no site", async () => {
  assert.deepEqual(
    await readWebsite("acme.com", {
      fetchPage: async () => {
        throw new Error("dns");
      },
      summarize: async () => ({ business: true, summary: "x" }),
    }),
    { status: "none" },
  );
  assert.deepEqual(
    await readWebsite("acme.com", {
      fetchPage: async () => PAGE,
      summarize: async () => {
        throw new Error("llm down");
      },
    }),
    { status: "none" },
  );
  const slow = await readWebsite("acme.com", {
    fetchPage: async () => PAGE,
    summarize: () => new Promise((resolve) => setTimeout(() => resolve({ business: true, summary: "late" }), 200)),
    budgetMs: 20,
  });
  assert.deepEqual(slow, { status: "none" });
});

const READER = `Title: Acme Realty\n\nMarkdown Content:\n![Image 1](https://acme.com/a.png) ${"Acme Realty helps [expats](https://acme.com/x) rent in Lisbon. ".repeat(4)}`;

test("a reader's Markdown is plain words: no images, links kept as their text", () => {
  const text = readerText(READER);
  assert.match(text, /helps expats rent/);
  assert.doesNotMatch(text, /png|https:|\]\(/);
});

test("the reader reads the site when the host can't be reached or its page is built in JavaScript", async () => {
  const summarize = async (_: string, text: string) => (assert.match(text, /helps expats rent/), { business: true, summary: "Lisbon rentals." });
  const shell = '<title>Acme Realty - Premium Templates</title><meta name="description" content="Acme, homes for expats."><div id="root"></div>';
  for (const fetchPage of [async () => null, async () => shell]) {
    const asked: string[] = [];
    const result = await readWebsite("acme.com", { fetchPage, summarize, fetchReader: async (url) => (asked.push(url), READER) });
    assert.deepEqual(result, { status: "read", summary: "Lisbon rentals." });
    assert.deepEqual(asked, ["https://acme.com/"]);
  }
});

test("the reader is not asked when the page was read, or is parked; a reader that fails or finds nothing is no site", async () => {
  let asked = 0;
  const fetchReader = async () => (asked++, READER);
  const summarize = async () => ({ business: true, summary: "x" });
  await readWebsite("acme.com", { fetchPage: async () => PAGE, summarize, fetchReader });
  await readWebsite("acme.com", { fetchPage: async () => "<p>This domain is for sale</p>", summarize, fetchReader });
  assert.equal(asked, 0);
  const fetchPage = async () => null;
  for (const reader of [async () => null, async () => "Title: x", async () => { throw new Error("429"); }]) {
    assert.deepEqual(await readWebsite("acme.com", { fetchPage, summarize, fetchReader: reader }), { status: "none" });
  }
  const thin = `<title>Acme Realty</title><p>${"Acme Realty helps expats in Lisbon. ".repeat(4)}</p>`;
  const fromThin = await readWebsite("acme.com", {
    fetchPage: async () => thin,
    summarize: async (_, text) => ({ business: true, summary: text.slice(0, 11) }),
    fetchReader: async () => null,
  });
  assert.deepEqual(fromThin, { status: "read", summary: "Acme Realty" }, "reader down: the thin page is still read");
});

test("a pre-read is used only when it is for the claimed sender's domain", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  const read = {
    websiteDomain: "acme.com",
    websiteStatus: "read",
    websiteSummary: "Lisbon apartments.",
    websiteStartedAt: new Date(now - 90_000),
  };
  assert.deepEqual(preReadFor(read, "andres@acme.com", now), { status: "read", domain: "acme.com", summary: "Lisbon apartments." });
  assert.equal(preReadFor(read, "andres@other.com", now), null, "another sender: the normal flow reads their site");
  assert.equal(preReadFor(read, "andres@gmail.com", now), null);
  assert.equal(preReadFor(null, "andres@acme.com", now), null);
  assert.equal(preReadFor({ ...read, websiteDomain: null, websiteStatus: null, websiteSummary: null }, "andres@acme.com", now), null);

  const reading = { ...read, websiteStatus: "reading", websiteSummary: null, websiteStartedAt: new Date(now - 5_000) };
  assert.deepEqual(preReadFor(reading, "andres@acme.com", now), { status: "reading", domain: "acme.com" });
  const stuck = { ...reading, websiteStartedAt: new Date(now - 120_000) };
  assert.deepEqual(preReadFor(stuck, "andres@acme.com", now), { status: "none", domain: "acme.com" }, "a read that died never hangs the call");

  const none = { ...read, websiteStatus: "none", websiteSummary: null };
  assert.deepEqual(preReadFor(none, "andres@acme.com", now), { status: "none", domain: "acme.com" });
});

test("Voni's site lines track the real read: never a site claim before it's read, never a detail it didn't get", async () => {
  const { replySentInstructions, websiteReadyInstructions, voniConfig } = await import("./voni-agent");
  const read = { status: "read", domain: "acme.com", summary: "Acme rents Lisbon flats to expats." } as const;
  const reading = { status: "reading", domain: "acme.com" } as const;
  const none = { status: "none", domain: "acme.com" } as const;

  for (const site of [read, reading, none, null]) {
    const line = replySentInstructions(site);
    assert.match(line, /Just sent! Read me the code/, "the code ask comes first");
    assert.doesNotMatch(line, /OTP|security/, "no early reveal");
  }
  assert.match(replySentInstructions(read), /already been through acme\.com[\s\S]*Acme rents Lisbon flats to expats\./);
  assert.match(replySentInstructions(read), /only what the summary says/);
  assert.match(replySentInstructions(reading), /looking at acme\.com right now/);
  assert.match(replySentInstructions(reading), /Never say anything about their site until a note/);
  assert.doesNotMatch(replySentInstructions(reading), /already/);
  for (const site of [none, null]) {
    assert.doesNotMatch(replySentInstructions(site), /acme\.com|site/, "no site: no mention of one");
    assert.match(replySentInstructions(site), /what their business does/);
  }

  assert.match(websiteReadyInstructions(read), /just finished looking at acme\.com[\s\S]*Acme rents Lisbon flats/);
  assert.match(websiteReadyInstructions(none), /couldn't open[\s\S]*ask what they do/);
  assert.doesNotMatch(websiteReadyInstructions(none), /summary/);

  const rules = voniConfig("any").knowledge;
  assert.match(rules, /tried voice agents[\s\S]*how leads[\s\S]*brainstorm/);
  assert.match(rules, /never claim you've looked at their site before a result or a note says so/);
});

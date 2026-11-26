/**
 * The proxy card, read as source because this runner cannot render a client
 * component.
 *
 * What has to survive a future edit is visible in the file: US is a fact, not a
 * dropdown; the target is bounded where the operator types it and again on the
 * server; every save is visibly pending and reports through the toast; and the
 * three pool states the operator must tell apart are actually three branches,
 * not one "unavailable" sentence.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const card = readFileSync(join(here, "proxy-card.tsx"), "utf8");
const page = readFileSync(join(here, "../app/email/page.tsx"), "utf8");

test("US is not a choice: the form posts it, and the card says so", () => {
  assert.match(
    card,
    /<input type="hidden" name="country" value=\{PROXY_COUNTRY\} \/>/,
    "the country travels as a fixed value, not a control",
  );
  assert.doesNotMatch(
    card,
    /name="country"[^>]*<(?:Select|Input)/,
    "there is no country picker to pick wrong",
  );
  assert.doesNotMatch(card, /<Select[\s\S]{0,200}?United Kingdom/, "no alternate country is offered");
  assert.match(card, /US only/i, "the card tells the operator why there is no choice");
  assert.match(card, /PROXY_PROVIDER/, "the provider is shown, and it is the only one");
});

test("the pool target is bounded at the input and again on the server", () => {
  assert.match(card, /name="poolTarget"/);
  assert.match(card, /type="number"/);
  assert.match(card, /min=\{PROXY_POOL_MIN\}/);
  assert.match(card, /max=\{PROXY_POOL_MAX\}/);
  assert.match(card, /defaultValue=\{settings\.poolTarget\}/);
  assert.match(card, /disabled=\{saving\}/);
  assert.match(
    card,
    /Three to eight|3 (?:to|–|-)8/i,
    "the description names the accepted range",
  );
});

test("a save is visibly pending and reports through the toast", () => {
  assert.match(card, /useActionState\(action, INITIAL\)/);
  assert.match(card, /<LoadingButton/);
  assert.match(card, /pending=\{saving\}/);
  assert.match(card, /pendingText="Saving…"/);
  assert.match(card, /useActionToast\(state, "Could not save the proxy settings"/);
  assert.match(card, /successTitle: "Proxy saved"/);
});

test("client-down, short-of-exits and out-of-quota are three different stories", () => {
  // The verdict is computed once, on the server, from the health read; the card
  // must keep the three statuses separate rather than flattening them.
  for (const status of ["client-down", "short-of-exits", "out-of-quota"]) {
    assert.match(
      card,
      new RegExp(`["']?${status}["']?\\s*:`),
      `${status} has its own presentation`,
    );
  }
  assert.match(card, /verdict\.headline/);
  assert.match(card, /verdict\.detail/);
});

test("the card shows the exits, their cities, changes spent and the last failure", () => {
  assert.match(card, /reported\?\.pool \?\? \[\]/, "ready exits are read from the report");
  assert.match(card, /exit\.ip/);
  assert.match(card, /exit\.city/);
  assert.match(card, /exit\.asn/);
  assert.match(card, /bucket\.remaining/, "remaining quota per bucket");
  assert.match(card, /bucket\.limit/);
  assert.match(card, /bucket\.used/, "changes spent is the refill count the relay meters");
  assert.match(card, /bucket\.resetAt/);
  assert.match(card, /failureWords\(/, "the last failure is named in operator words");
});

test("the page renders the card with its action, and no dead locked prop", () => {
  assert.match(card, /data-testid="email-proxy-card"/);
  assert.match(page, /<ProxyCard/, "the page renders the card");
  assert.match(page, /action=\{saveProxy\}/, "the action arrives as a prop");
  assert.doesNotMatch(
    card,
    /locked/,
    "the gate renders before the card, so a locked branch would be unreachable",
  );
});

test("provenance says whether the numbers are live or came from a Segment report", () => {
  assert.match(card, /Live client/, "a live read is named as one");
  assert.match(card, /data-testid="email-proxy-provenance"/);
  assert.match(
    card,
    /Last Segment report · \$\{health\.runnerOs\}/,
    "a report names its runner OS",
  );
  assert.match(card, /proxyReportAge\(/, "a report names its age");
  assert.match(card, /"Stale report"/, "a stale report gets its own badge, not Ready");
  assert.match(card, /nothing here is live/, "a stale report says it is not live");
  assert.match(card, /Last report, not a live reading/);
});

test("a report with no bucket snapshot reads as unknown, never as 0 of 0 changes", () => {
  assert.match(card, /carries no bucket snapshot/);
  assert.doesNotMatch(card, /0 of 0 changes/);
});

test("the page reads the report-aware health and passes the request clock", () => {
  assert.match(page, /readProxyHealthOrReport\(\)/);
  assert.match(page, /now=\{now\}/, "one clock decides every age on the card");
});

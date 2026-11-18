/**
 * The affiliate click check's k6 script, built from the app's own modules so
 * the panel, the generator and the upload command cannot drift.
 *
 *   npm run affiliate:check    # writes scripts/affiliate-click-check.k6.js
 *   saveVolume()               # uploads the same text with the real secret
 *
 * k6 cannot import TypeScript, so the profile matrix, targets, providers and
 * referers are inlined as plain data. The committed file is reviewable and
 * self-contained; this module is the only thing that writes it.
 *
 * Two things are deliberately separate from the emitted text:
 *
 *   - every string that reaches the script goes through `JSON.stringify`, so a
 *     target carrying a quote cannot break the literal;
 *   - the report secret is a parameter, not an environment read. `null` emits
 *     `REPORT_SECRET_PLACEHOLDER`, which is what git holds; a string is what
 *     `saveVolume` / `npm run affiliate:upload` post, and it never touches the
 *     repository.
 *
 * The output is byte-identical for the same input: `npm run affiliate:check`
 * twice produces the same file, so a diff means a source module changed.
 */
import {
  BROWSER_FAMILIES,
  BROWSER_PROFILES,
  clientHintsFor,
  refererForProvider,
  type BrowserProfile,
} from "./user-agents";
import TARGETS_JSON from "./targets.json";
import {
  EMAIL_CAMPAIGN,
  EMAIL_MEDIUM,
  EMAIL_PROVIDERS,
  EMAIL_SOURCE_PARAM,
} from "./pool";

/**
 * What the committed generated script carries. `npm run affiliate:check`
 * writes it; the app and the upload command replace it in memory only.
 */
export const REPORT_SECRET_PLACEHOLDER = "__REPORT_SECRET__";

/**
 * What a secret may contain. The value is pasted into a JavaScript string
 * literal in the stored script, so a `"` ends the literal and a `\` starts an
 * escape: either one either breaks the script outright or changes the value,
 * which turns every report into a silent 401. The set is the URL-safe/base64
 * alphabet, which is what a generated secret already is.
 */
export const REPORT_SECRET_PATTERN = /^[A-Za-z0-9._~+/=-]{8,}$/;

/**
 * How many clicks one iteration may send. The check fires one iteration per
 * probe, so clicks/day is `probes × runs/day × clicks`. Ten is the ceiling
 * because the panel already multiplies three factors, and a save that orders
 * more than this is a load test, not an affiliate check.
 */
export const CLICKS_PER_RUN_MIN = 1;
export const CLICKS_PER_RUN_MAX = 10;

/**
 * The landing-URL rule, as source. Inlined into the emitted script and
 * evaluated by the test, so the rule is proved where it is defined.
 *
 * `finalUrl` is null whenever it would be a lie or a rejection:
 *   - status 0 is a transport failure; k6's `response.url` then echoes the
 *     request URL as if something had answered;
 *   - an empty `response.url` means the same thing;
 *   - longer than the parser's 2048-char bound (`CLICK_REPORT_MAX_TARGET_CHARS`)
 *     is a URL the row cannot store, and sending it would 400 the whole report
 *     instead of recording the click.
 */
export const REPORT_FINAL_URL_SOURCE = `/** src/lib/email/click-report.ts CLICK_REPORT_MAX_TARGET_CHARS. */
const MAX_FINAL_URL_CHARS = 2048;

function reportFinalUrl(status, url) {
  if (status === 0 || !url || url.length > MAX_FINAL_URL_CHARS) return null;
  return url;
}`;

/**
 * The report body, as k6-compatible source.
 *
 * Every field is one the parser in `src/lib/email/click-report.ts` requires or
 * accepts, and every value already fits its bound by construction: target,
 * UA, browser and source come from the generated matrix and target list, and a
 * click slower than the parser's 120 s ceiling is outside what the check can
 * observe anyway. `status` is null on a transport failure, which is the
 * parser's "no response" case; `finalUrl` comes from `reportFinalUrl` above for
 * the same reason.
 */
export const REPORT_BODY_SOURCE = `function buildReportBody(record, ranAt) {
  return {
    target: record.target,
    source: record.source,
    finalUrl: record.finalUrl,
    status: record.status,
    ms: record.ms,
    userAgent: record.userAgent,
    device: record.device,
    browser: record.browser,
    ranAt: ranAt,
  };
}`;

export type CheckScriptInput = {
  /** Clicks per iteration, 1..10. */
  clicksPerRun: number;
  /**
   * The real secret when the script is about to be uploaded; `null` for the
   * committed file, which emits the placeholder.
   */
  reportSecret: string | null;
};

/**
 * How many clicks the stored script actually sends. The panel cannot ask
 * Grafana for a count it does not model, but the script is right there in the
 * check body, so the one line that decides it is read back rather than assumed.
 * A script built before the loop existed has no constant and sends one click.
 */
export function readClicksPerRun(script: string): number {
  const match = /const CLICKS_PER_RUN = ([0-9]+);/.exec(script);
  const parsed = match ? Number(match[1]) : CLICKS_PER_RUN_MIN;
  if (
    !Number.isInteger(parsed) ||
    parsed < CLICKS_PER_RUN_MIN ||
    parsed > CLICKS_PER_RUN_MAX
  ) {
    return CLICKS_PER_RUN_MIN;
  }
  return parsed;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

function renderClientHints(profile: BrowserProfile): string {
  const entries = Object.entries(clientHintsFor(profile)).map(
    ([name, value]) => `${quote(name)}: ${quote(value)}`,
  );
  return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
}

function renderFamilies(): string {
  return BROWSER_FAMILIES.map((group) => {
    const members = group.members.map(
      (profile) =>
        `      { id: ${quote(profile.id)}, userAgent: ${quote(profile.userAgent)}, device: ${quote(profile.device)}, browser: ${quote(profile.browser)}, weight: ${round(profile.weight, 6)}, clientHints: ${renderClientHints(profile)} },`,
    );
    return [
      "  {",
      `    family: ${quote(group.family)},`,
      `    weight: ${round(group.weight, 4)},`,
      "    members: [",
      ...members,
      "    ],",
      "  },",
    ].join("\n");
  }).join("\n");
}

function renderTargets(): string {
  return TARGETS_JSON.map((target) => `  ${quote(target)},`).join("\n");
}

function renderProviders(): string {
  return EMAIL_PROVIDERS.map((provider) => `  ${quote(provider)},`).join("\n");
}

function renderReferers(): string {
  const entries = EMAIL_PROVIDERS.flatMap((provider) => {
    const referer = refererForProvider(provider);
    return referer === null ? [] : [`  ${quote(provider)}: ${quote(referer)},`];
  });
  return entries.length === 0 ? "" : entries.join("\n");
}

function assertClicksPerRun(clicksPerRun: number): void {
  if (
    !Number.isInteger(clicksPerRun) ||
    clicksPerRun < CLICKS_PER_RUN_MIN ||
    clicksPerRun > CLICKS_PER_RUN_MAX
  ) {
    throw new RangeError(
      `clicksPerRun must be an integer from ${CLICKS_PER_RUN_MIN} to ${CLICKS_PER_RUN_MAX}, got ${String(clicksPerRun)}.`,
    );
  }
}

/**
 * A secret that cannot survive the string literal would break the script or
 * silently 401 every report, and reporting is the only reason the secret is in
 * the script at all.
 */
function assertReportSecret(reportSecret: string): void {
  if (!REPORT_SECRET_PATTERN.test(reportSecret)) {
    throw new RangeError(
      "reportSecret must be at least 8 characters from [A-Za-z0-9._~+/=-]: " +
        "the value is pasted into a JavaScript string literal in the stored script.",
    );
  }
}

/**
 * One iteration's body, at the function body's own two-space indent. Kept as
 * its own string so the multi-click loop can re-indent it instead of a second
 * copy drifting from the first.
 */
function clickBody(): string {
  return `  const profile = pickProfile();
  const target = nextTarget();
  const source = nextProvider();
  const url = withUtm(target, source);

  const headers = Object.assign(
    {
      "user-agent": profile.userAgent,
      accept: ACCEPT,
      "accept-language": ACCEPT_LANGUAGE,
    },
    // Empty for Safari/Firefox, which send none of these headers.
    profile.clientHints,
  );
  const referer = REFERERS[source];
  if (referer) headers.referer = referer;

  const response = http.get(url, { headers: headers, redirects: 10 });
  check(response, {
    "status is 200-399": (result) => result.status >= 200 && result.status < 400,
  });

  // Stamp the visit, not the report: the row describes when the click
  // happened, so a slow report endpoint must not age it.
  const ranAt = new Date().toISOString();

  const record = {
    // The stamped URL, matching the one-off click's target field.
    target: url,
    source: source,
    // No answer means no landing page: response.url falls back to the request
    // URL even when nothing replied, and an oversized one is not storable.
    // Same null the simulator records.
    finalUrl: reportFinalUrl(response.status, response.url),
    // k6 reports 0 when no response arrived; the schema's null is that case.
    status: response.status === 0 ? null : response.status,
    ms: Math.round(response.timings.duration),
    userAgent: profile.userAgent,
    device: profile.device,
    browser: profile.browser,
  };
  console.log(JSON.stringify(record));

  // Reporting is a side channel: the click above already happened, so nothing
  // here may throw out of the iteration. The counters are still the verdict on
  // the endpoint — options.thresholds fails the run once report_failed is not
  // zero, which is what makes a rotated secret visible.
  if (REPORTING_ENABLED) {
    try {
      const report = http.post(
        REPORT_URL,
        JSON.stringify(buildReportBody(record, ranAt)),
        {
          headers: {
            "content-type": "application/json",
            "x-voni-click-secret": REPORT_SECRET,
            // The report is a side channel to our own API, but leaving k6's
            // default UA here means one request in the pipeline still
            // identifies itself as an HTTP client rather than a browser.
            "user-agent": record.userAgent,
          },
          tags: { phase: "report" },
          // No redirects: a 3xx would re-send the body and the secret header
          // to a host nobody reviewed. It counts as a failed report instead.
          redirects: 0,
          // Short on purpose: a healthy click must not turn red because the
          // report endpoint is slow, and a lost row is cheaper than a timeout.
          timeout: "2s",
        },
      );
      if (report.status >= 200 && report.status < 300) {
        reportOk.add(1);
      } else {
        reportFailed.add(1);
        console.warn(
          "report-back failed: HTTP " + report.status + " from " + REPORT_URL,
        );
      }
    } catch (error) {
      reportFailed.add(1);
      console.warn(
        "report-back threw: " + (error && error.message ? error.message : error),
      );
    }
  }
`;
}

function indent(body: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return body
    .split("\n")
    .map((line) => (line === "" ? line : pad + line))
    .join("\n");
}

/**
 * The one run function. At one click per run the body is emitted exactly as it
 * always was, so the committed script only changes when a source module does;
 * above one it is wrapped in a counted loop.
 */
function renderRunFunction(clicksPerRun: number): string {
  if (clicksPerRun === 1) {
    return `export default function affiliateClickCheck() {
${clickBody()}}
`;
  }
  return `export default function affiliateClickCheck() {
  for (let i = 0; i < CLICKS_PER_RUN; i++) {
${indent(clickBody(), 2)}  }
}
`;
}

/**
 * The whole script. `reportSecret === null` emits the placeholder, which is
 * what the repository holds; a string emits the real value for the upload.
 */
export function buildCheckScript({
  clicksPerRun,
  reportSecret,
}: CheckScriptInput): string {
  assertClicksPerRun(clicksPerRun);
  if (reportSecret !== null) assertReportSecret(reportSecret);

  const profileCount = BROWSER_PROFILES.length;
  const secretLiteral = reportSecret ?? REPORT_SECRET_PLACEHOLDER;

  // Only emitted when it is used: a constant nothing reads is a knob that
  // looks live but is not, and at one click the body is already a single pass.
  const clicksConstant =
    clicksPerRun > 1
      ? `\n/**
 * Clicks per iteration. Grafana fires one iteration per probe per run, so
 * clicks/day is probes x runs/day x this — the panel shows the same product.
 */
const CLICKS_PER_RUN = ${clicksPerRun};
`
      : "";

  const clicksDoc =
    clicksPerRun > 1
      ? ` * Each iteration sends ${clicksPerRun} clicks in a counted loop, drawing a\n * fresh profile, target and source for each.\n`
      : "";

  return `/**
 * Affiliate click check — GENERATED by src/lib/email/check-script.ts.
 * Do not hand-edit this file; run \`npm run affiliate:check\` instead.
 *
 * What it does: each iteration draws a browser profile from a weighted matrix
 * (family by weight, member uniformly), draws a target and a source from
 * no-repeat bags, stamps the three utm params on the target (keeping its own
 * query params), and fetches it with a browser-shaped header set — including
 * the client hints a Chromium-family profile sends — following up to ten
 * redirects. Each click logs one JSON line, then reports it back to voni.
${clicksDoc} *
 * Two run rules live in \`options\` below: DNS resolves IPv4 only, so the same
 * target is not measured over a different address family each run, and one
 * failed report fails the run, so a rotated secret cannot hide behind a green
 * check.
 *
 * Three fields mean one thing here and in the panel's one-off click, so the click
 * table has one meaning per column:
 *   target — the stamped URL that was actually visited, not the bare bag entry.
 *   finalUrl — null when the fetch never produced a response or when the URL is
 *            too long to store; k6's response.url would otherwise echo the
 *            request URL as if it had landed.
 *   status — null when the fetch never produced a response. k6 reports 0 for a
 *            transport failure, and the report schema stores that as null, so a
 *            failed click is recorded instead of rejected.
 *
 * This generates REAL affiliate clicks: every iteration sends production
 * traffic to the targets in src/lib/email/targets.json. It is a live load
 * check, not a mock.
 *
 * Matrix: ${profileCount} profiles across ${BROWSER_FAMILIES.length} families, mirrored inline from
 * src/lib/email/user-agents.ts (k6 cannot import TypeScript).
 *
 * Report-back: ON only in the script uploaded to Grafana. Grafana's scripted
 * checks have no way to set __ENV__, so REPORT_URL and REPORT_SECRET are
 * constants here — and this committed file deliberately carries the
 * placeholder, not the secret. \`npm run affiliate:upload\` and the panel's
 * save swap the placeholder for EMAIL_CLICK_REPORT_SECRET in memory and post
 * the result; nothing in the repository ever holds the real value. Run this
 * file locally and it clicks without reporting, and says so once.
 *
 * Usage:
 *   k6 run --vus 1 --iterations 1 scripts/affiliate-click-check.k6.js
 *   k6 run --vus 10 --iterations 200 scripts/affiliate-click-check.k6.js
 */
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

/**
 * The run's own rules, both of which a green run depends on:
 *
 *   dns.policy "onlyIPv4" — every lookup answers A records only. The check
 *     exists to measure one landing page, and k6's default policy takes
 *     whichever address the agent's resolver returns first: the same target
 *     would then be IPv4 in one run and IPv6 in the next, and the two numbers
 *     would describe different servers.
 *   thresholds.report_failed "count==0" — not one failed report is allowed.
 *     Reporting is a side channel for the click, but the secret is a side
 *     channel for the data: with a rotated secret every POST answers 401 and,
 *     without this threshold, the run still finishes green. A run with
 *     reporting disabled never increments the counter, so this stays green.
 */
export const options = {
  dns: { policy: "onlyIPv4" },
  thresholds: { report_failed: ["count==0"] },
};

/** Same headers the app's click simulator sends (src/lib/email/click-simulator.ts). */
const ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
const ACCEPT_LANGUAGE = "en-US,en;q=0.9";

const EMAIL_SOURCE_PARAM = ${quote(EMAIL_SOURCE_PARAM)};
const EMAIL_MEDIUM = ${quote(EMAIL_MEDIUM)};
const EMAIL_CAMPAIGN = ${quote(EMAIL_CAMPAIGN)};
${clicksConstant}
/** src/lib/email/targets.json — production URLs. */
const TARGETS = [
${renderTargets()}
];

/** src/lib/email/pool.ts EMAIL_PROVIDERS. */
const PROVIDERS = [
${renderProviders()}
];

/**
 * src/lib/email/user-agents.ts PROVIDER_REFERERS, narrowed to the providers
 * above. A provider absent here sends no Referer header at all.
 */
const REFERERS = {
${renderReferers()}
};

/**
 * The weighted profile matrix from src/lib/email/user-agents.ts. Weights are
 * approximations of market share (see the module header); family picks then
 * member picks keep the distribution family-shaped instead of flattening 60
 * strings into one uniform draw.
 */
const FAMILIES = [
${renderFamilies()}
];

/**
 * Report target and secret. Constants, not __ENV: Grafana's scripted checks
 * give the script no environment to read, and a value read at run time could
 * not be injected without editing the check by hand.
 */
const REPORT_URL = "https://voni.cc/api/email/clicks/report";
/**
 * The committed file carries the placeholder on purpose. Reporting is enabled
 * only in the copy the panel or \`npm run affiliate:upload\` posts, where the
 * placeholder is replaced with EMAIL_CLICK_REPORT_SECRET in memory.
 */
const REPORT_SECRET = ${quote(secretLiteral)};
const REPORTING_ENABLED =
  REPORT_SECRET !== "" && REPORT_SECRET !== ${quote(REPORT_SECRET_PLACEHOLDER)};

/** A broken endpoint must be visible in the run, not silent: see options. */
const reportOk = new Counter("report_ok");
const reportFailed = new Counter("report_failed");

/** One line per run, not per click: the click still happens. */
export function setup() {
  if (!REPORTING_ENABLED) {
    console.log(
      "report-back disabled: REPORT_SECRET is the placeholder (run npm run affiliate:upload to enable it)",
    );
  }
}

/**
 * One weighted draw. Weights are relative shares; the fallback returns the last
 * entry for float drift at the end of the range.
 */
function pickWeighted(items) {
  let total = 0;
  for (let index = 0; index < items.length; index += 1) {
    total += items[index].weight;
  }
  let value = Math.random() * total;
  for (let index = 0; index < items.length; index += 1) {
    value -= items[index].weight;
    if (value < 0) return items[index];
  }
  return items[items.length - 1];
}

function pickProfile() {
  const family = pickWeighted(FAMILIES);
  return pickWeighted(family.members);
}

/**
 * Draw without replacement: every entry appears once per pass, in its own
 * shuffled order, then the bag refills. Same shape as shuffleBag in
 * src/lib/email/pool.ts. k6 gives each VU its own module instance, so each VU
 * starts with its own shuffle.
 */
function shuffleBag(items) {
  let order = [];
  let cursor = 0;
  return function next() {
    if (cursor >= order.length) {
      order = items.slice();
      for (let index = order.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(Math.random() * (index + 1));
        const held = order[index];
        order[index] = order[swap];
        order[swap] = held;
      }
      cursor = 0;
    }
    const value = order[cursor];
    cursor += 1;
    return value;
  };
}

const nextTarget = shuffleBag(TARGETS);
const nextProvider = shuffleBag(PROVIDERS);

/** Set one query key, preserving every other param (and any #fragment). */
function setParam(query, key, value) {
  const encoded = key + "=" + encodeURIComponent(value);
  const parts = query === "" ? [] : query.split("&");
  const kept = [];
  let replaced = false;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === "") continue;
    if (part.split("=")[0] === key) {
      if (!replaced) {
        kept.push(encoded);
        replaced = true;
      }
      continue;
    }
    kept.push(part);
  }
  if (!replaced) kept.push(encoded);
  return kept.join("&");
}

/** Stamp attribution on an absolute target without dropping its own query. */
function withUtm(target, source) {
  const hashIndex = target.indexOf("#");
  const hash = hashIndex === -1 ? "" : target.slice(hashIndex);
  const base = hashIndex === -1 ? target : target.slice(0, hashIndex);
  const queryIndex = base.indexOf("?");
  const origin = queryIndex === -1 ? base : base.slice(0, queryIndex);
  let query = queryIndex === -1 ? "" : base.slice(queryIndex + 1);
  query = setParam(query, EMAIL_SOURCE_PARAM, source);
  query = setParam(query, "utm_medium", EMAIL_MEDIUM);
  query = setParam(query, "utm_campaign", EMAIL_CAMPAIGN);
  return origin + "?" + query + hash;
}

/**
 * The landing-URL rule and the one JSON row one click reports. Their source
 * lives in this module so the test can evaluate the same text and hand it to
 * the real parser; inlined here because k6 cannot import TypeScript.
 *
 * Every value fits the parser's bounds by construction: target, source and the
 * browser strings come from the generated data, a click slower than the
 * parser's 120 s ceiling is outside what this check can observe, and a landing
 * URL longer than the parser accepts is reported as null instead.
 */
${REPORT_FINAL_URL_SOURCE}

${REPORT_BODY_SOURCE}

${renderRunFunction(clicksPerRun)}`;
}

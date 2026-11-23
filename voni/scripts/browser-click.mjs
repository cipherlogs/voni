#!/usr/bin/env node
/**
 * Real Chrome, clicking the `/email` target list from a GitHub runner.
 *
 * Why a browser at all: Grafana proves the target answers an HTTP request. This
 * proves a click survives page JavaScript, cookies and whatever bot filter the
 * affiliate runs — which is the only thing the GitHub source claims that
 * Grafana does not.
 *
 * The contract, in order:
 *
 *   - Chrome is launched ONCE for the whole segment. A launch per click would
 *     spend the interval on process start and make a cold profile look like a
 *     unique visitor.
 *   - Every click gets a FRESH browser context, so cookies, storage and the
 *     cache never leak from one target to the next. One context reused is one
 *     long-lived session across four different sites, which is not a visitor.
 *   - Per pass, the dispatched list is shuffled and ALL of it is clicked. The
 *     interval then paces the next pass with drift correction: a slow pass is
 *     absorbed, not allowed to push every later pass later.
 *   - Which target and which claimed email provider come from the app's own
 *     modules (`pool.ts`, `user-agents.ts`) through tsx. This file carries no
 *     copy of the utm stamping or the profile table, so the browser path cannot
 *     drift from the Grafana and one-off paths.
 *   - A click that fails saves a screenshot and the pass continues. Only at the
 *     end does the run fail, naming every target the FINAL pass could not
 *     complete and every click whose report was not stored.
 *
 * The report secret is read from the environment and only ever placed in a
 * request header. Nothing here prints, logs, or serialises it.
 */

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { chromium } from "@playwright/test";

import {
  nextEmailProvider,
  resolveTarget,
} from "../src/lib/email/pool.ts";
import {
  clientHintsFor,
  pickBrowserProfile,
  refererForProvider,
} from "../src/lib/email/user-agents.ts";
import {
  INTERVAL_SECONDS,
  MAX_JOB_SECONDS,
} from "../src/lib/email/sources.ts";
import { redactProxyText } from "./browser-proxy-redaction.mjs";

/** The one intake both producers write through. */
const REPORT_URL = "https://voni.cc/api/email/clicks/report";
const REPORT_SECRET_ENV = "EMAIL_CLICK_REPORT_SECRET";

/** The runner OSes the intake stores; anything else is refused there anyway. */
const RUNNER_OS_VALUES = ["ubuntu", "windows", "macos"];

/**
 * The schedule domain's interval set and job cap, imported rather than copied:
 * a value the panel offers must be one this script honours, and the segment
 * ceiling lives in `sources.ts` alone.
 */
const MIN_INTERVAL_SECONDS = INTERVAL_SECONDS[0];
const MAX_INTERVAL_SECONDS = INTERVAL_SECONDS[INTERVAL_SECONDS.length - 1];
const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_WINDOW_SECONDS = 12 * 3_600;

const NAVIGATION_TIMEOUT_MS = 30_000;
/** Let deferred page scripts run before the final URL is read. */
const SETTLE_MS = 1_000;
const REPORT_TIMEOUT_MS = 10_000;
/** The intake refuses a larger `ms`, so clamp rather than lose the row. */
const MAX_REPORTED_MS = 120_000;
/** The intake stops reading a body past 4096 bytes. */
const MAX_REPORT_BYTES = 4_000;
const SCREENSHOT_DIR = "screenshots";

function stop(message) {
  console.error(`browser-click: ${message}`);
  process.exit(2);
}

function readEnv(name) {
  const raw = process.env[name];
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
}

function parseSeconds(name, raw, fallback, min, max) {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    stop(`${name} must be a whole number of seconds, got ${JSON.stringify(raw)}`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    stop(`${name} must be between ${min} and ${max} seconds, got ${value}`);
  }
  return value;
}

function parseTargets(raw) {
  if (raw === undefined) {
    stop("BROWSER_CHECK_TARGETS is empty: there is nothing to click");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    stop("BROWSER_CHECK_TARGETS is not valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    stop("BROWSER_CHECK_TARGETS must be a non-empty JSON array of URLs");
  }
  for (const entry of parsed) {
    if (typeof entry !== "string") {
      stop("BROWSER_CHECK_TARGETS must contain only strings");
    }
    let url;
    try {
      url = new URL(entry);
    } catch {
      stop(`not an absolute URL: ${entry}`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      stop(`not an http(s) URL: ${entry}`);
    }
  }
  return parsed;
}

/** The proxy schemes Playwright can drive for a whole browser. */
const PROXY_PROTOCOLS = ["http:", "https:", "socks5:"];

/**
 * The optional egress proxy. This is the only supported way to click from a
 * non-datacenter address: GitHub-hosted runners share a small Azure pool, and
 * rotating the User-Agent changes a header, not the IP or ASN an affiliate
 * sees. Unset server means no proxy at all, which is the pre-proxy behaviour.
 *
 * Nothing here is ever echoed: a proxy URL may carry `user:pass@`, so a refusal
 * names the variable, never the value, and the returned object is handed to
 * Playwright only (never logged, never reported).
 */
function readProxy() {
  const server = readEnv("BROWSER_PROXY_SERVER");
  const username = readEnv("BROWSER_PROXY_USERNAME");
  const password = readEnv("BROWSER_PROXY_PASSWORD");

  if (server === undefined) {
    if (username !== undefined || password !== undefined) {
      stop(
        "BROWSER_PROXY_USERNAME/BROWSER_PROXY_PASSWORD are set but BROWSER_PROXY_SERVER is not: " +
          "credentials without a proxy would be silently ignored",
      );
    }
    return undefined;
  }

  let url;
  try {
    url = new URL(server);
  } catch {
    stop(
      "BROWSER_PROXY_SERVER is malformed: it must be an absolute proxy URL " +
        `with one of ${PROXY_PROTOCOLS.join(", ")} and a host, e.g. http://proxy.example.com:8080`,
    );
  }
  if (!PROXY_PROTOCOLS.includes(url.protocol) || url.hostname === "") {
    stop(
      `BROWSER_PROXY_SERVER must use one of ${PROXY_PROTOCOLS.join(", ")} and name a host`,
    );
  }

  if ((username === undefined) !== (password === undefined)) {
    stop(
      "BROWSER_PROXY_USERNAME and BROWSER_PROXY_PASSWORD must be set together, or neither",
    );
  }

  // `server` without credentials is Playwright's plain-proxy shape; adding a
  // username without a password would send an empty credential instead of none.
  return username === undefined
    ? { server }
    : { server, username, password };
}

function readConfig() {
  const rawOs = (readEnv("BROWSER_CHECK_OS") ?? process.env.RUNNER_OS ?? "")
    .trim()
    .toLowerCase();
  if (!RUNNER_OS_VALUES.includes(rawOs)) {
    stop(
      `BROWSER_CHECK_OS must be one of ${RUNNER_OS_VALUES.join(", ")}, got ${JSON.stringify(rawOs)}`,
    );
  }

  const secret = readEnv(REPORT_SECRET_ENV);
  if (secret === undefined) {
    stop(`${REPORT_SECRET_ENV} is not set on this runner`);
  }

  return {
    os: rawOs,
    targets: parseTargets(readEnv("BROWSER_CHECK_TARGETS")),
    intervalSeconds: parseSeconds(
      "BROWSER_CHECK_INTERVAL",
      readEnv("BROWSER_CHECK_INTERVAL"),
      DEFAULT_INTERVAL_SECONDS,
      MIN_INTERVAL_SECONDS,
      MAX_INTERVAL_SECONDS,
    ),
    windowSeconds: parseSeconds(
      "BROWSER_CHECK_WINDOW",
      readEnv("BROWSER_CHECK_WINDOW"),
      DEFAULT_WINDOW_SECONDS,
      1,
      MAX_JOB_SECONDS,
    ),
    // Only ever written into a header by `postReport`. Never logged.
    secret,
    // Handed to Playwright's launch only. Unset = no proxy.
    proxy: readProxy(),
  };
}

function shuffled(items) {
  const order = [...items];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** Playwright's error text carries a multi-line call log; the reason is its first line. */
function firstLine(message) {
  return message.split("\n")[0].trim();
}

function viewportFor(device) {
  if (device === "mobile") return { width: 390, height: 844 };
  if (device === "tablet") return { width: 820, height: 1_180 };
  return { width: 1_440, height: 900 };
}

function screenshotName(target) {
  let host = "target";
  try {
    host = new URL(target).hostname;
  } catch {
    // The target was validated before the browser started.
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(
    SCREENSHOT_DIR,
    `${stamp}-${host.replace(/[^a-zA-Z0-9.-]/g, "_")}.png`,
  );
}

/**
 * Post one click to the intake. A failure here is reported like a click
 * failure: the run must not exit green when the row never landed.
 */
async function postReport(report, secret) {
  let body = JSON.stringify(report);
  if (Buffer.byteLength(body) > MAX_REPORT_BYTES) {
    // A long redirect chain can push the body past the intake's cap. The click
    // still happened, so drop the optional final URL rather than lose the row.
    body = JSON.stringify({ ...report, finalUrl: null });
  }

  try {
    const response = await fetch(REPORT_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-voni-click-secret": secret,
      },
      body,
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      cache: "no-store",
    });
    if (response.ok) return { ok: true };
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      detail: `HTTP ${response.status}${text === "" ? "" : ` ${text.slice(0, 120)}`}`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * One click: a fresh context, the profile and provider the app would claim,
 * the observed status, URL and duration, and a screenshot when it failed.
 */
async function clickOnce(browser, target, config, passId) {
  const source = nextEmailProvider();
  const visited = resolveTarget(target, source);
  const profile = pickBrowserProfile();
  const referer = refererForProvider(source) ?? undefined;

  const context = await browser.newContext({
    userAgent: profile.userAgent,
    locale: "en-US",
    viewport: viewportFor(profile.device),
    // Chromium sends these as part of a top-level navigation; a Chrome UA
    // without them is exactly what a bot filter looks for first.
    extraHTTPHeaders: clientHintsFor(profile),
  });

  try {
    const page = await context.newPage();
    const startedAt = Date.now();
    const ranAt = new Date(startedAt).toISOString();
    let status = null;
    let finalUrl = null;
    let failure = null;

    try {
      const response = await page.goto(visited, {
        referer,
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      status = response === null ? null : response.status();
      // Give deferred page scripts their moment before the final URL is read:
      // a client-side redirect is exactly what a browser proves and fetch cannot.
      await page.waitForTimeout(SETTLE_MS);
      finalUrl = page.url() || null;
      if (status === null) failure = "no response";
      else if (status >= 400) failure = `HTTP ${status}`;
    } catch (error) {
      failure = firstLine(error instanceof Error ? error.message : String(error));
      finalUrl = page.url() || null;
    }

    const ms = Math.min(Date.now() - startedAt, MAX_REPORTED_MS);

    let screenshot = null;
    if (failure !== null) {
      screenshot = screenshotName(target);
      try {
        await page.screenshot({ path: screenshot });
      } catch {
        screenshot = null;
      }
    }

    const posted = await postReport(
      {
        // The stamped URL is what was visited, and what the click table stores.
        target: visited,
        source,
        finalUrl,
        status,
        ms,
        userAgent: profile.userAgent,
        device: profile.device,
        browser: profile.browser,
        producer: "github",
        runnerOs: config.os,
        // The same id for every click of this pass, including a failed one:
        // coverage is measured over the pass, not over the clicks that worked.
        passId,
        ranAt,
      },
      config.secret,
    );

    return {
      target,
      responded: status !== null,
      failure,
      screenshot,
      posted,
      status,
      ms,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

function describe(result) {
  const status = result.status === null ? "no status" : String(result.status);
  const verdict = result.failure === null ? "ok" : `failed (${result.failure})`;
  const shot = result.screenshot === null ? "" : ` screenshot=${result.screenshot}`;
  return `${verdict} ${status} ${result.ms}ms${shot}`;
}

async function main() {
  const config = readConfig();
  console.log(
    `browser-click: os=${config.os} targets=${config.targets.length} ` +
      `interval=${config.intervalSeconds}s window=${config.windowSeconds}s ` +
      `proxy=${config.proxy === undefined ? "off" : "on"}`,
  );

  await mkdir(SCREENSHOT_DIR, { recursive: true });

  // The proxy, when configured, is the segment's egress address: one launch
  // option for the whole run. The credentials live in this object only.
  const launchOptions = { channel: "chrome", headless: true };
  if (config.proxy !== undefined) launchOptions.proxy = config.proxy;

  let browser;
  try {
    browser = await chromium.launch(launchOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The launch options hold the proxy, and Playwright may quote them. A
    // failure is still a failure (exit 2 below), but never a credential leak.
    stop(
      `could not launch real Chrome (${redactProxyText(message, config.proxy)}); ` +
        "the runner installs it with `npx playwright install --with-deps chrome`",
    );
  }

  // Each pass measures itself. A later pass recovering a target must not erase
  // the earlier pass's miss, and the job's verdict is the FINAL pass's: that is
  // the one the card's `targets x/x` will show.
  let finalPassMisses = new Map();
  // Every click whose report never landed, for the whole segment. A report is a
  // row; a later success does not un-lose one that was not stored.
  const unreported = [];
  const startedAt = Date.now();
  const deadline = startedAt + config.windowSeconds * 1_000;
  let nextPassAt = startedAt;
  let passes = 0;

  try {
    while (Date.now() < deadline) {
      passes += 1;
      const passId = randomUUID();
      const order = shuffled(config.targets);
      const attempted = [];
      const responded = new Set();
      const passMisses = new Map();
      let reported = 0;

      for (const target of order) {
        if (Date.now() >= deadline) break;
        attempted.push(target);
        console.log(`browser-click: pass ${passes} click ${target}`);
        const result = await clickOnce(browser, target, config, passId);
        console.log(`browser-click: pass ${passes} ${describe(result)}`);
        if (result.responded) {
          responded.add(target);
        } else {
          passMisses.set(target, result.failure ?? "no response");
        }
        if (result.posted.ok) {
          reported += 1;
        } else {
          unreported.push({
            target,
            pass: passes,
            detail: result.posted.detail,
          });
        }
      }

      // Coverage is a property of the pass, so it is checked here rather than
      // assumed: a pass that clicked three of four says so now, and the run
      // still exits non-zero at the end.
      console.log(
        `browser-click: pass ${passes}: ${responded.size}/${attempted.length} responded, ` +
          `${reported}/${attempted.length} reported`,
      );
      for (const target of attempted) {
        if (responded.has(target)) continue;
        console.error(
          `browser-click: pass ${passes} no response from ${target}`,
        );
      }
      finalPassMisses = attempted.length > 0 ? passMisses : finalPassMisses;

      // Drift correction: the next pass is due `interval` after this one
      // STARTED. A pass that overran starts the next immediately instead of
      // pushing every later pass back by the overrun.
      nextPassAt += config.intervalSeconds * 1_000;
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        const wait = Math.min(Math.max(nextPassAt - Date.now(), 0), remaining);
        if (wait > 0) await sleep(wait);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const ranFor = Math.round((Date.now() - startedAt) / 1_000);
  console.log(`browser-click: ${passes} pass(es) in ${ranFor}s`);

  if (unreported.length > 0) {
    for (const { target, pass, detail } of unreported) {
      console.error(
        `browser-click: report not stored for ${target} (pass ${pass}: ${detail})`,
      );
    }
  }
  if (finalPassMisses.size > 0) {
    for (const [target, reason] of finalPassMisses) {
      console.error(
        `browser-click: final pass no response from ${target} (${reason})`,
      );
    }
  }

  if (unreported.length > 0 || finalPassMisses.size > 0) {
    const missed = new Set([
      ...finalPassMisses.keys(),
      ...unreported.map(({ target }) => target),
    ]);
    console.error(
      `browser-click: ${missed.size} target(s) did not complete: ${[...missed].join(", ")}`,
    );
    process.exit(1);
  }

  console.log("browser-click: every dispatched target responded and was stored");
}

main().catch((error) => {
  console.error(
    `browser-click: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});

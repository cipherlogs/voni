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
 *     When the exit pool is running, the context is also where its exit is
 *     bound: the same Chrome process, a different address per click.
 *   - A Click takes its exit from the pool over the client's loopback control
 *     API: acquire, open the context through that exit's SOCKS port, click,
 *     release good or failed. The run log prints the address the row stores.
 *     The manual `BROWSER_PROXY_*` override stays available for an emergency
 *     and is refused outright when the pool is configured, because silently
 *     preferring one over the other is the leak this path exists to prevent.
 *     With neither, a click is direct, as it was before the pool.
 *   - QUIC and non-proxied WebRTC are disabled at launch: each is a path around
 *     the proxy that survives an otherwise correct per-context setting.
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
import {
  TARGET_SELECTION_DEFAULT,
  parseTargetSelection,
} from "../src/lib/email/target-selection.ts";
import {
  acquireExit,
  parseControlUrl,
  releaseExit,
} from "./browser-exit-pool.mjs";
import { exitContextProxy, launchOptionsFor } from "./browser-egress.mjs";
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
 * Nothing here is ever echoed: a proxy URL may carry inline credentials, so a refusal
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

/**
 * The egress mode, in the three names the intake stores and the startup line
 * prints. A pooled Click that got no exit is still `pool`: the mode is what the
 * Click was configured to leave from, and the row's `failureReason` says that
 * no exit arrived.
 */
function egressKind(config) {
  return config.poolUrl !== undefined ? "pool" : config.proxy === undefined ? "none" : "manual";
}

/**
 * The client's loopback control address; unset means the pool is off. The
 * address is refused here rather than at the first Click: a segment that
 * started with a mistyped URL would click for hours with a failure per target.
 */
function readPool() {
  const raw = readEnv("TUXLER_CONTROL_URL");
  if (raw === undefined) return undefined;
  const parsed = parseControlUrl(raw);
  if (!parsed.ok) stop(`TUXLER_CONTROL_URL ${parsed.reason}`);
  return parsed.url;
}

/**
 * The rotation mode is one stored setting, dispatched as an input and passed to
 * every producer. The runner reads it, it never chooses it; an unknown value is
 * a refusal, not a quiet fall back to a default nobody selected.
 */
function readSelection() {
  const raw = readEnv("BROWSER_CHECK_SELECTION") ?? TARGET_SELECTION_DEFAULT;
  const selection = parseTargetSelection(raw);
  if (selection === null) {
    stop(
      `BROWSER_CHECK_SELECTION must be one of random, rotate, got ${JSON.stringify(raw)}`,
    );
  }
  return selection;
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

  const proxy = readProxy();
  const poolUrl = readPool();
  if (poolUrl !== undefined && proxy !== undefined) {
    // Two ways to choose an address is no way to know which one a Click used.
    // Refuse before Chrome starts rather than letting one silently win.
    stop(
      "TUXLER_CONTROL_URL selects the exit pool and BROWSER_PROXY_SERVER is a manual override: " +
        "a pooled run must have BROWSER_PROXY_SERVER, BROWSER_PROXY_USERNAME and BROWSER_PROXY_PASSWORD empty, " +
        "or the pool must be off; the override is never preferred in silence",
    );
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
    // The manual override, handed to Playwright's launch only. Unset = none.
    proxy,
    // The pool's loopback control address; unset = no pool.
    poolUrl,
    // One stored setting, shared with Grafana. Never a runner-local flag.
    selection: readSelection(),
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

/**
 * Everything a context must report besides its User-Agent. A phone with a
 * desktop DOM (no touch, one device pixel per CSS pixel, a 1440px window) is a
 * contradiction a client-side filter can read in one line of JavaScript, so the
 * device class decides all of these together and the UA decides none of them.
 */
function contextOptionsFor(profile) {
  const viewport = viewportFor(profile.device);
  if (profile.device === "mobile") {
    return { viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
  }
  if (profile.device === "tablet") {
    return { viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
  }
  return { viewport, isMobile: false, hasTouch: false, deviceScaleFactor: 1 };
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
 * The identity and the stamped URL a click would present. Planned before the
 * exit is taken, so a Click the pool cannot serve still records the target it
 * meant to visit — with the same provider draw and profile a served click got.
 */
function planVisit(target) {
  const source = nextEmailProvider();
  return {
    target,
    source,
    visited: resolveTarget(target, source),
    profile: pickBrowserProfile(),
    referer: refererForProvider(source) ?? undefined,
  };
}

/** What every row says about the egress: which address, and which kind. */
function attributionOf(config, exit) {
  return {
    exitIp: exit === undefined ? null : exit.ip,
    exitCountry: exit === undefined ? null : exit.country,
    exitAsn: exit === undefined ? null : exit.asn,
    proxyKind: egressKind(config),
  };
}

/**
 * A Click that never opened a page: the pool had no US exit, the context could
 * not be created through its exit, or the pass's exit was lost. The row keeps
 * the target, the pass and the reason, and claims no status — no row says a
 * page answered when none did.
 */
async function reportUnavailable(target, config, passId, reason, detail, exit, planned) {
  const visit = planned ?? planVisit(target);
  const ranAt = new Date().toISOString();
  const posted = await postReport(
    {
      target: visit.visited,
      source: visit.source,
      finalUrl: null,
      status: null,
      ms: null,
      userAgent: visit.profile.userAgent,
      device: visit.profile.device,
      browser: visit.profile.browser,
      producer: "github",
      runnerOs: config.os,
      passId,
      ...attributionOf(config, exit),
      failureReason: reason,
      ranAt,
    },
    config.secret,
  );

  return {
    target,
    responded: false,
    failure: detail ?? reason,
    failureReason: reason,
    screenshot: null,
    posted,
    status: null,
    ms: null,
    exitIp: exit === undefined ? null : exit.ip,
    exitCountry: exit === undefined ? null : exit.country,
    exitAsn: exit === undefined ? null : exit.asn,
  };
}

/**
 * One click: a fresh context through the exit it was given, the profile and
 * provider the app would claim, the observed status, URL and duration, and a
 * screenshot when it failed. The exit is acquired and released by the caller;
 * this function only uses it, so a rotate pass can hold one across Targets.
 */
async function clickOnce(browser, target, config, passId, exit) {
  const visit = planVisit(target);
  const { source, visited, profile, referer } = visit;
  const ranAt = new Date().toISOString();

  const contextOptions = {
    userAgent: profile.userAgent,
    locale: "en-US",
    // Touch, DPR and viewport follow the device class, not the UA alone.
    ...contextOptionsFor(profile),
    // Chromium sends these as part of a top-level navigation; a Chrome UA
    // without them is exactly what a bot filter looks for first.
    extraHTTPHeaders: clientHintsFor(profile),
  };
  // The exit belongs to this context, not to the launch: the next Click may
  // leave from a different address without restarting Chrome.
  Object.assign(contextOptions, exitContextProxy(exit));

  let context;
  try {
    context = await browser.newContext(contextOptions);
  } catch (error) {
    // No page was opened, so no status can be claimed. The exit (or the browser
    // around it) is the suspect, and the caller gives it a strike.
    return reportUnavailable(
      target,
      config,
      passId,
      "exit-unavailable",
      firstLine(error instanceof Error ? error.message : String(error)),
      exit,
      visit,
    );
  }

  try {
    const page = await context.newPage();
    const startedAt = Date.now();
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
        ...attributionOf(config, exit),
        failureReason: null,
        ranAt,
      },
      config.secret,
    );

    return {
      target,
      responded: status !== null,
      failure,
      failureReason: null,
      screenshot,
      posted,
      status,
      ms,
      exitIp: exit === undefined ? null : exit.ip,
      exitCountry: exit === undefined ? null : exit.country,
      exitAsn: exit === undefined ? null : exit.asn,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

function describe(result) {
  const status = result.status === null ? "no status" : String(result.status);
  const verdict = result.failure === null ? "ok" : `failed (${result.failure})`;
  const exit =
    result.exitIp === null
      ? ""
      : ` exit=${result.exitIp} asn=${result.exitAsn} country=${result.exitCountry}`;
  const reason = result.failureReason === null ? "" : ` reason=${result.failureReason}`;
  const shot = result.screenshot === null ? "" : ` screenshot=${result.screenshot}`;
  const ms = result.ms === null ? "-" : `${result.ms}ms`;
  return `${verdict} ${status} ${ms}${exit}${reason}${shot}`;
}

async function main() {
  const config = readConfig();
  console.log(
    `browser-click: os=${config.os} targets=${config.targets.length} ` +
      `interval=${config.intervalSeconds}s window=${config.windowSeconds}s ` +
      `proxy=${egressKind(config)} selection=${config.selection}`,
  );

  await mkdir(SCREENSHOT_DIR, { recursive: true });

  // The manual override, when configured, is the segment's egress address: one
  // launch option for the whole run. A pooled segment puts its proxy on each
  // context instead, and the two are refused together above.
  //
  // The launch flags come from `browser-egress.mjs` so the leak check launches
  // Chrome with the same QUIC and WebRTC settings: each flag is a path around
  // the proxy, and a Click whose address is not its exit is a leak.
  const launchOptions = launchOptionsFor({ proxy: config.proxy });

  // Chrome starts on the first Click that has an egress (or immediately when no
  // pool is configured). A pool that never supplies an exit therefore leaves no
  // browser running without a proxy, and a segment that never gets an exit does
  // not pay for a browser it cannot use.
  let browser = null;
  const browserFor = async () => {
    if (browser !== null) return browser;
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
    return browser;
  };

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
      const usePool = config.poolUrl !== undefined;
      const rotate = config.selection === "rotate";

      // rotate: one exit for the whole Target list, so the pass looks like one
      // visitor. random: the next ready exit per Target, so the sweep looks like
      // many. Without a pool the launch-level override (or no proxy) is used.
      let passExit;
      let passAcquireFailure = null;
      if (usePool && rotate) {
        const taken = await acquireExit(config.poolUrl);
        if (taken.ok) passExit = taken.exit;
        else passAcquireFailure = taken;
      }
      let passFailed = false;

      for (const target of order) {
        if (Date.now() >= deadline) break;
        attempted.push(target);
        console.log(`browser-click: pass ${passes} click ${target}`);

        let result;
        if (!usePool) {
          result = await clickOnce(await browserFor(), target, config, passId, undefined);
        } else if (rotate) {
          if (passExit === undefined) {
            result = await reportUnavailable(
              target,
              config,
              passId,
              passAcquireFailure === null ? "exit-unavailable" : passAcquireFailure.reason,
              passAcquireFailure === null
                ? "the pass's exit was lost before this target"
                : passAcquireFailure.detail,
              undefined,
            );
          } else {
            result = await clickOnce(await browserFor(), target, config, passId, passExit);
            // An exit whose context could not be opened is not reused for the
            // rest of the pass, and it is given back at once: the pass fails
            // loudly instead of substituting another address.
            if (result.failureReason === "exit-unavailable") {
              const released = await releaseExit(config.poolUrl, passExit.exitId, "failed");
              if (!released.ok) {
                console.error(
                  `browser-click: exit ${passExit.exitId} was not released (${released.detail})`,
                );
              }
              passExit = undefined;
            }
            if (result.failure !== null) passFailed = true;
          }
        } else {
          const taken = await acquireExit(config.poolUrl);
          if (!taken.ok) {
            // No browser context, and no row claiming a response: the target is
            // named as failed with the pool's own reason.
            result = await reportUnavailable(
              target,
              config,
              passId,
              taken.reason,
              taken.detail,
              undefined,
            );
          } else {
            result = await clickOnce(await browserFor(), target, config, passId, taken.exit);
            const released = await releaseExit(
              config.poolUrl,
              taken.exit.exitId,
              result.failure === null ? "good" : "failed",
            );
            if (!released.ok) {
              console.error(
                `browser-click: exit ${taken.exit.exitId} was not released (${released.detail})`,
              );
            }
          }
        }

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

      // The pass's exit goes back once: good when every Click in it succeeded,
      // failed when any did not, so two bad passes kill an exit.
      if (usePool && rotate && passExit !== undefined) {
        const released = await releaseExit(
          config.poolUrl,
          passExit.exitId,
          passFailed ? "failed" : "good",
        );
        if (!released.ok) {
          console.error(
            `browser-click: exit ${passExit.exitId} was not released (${released.detail})`,
          );
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
    if (browser !== null) await browser.close().catch(() => {});
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

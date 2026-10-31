import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { expect, test, type Page } from "@playwright/test";

import { evaluateTriggers } from "../../src/lib/demo/verification/scenarios/triggers";
import type { AgentTimelineEvent } from "../../src/lib/demo/verification/scenarios/types";
import {
  installSyntheticMic,
  readSyntheticMicReport,
  type SyntheticMicTake,
} from "../../scripts/lib/browser-adapter/synthetic-mic";

/**
 * The browser adapter's one Playwright spec: a certifying call on the real
 * stack.
 *
 * A real Chromium opens the public landing page, the harness replaces
 * `getUserMedia` with a synthetic stream before app code runs, the page mints a
 * real token and runs the real client, pipeline and vendor legs. The spec
 * reads the marks and delivered WAV the app wrote, plays the scenario's caller
 * takes at the trigger points it observes in the visitor's UI, and writes one
 * report. It never intercepts a route, a socket or the mint; a fake service here
 * would make the run a diagnosis, not a certification.
 *
 * The runner (scripts/lib/browser-adapter) owns the scenario, the verdict and
 * every named refusal. This spec only reports what the browser did.
 */

type InvocationTake = {
  id: string;
  path: string;
  sha256: string;
  text: string | null;
  sampleRate: number;
  pcmBase64: string;
  durationMs: number;
};

type Invocation = {
  schemaVersion: 1;
  scenario: string;
  locale: string;
  voice: string;
  appUrl: string;
  pipelineUrl: string;
  capturesDir: string;
  eventsDir: string;
  resultPath: string;
  takes: InvocationTake[];
  script: readonly {
    take: string;
    trigger:
      | { type: "call-open"; delayMs?: number }
      | { type: "agent-speech-start"; delayMs?: number }
      | { type: "agent-turn-end"; delayMs?: number }
      | { type: "silence"; silenceMs: number; delayMs?: number }
      | { type: "at-offset"; atMs: number };
  }[];
  faults: readonly { kind: string; atMs: number; durationMs?: number }[];
  holdOpenMs: number | null;
};

type TimelineEntry = { atMs: number; type: AgentTimelineEvent["type"] };

type Report = {
  callId: string | null;
  voice: string;
  subject: string;
  startedAt: string;
  endedAt: string;
  timeline: {
    events: readonly TimelineEntry[];
    spoken: readonly { step: number; take: string; atMs: number }[];
  };
  triggerPlan: ReturnType<typeof evaluateTriggers>;
  faultsApplied: readonly unknown[];
  syntheticMic: {
    method: "getUserMedia";
    installedAt: number;
    installedBeforeAppCode: boolean;
    takesPlayed: readonly {
      step: number;
      take: string;
      atMs: number;
      durationMs: number;
      epochMs: number;
    }[];
    sampleRate: number | null;
  };
  browser: {
    appUrl: string;
    pipelineWsUrl: string;
    userAgent: string;
    markCount: number | null;
    captureName: string | null;
  };
  marksPath: string | null;
  capturePath: string | null;
  captions: readonly { role: "caller" | "agent"; text: string }[];
  endedBy: "caller-hangup" | "agent-end" | "call-drop" | "timeout";
  error: string | null;
  tracePath: string | null;
  endPath: string | null;
  elapsedMs: number;
};

function invocation(): Invocation {
  const path = process.env.VONI_BROWSER_INVOCATION;
  if (!path) throw new Error("VONI_BROWSER_INVOCATION is not set");
  return JSON.parse(readFileSync(path, "utf8")) as Invocation;
}

/** The page's own state transitions, recorded before any app code runs. */
const timelineBootstrap = (): void => {
  const origin = performance.now();
  const events: TimelineEntry[] = [];
  let last: string | null = null;
  let opened = false;
  const record = (type: TimelineEntry["type"]) => {
    events.push({ atMs: performance.now() - origin, type });
  };
  const read = () => {
    const element = document.querySelector("[data-voice-state]");
    const state = element?.getAttribute("data-voice-state") ?? null;
    if (state === null || state === last) return;
    if (last === null) {
      // The card renders its rest state ("idle") before the visitor acts.
      // Call open is the transition out of it, never the initial paint. A
      // click that lands before the observer's first tick is still a call.
      last = state;
      if (state !== "idle") {
        record("call-open");
        opened = true;
      }
      return;
    }
    if (!opened && state !== "idle") {
      record("call-open");
      opened = true;
    }
    if (opened && state === "speaking") record("agent-speech-start");
    if (opened && state === "listening" && last === "speaking") {
      record("agent-speech-end");
      record("agent-turn-end");
    }
    if (opened && state === "ended") record("call-end");
    last = state;
  };
  const start = () => {
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-voice-state"],
    });
    read();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
  Object.defineProperty(window, "__voniAgentTimeline", {
    configurable: false,
    value: {
      origin,
      events,
      now: () => performance.now() - origin,
    },
  });
};

type PageTimeline = {
  events: TimelineEntry[];
  now: number;
};

async function readTimeline(page: Page): Promise<PageTimeline> {
  return page.evaluate(() => {
    const timeline = (
      window as unknown as {
        __voniAgentTimeline?: { events: TimelineEntry[]; now(): number };
      }
    ).__voniAgentTimeline;
    if (timeline === undefined) throw new Error("the agent timeline was not installed");
    return { events: [...timeline.events], now: timeline.now() };
  }) as Promise<PageTimeline>;
}

async function waitForEvent(
  page: Page,
  type: AgentTimelineEvent["type"],
  afterIndex: number,
  timeoutMs: number,
  afterMs = -1,
): Promise<{ atMs: number; index: number } | null> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const timeline = await readTimeline(page);
    const index = timeline.events.findIndex(
      (event, at) => at >= afterIndex && event.type === type && event.atMs > afterMs,
    );
    if (index >= 0) return { atMs: timeline.events[index]!.atMs, index };
    await page.waitForTimeout(100);
  }
  return null;
}

async function waitUntilCallMs(page: Page, targetMs: number, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const timeline = await readTimeline(page);
    if (timeline.now >= targetMs) return true;
    await page.waitForTimeout(50);
  }
  return false;
}

type Resolved = { atMs: number; after: number };

/**
 * Resolve one trigger rule against the live UI. The browser's observed
 * timeline is the only clock; a rule whose event never arrives resolves to
 * null and the runner refuses it by name.
 */
async function resolveTrigger(
  page: Page,
  script: Invocation["script"],
  stepIndex: number,
  cursor: number,
  timeoutMs: number,
): Promise<Resolved | null> {
  const step = script[stepIndex]!;
  const trigger = step.trigger;
  const timeline = await readTimeline(page);
  const callOpen = timeline.events.find((event) => event.type === "call-open")?.atMs ?? 0;
  const delay = "delayMs" in trigger && trigger.delayMs ? trigger.delayMs : 0;
  switch (trigger.type) {
    case "call-open":
      return { atMs: callOpen + delay, after: cursor };
    case "at-offset":
      return { atMs: callOpen + trigger.atMs, after: cursor };
    case "agent-speech-start": {
      const found = await waitForEvent(page, "agent-speech-start", cursor, timeoutMs);
      return found === null ? null : { atMs: found.atMs + delay, after: found.index + 1 };
    }
    case "agent-turn-end": {
      const found = await waitForEvent(page, "agent-turn-end", cursor, timeoutMs);
      return found === null ? null : { atMs: found.atMs + delay, after: found.index + 1 };
    }
    case "silence": {
      const started = Date.now();
      let after = cursor;
      while (Date.now() - started <= timeoutMs) {
        const current = await readTimeline(page);
        const latest = current.events[current.events.length - 1];
        const from = latest?.atMs ?? callOpen;
        const target = from + trigger.silenceMs + delay;
        if (current.now >= target) {
          return { atMs: target, after };
        }
        await page.waitForTimeout(50);
        const next = await readTimeline(page);
        if ((next.events[next.events.length - 1]?.atMs ?? 0) > from) {
          after = next.events.length;
          continue;
        }
      }
      return null;
    }
  }
}

test.use({
  // The local target's pipeline is the real service behind the operator's
  // generated dev certificate. A remote target is refused before this spec,
  // so trusting the local cert never makes a remote stack look certified.
  ignoreHTTPSErrors: true,
});
test.setTimeout(150_000);

test("a certifying browser call on the real stack", async ({ page }) => {
  const spec = invocation();
  const startedAtWall = Date.now();
  const startedAt = new Date(startedAtWall).toISOString();
  const micTakes: SyntheticMicTake[] = spec.takes.map((take) => ({
    id: take.id,
    pcmBase64: take.pcmBase64,
    sampleRate: take.sampleRate,
  }));

  const events: TimelineEntry[] = [];
  const spoken: { step: number; take: string; atMs: number }[] = [];
  const socketUrls: string[] = [];
  let marksResponse: { path: string | null } | null = null;
  let captureResponse: { path: string | null } | null = null;
  let endedBy: Report["endedBy"] = "timeout";
  let error: string | null = null;

  page.on("websocket", (socket) => socketUrls.push(socket.url()));
  page.on("pageerror", (pageError) => {
    error = `page error: ${pageError.message}`;
    console.log(`[browser pageerror] ${pageError.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`[browser console] ${message.text()}`);
  });
  page.on("requestfailed", (request) => {
    console.log(
      `[browser requestfailed] ${request.url()} ${request.failure()?.errorText ?? ""}`,
    );
  });
  const marksWait = page
    .waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/dev/call-marks" &&
        response.request().method() === "POST",
      { timeout: 60_000 },
    )
    .catch(() => null);
  const captureWait = page
    .waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/dev/delivered-capture" &&
        response.request().method() === "POST",
      { timeout: 60_000 },
    )
    .catch(() => null);

  // Before any app code: the mic and the timeline. Both are harness-owned.
  await installSyntheticMic(page, micTakes);
  await page.addInitScript({ content: `(${timelineBootstrap.toString()})();` });

  await page.goto(`/?delivercapture=1`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("landing-shell")).toBeVisible({ timeout: 30_000 });

  // The scenario's Locale chooses the demo voice; the picker cycles, so click
  // forward until the real UI shows that voice before starting. Each click is
  // a React state update, so the loop waits for the painted label rather than
  // firing a burst of clicks at one render.
  const targetLabel = spec.voice.charAt(0).toUpperCase() + spec.voice.slice(1);
  const voiceLine = page.getByText(new RegExp(`·\\s*${targetLabel}(\\s|$)`));
  const next = page.getByRole("button", { name: "Next voice" }).filter({ visible: true }).first();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if ((await voiceLine.count()) > 0) break;
    await next.click().catch(() => undefined);
    await page.waitForTimeout(250);
  }
  await expect
    .poll(() => voiceLine.count(), { timeout: 10_000 })
    .toBeGreaterThan(0);

  const start = page.getByRole("button", { name: /^start call$/i }).filter({ visible: true }).first();
  await expect(async () => {
    const timeline = await readTimeline(page).catch(() => null);
    if ((timeline?.events.length ?? 0) === 0) {
      await start.click({ timeout: 1000 }).catch(() => undefined);
    }
    await expect.poll(() => readTimeline(page).then((value) => value.events.length), { timeout: 3000 }).toBeGreaterThan(0);
  }).toPass({ timeout: 30_000 });

  // The real pipeline socket, and only it. A `.invalid` URL or a missing
  // browser-call socket is a named failure, not a silent diagnosis. The dev
  // server's HMR socket is not a call socket, so the poll names the path.
  await expect
    .poll(() => socketUrls.some((url) => url.includes("/v1/browser-call")), {
      timeout: 30_000,
    })
    .toBe(true);
  const callSocket = socketUrls.find((url) => url.includes("/v1/browser-call"));
  if (callSocket === undefined) {
    throw new Error(`the browser opened no /v1/browser-call socket; saw ${socketUrls.join(", ")}`);
  }
  if (new URL(callSocket).host !== new URL(spec.pipelineUrl).host) {
    throw new Error(
      `the browser call socket is ${callSocket}, not the configured pipeline ${spec.pipelineUrl}`,
    );
  }

  // The caller cannot speak into a line whose mic has not been served. The
  // synthetic stream is handed to the real mic path at getUserMedia; a
  // call-open take waits for that handoff instead of playing into a dead bus.
  await page.waitForFunction(
    () => {
      const api = (
        window as unknown as { __voniSyntheticMic?: { acquired?: () => boolean } }
      ).__voniSyntheticMic;
      return api?.acquired?.() === true;
    },
    undefined,
    { timeout: 20_000 },
  );

  let cursor = 0;
  const stepTimeoutMs = 30_000;
  for (const [stepIndex, step] of spec.script.entries()) {
    const resolved = await resolveTrigger(page, spec.script, stepIndex, cursor, stepTimeoutMs);
    if (resolved === null) {
      error = `trigger for step ${stepIndex} ("${step.take}", ${step.trigger.type}) never arrived`;
      break;
    }
    cursor = resolved.after;
    await waitUntilCallMs(page, resolved.atMs, stepTimeoutMs);
    const timeline = await readTimeline(page);
    const played = await page.evaluate((id) => {
      const api = (
        window as unknown as {
          __voniSyntheticMic: {
            play(takeId: string, delayMs: number): Promise<unknown>;
          };
        }
      ).__voniSyntheticMic;
      return api.play(id, 0);
    }, step.take);
    spoken.push({ step: stepIndex, take: step.take, atMs: timeline.now });
    void played;
  }

  // Let the caller finish the last take, then let the agent answer it, then
  // hang up as a caller would. A take cut by the harness would be a measured
  // failure caused by the harness; a service that already ended is an
  // agent-end.
  if (error === null) {
    const last = spoken[spoken.length - 1];
    const lastTake = spec.takes.find((take) => take.id === last?.take);
    if (last !== undefined) {
      await page.waitForTimeout((lastTake?.durationMs ?? 0) + 500);
    }
    const timelineAfterTake = await readTimeline(page);
    const startIndex = timelineAfterTake.events.findIndex(
      (event) => event.type === "agent-speech-start" && event.atMs >= (last?.atMs ?? 0),
    );
    if (startIndex >= 0) {
      await waitForEvent(page, "agent-turn-end", startIndex + 1, 30_000, last?.atMs ?? -1);
    } else {
      const start = await waitForEvent(
        page,
        "agent-speech-start",
        0,
        20_000,
        last?.atMs ?? -1,
      );
      if (start === null) {
        error = "the agent did not start a reply after the caller's last take";
      } else {
        await waitForEvent(page, "agent-turn-end", start.index + 1, 30_000);
      }
    }
    // A scenario may declare that the line must stay open (the
    // greeting-only wait): the harness holds the call there instead of
    // hanging up as soon as the agent finishes. The hold is a scenario fact,
    // never an evaluator's guess.
    if (spec.holdOpenMs !== null && spec.holdOpenMs > 0) {
      await page.waitForTimeout(spec.holdOpenMs);
    }
    const ended = await readTimeline(page);
    if (ended.events.some((event) => event.type === "call-end")) {
      endedBy = "agent-end";
    } else {
      const hangUp = page.getByRole("button", { name: "Hang up" }).filter({ visible: true }).first();
      if (await hangUp.isVisible().catch(() => false)) {
        await hangUp.click();
        endedBy = "caller-hangup";
      } else {
        endedBy = "agent-end";
      }
    }
  }

  const marks = await marksWait;
  const capture = await captureWait;
  if (marks !== null && marks.ok()) {
    marksResponse = (await marks.json().catch(() => null)) as { path: string | null } | null;
  }
  if (capture !== null && capture.ok()) {
    captureResponse = (await capture.json().catch(() => null)) as { path: string | null } | null;
  }

  const timeline = await readTimeline(page);
  events.push(...timeline.events);

  // The visitor's transcript: each final caller/agent line the page rendered.
  // It is observation only, read before the page is torn down; a line the UI
  // never painted cannot be invented here.
  const captions = await page
    .evaluate(() => {
      const region = document.querySelector('[aria-label="Call transcript"]');
      if (region === null) return [];
      const rows: { role: "caller" | "agent"; text: string }[] = [];
      for (const item of region.querySelectorAll('[data-slot="message-scroller-item"]')) {
        const spans = item.querySelectorAll(":scope > span");
        const label = spans[0]?.textContent?.trim() ?? "";
        const text = spans[1]?.textContent?.trim() ?? "";
        if (text === "") continue;
        rows.push({ role: label === "You" ? "caller" : "agent", text });
      }
      return rows;
    })
    .catch(() => [] as { role: "caller" | "agent"; text: string }[]);

  // Read the marks artifact to bind the report's call id. A missing marks file
  // is reported, not invented: the runner refuses it by name.
  let callId: string | null = null;
  let markCount: number | null = null;
  let captureName: string | null = null;
  let installedBeforeAppCode = false;
  if (marksResponse?.path) {
    try {
      const artifact = JSON.parse(readFileSync(marksResponse.path, "utf8")) as {
        callId?: string;
        marks?: { name: string; at: string; detail?: { name?: string } }[];
      };
      callId = typeof artifact.callId === "string" ? artifact.callId : null;
      markCount = Array.isArray(artifact.marks) ? artifact.marks.length : null;
      const captureMark = [...(artifact.marks ?? [])]
        .reverse()
        .find((mark) => mark.name === "delivered_capture");
      captureName = typeof captureMark?.detail?.name === "string" ? captureMark.detail.name : null;
    } catch (readError) {
      error = `cannot read the marks artifact: ${(readError as Error).message}`;
    }
  }
  const mic = await readSyntheticMicReport(page).catch(() => null);
  if (mic !== null && marksResponse?.path) {
    try {
      const artifact = JSON.parse(readFileSync(marksResponse.path, "utf8")) as {
        marks?: { name: string; at: string }[];
      };
      const first = artifact.marks?.[0];
      installedBeforeAppCode =
        first !== undefined && mic.installedAt <= Date.parse(first.at);
    } catch {
      installedBeforeAppCode = false;
    }
  }

  // The end document is written by the service after its final drain; the
  // client's teardown can precede it. Waiting here keeps the runner from
  // reading a sidecar that exists a moment later, without inventing one.
  const endPath: string | null = callId === null ? null : `${spec.eventsDir}/${callId}.end.json`;
  if (endPath !== null) {
    const endWait = Date.now();
    while (!existsSync(endPath) && Date.now() - endWait < 20_000) {
      await page.waitForTimeout(250);
    }
    if (!existsSync(endPath)) error = error ?? "the pipeline wrote no end document";
  }

  const report: Report = {
    callId,
    voice: spec.voice,
    subject: `demo:${spec.voice}`,
    startedAt,
    endedAt: new Date().toISOString(),
    timeline: { events, spoken },
    triggerPlan: evaluateTriggers(spec.script, events),
    faultsApplied: [],
    syntheticMic: {
      method: "getUserMedia",
      installedAt: mic?.installedAt ?? 0,
      installedBeforeAppCode,
      takesPlayed: spoken.map((entry, index) => ({
        step: entry.step,
        take: entry.take,
        atMs: entry.atMs,
        durationMs: mic?.played[index]?.durationMs ??
          spec.takes.find((take) => take.id === entry.take)?.durationMs ??
          0,
        epochMs: mic?.played[index]?.epochMs ?? 0,
      })),
      sampleRate: mic?.sampleRate ?? null,
    },
    browser: {
      appUrl: spec.appUrl,
      pipelineWsUrl: callSocket ?? "",
      userAgent: await page.evaluate(() => navigator.userAgent).catch(() => ""),
      markCount,
      captureName: captureName ?? (captureResponse?.path ? basename(captureResponse.path) : null),
    },
    captions,
    marksPath: marksResponse?.path ?? null,
    capturePath: captureResponse?.path ?? null,
    endedBy,
    error,
    tracePath: callId === null ? null : `${spec.eventsDir}/${callId}.jsonl`,
    endPath,
    elapsedMs: Date.now() - startedAtWall,
  };
  writeFileSync(spec.resultPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
});

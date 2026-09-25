import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "@playwright/test";

/**
 * Agentic verifier for the mobile call takeover.
 *
 * Job-done gate for `.scratch/mobile-takeover`. Fails while phone
 * fullscreen is broken; passes only when popup + backdrop independently
 * match the visual viewport.
 *
 * WhatsApp layout (hero orb + subtitle caption + bottom dock + Captions
 * toggle) assertions live alongside the geometry ones: the orb must own
 * center stage, the caption must stay a subtitle, the dock must sit at the
 * bottom, and history must hide behind the toggle, bounded when open.
 *
 * Robustness (no retries):
 * - Attaches to the existing `next dev` server (never starts one).
 * - Fake mic granted + fake media-stream flags so no permission prompt.
 * - Waits for fonts + 2 rAF + settled rects (3 stable reads) instead of
 *   fixed sleeps; tolerates ±1px safe-area rounding.
 * - Throws with a JSON dump on red; `console.log` JSON on green.
 *
 * Live mute (Mute→Unmute, hidden context, agent audio) is MANUAL on a
 * real phone — this script only asserts Mute is absent while not
 * connected and the geometry/dismissal/focus contract holds.
 */

type Rect = { x: number; y: number; w: number; h: number };

function lockAppUrl(): string {
  if (process.env.PLAYWRIGHT_BASE_URL) return process.env.PLAYWRIGHT_BASE_URL;
  try {
    const lock = JSON.parse(readFileSync(".next/dev/lock", "utf8"));
    if (typeof lock.appUrl === "string") return lock.appUrl;
  } catch {
    // Fall through to default dev:phone URL.
  }
  return "https://localhost:3000";
}

const BASE_URL = lockAppUrl();
const MOBILE = { width: 390, height: 844 };
const TOL = 1.5;

function closeEnough(a: number, b: number): boolean {
  return Math.abs(a - b) <= TOL;
}

function dump(label: string, data: unknown): never {
  console.error(`[verify-mobile-takeover] FAIL ${label}: ${JSON.stringify(data)}`);
  throw new Error(`mobile takeover: ${label}`);
}

async function readRects(page: Page) {
  const raw = await page.evaluate(
    "(() => { const q = (id) => document.querySelector('[data-testid=\"' + id + '\"]'); const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }; return JSON.stringify({ vv: { w: (window.visualViewport ? window.visualViewport.width : window.innerWidth), h: (window.visualViewport ? window.visualViewport.height : window.innerHeight) }, popup: r(q('landing-demo-mobile-dialog')), backdrop: r(q('landing-demo-mobile-backdrop')), bodyScrollW: document.body.scrollWidth, bodyOverflow: getComputedStyle(document.body).overflow }); })()",
  );
  return JSON.parse(raw as unknown as string) as {
    vv: { w: number; h: number };
    popup: Rect | null;
    backdrop: Rect | null;
    bodyScrollW: number;
    bodyOverflow: string;
  };
}

async function settledRects(page: Page): Promise<{
  vv: { w: number; h: number };
  popup: Rect | null;
  backdrop: Rect | null;
  bodyScrollW: number;
  bodyOverflow: string;
}> {
  // Fonts + 2 rAF so 100dvh / animations have settled before measuring.
  await page.evaluate(
    "Promise.all([document.fonts ? document.fonts.ready : Promise.resolve()]).then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))",
  );
  let last: Awaited<ReturnType<typeof readRects>> | null = null;
  for (let i = 0; i < 30; i++) {
    const cur = await readRects(page);
    if (last && cur.popup && last.popup && cur.backdrop && last.backdrop) {
      const stable =
        closeEnough(cur.popup.w, last.popup.w) &&
        closeEnough(cur.popup.h, last.popup.h) &&
        closeEnough(cur.backdrop.w, last.backdrop.w) &&
        closeEnough(cur.backdrop.h, last.backdrop.h);
      if (stable) return cur;
    }
    last = cur;
    await page.waitForTimeout(150);
  }
  return (last ?? (await readRects(page))) as Awaited<ReturnType<typeof readRects>>;
}

async function main() {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    });
    const ctx = await browser.newContext({
      viewport: MOBILE,
      isMobile: true,
      hasTouch: true,
      ignoreHTTPSErrors: true,
      permissions: ["microphone"],
    });
    const page = await ctx.newPage();
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });

    const start = page.getByTestId("landing-demo-start").or(page.getByRole("button", { name: /start call/i }));
    await start.first().waitFor({ state: "visible", timeout: 15000 });

    // Idle: no dialog yet, no horizontal reveal.
    assert.equal(await page.getByTestId("landing-demo-mobile-dialog").count(), 0, "dialog open at idle");
    const idleRaw = await page.evaluate(
      "JSON.stringify({ bodyScrollW: document.body.scrollWidth, vvW: (window.visualViewport ? window.visualViewport.width : window.innerWidth) })",
    );
    const idle = JSON.parse(idleRaw as unknown as string) as { bodyScrollW: number; vvW: number };
    if (idle.bodyScrollW > idle.vvW + TOL) dump("idle horizontal reveal", idle);

    await start.first().click();

    const dialog = page.getByTestId("landing-demo-mobile-dialog");

    // Phone edge-to-edge needs viewport-fit=cover, otherwise notched
    // phones letterbox and env(safe-area-inset-*) stays 0.
    const viewportContent = await page.evaluate(
      "String(document.querySelector('meta[name=\"viewport\"]') ? document.querySelector('meta[name=\"viewport\"]').getAttribute('content') : '')",
    );
    if (!/viewport-fit\s*=\s*cover/.test(String(viewportContent)))
      dump("viewport-fit=cover missing", { viewportContent: String(viewportContent) });
    await dialog.waitFor({ state: "visible", timeout: 15000 });
    const measured = await settledRects(page);
    if (!measured.popup) dump("popup missing after Start", measured);
    if (!measured.backdrop) dump("backdrop missing after Start", measured);
    const { vv, popup, backdrop } = measured as { vv: { w: number; h: number }; popup: Rect; backdrop: Rect };

    for (const [name, rect] of [["popup", popup], ["backdrop", backdrop]] as const) {
      if (!closeEnough(rect.x, 0) || !closeEnough(rect.y, 0)) dump(`${name} origin`, { rect, vv });
      if (!closeEnough(rect.w, vv.w)) dump(`${name} width`, { rect, vv });
      if (!closeEnough(rect.h, vv.h)) dump(`${name} height`, { rect, vv });
    }
    if (measured.bodyScrollW > vv.w + TOL) dump("horizontal reveal while open", measured);
    if (measured.bodyOverflow !== "hidden") dump("scroll not locked", measured);

    // Real phones break when a centering transform or default margin
    // offsets the fixed takeover even though dvw strings are present.
    const frameStyle = await page.evaluate(
      "JSON.stringify((() => { const el = (name) => document.querySelector('[data-testid=\"' + name + '\"]'); const cs = (e) => { const s = getComputedStyle(e); return { transform: s.transform, margin: s.margin, position: s.position }; }; return { popup: cs(el('landing-demo-mobile-dialog')), backdrop: cs(el('landing-demo-mobile-backdrop')) }; })())",
    );
    const styles = JSON.parse(frameStyle as unknown as string) as {
      popup: { transform: string; margin: string; position: string };
      backdrop: { transform: string; margin: string; position: string };
    };
    for (const [name, s] of [["popup", styles.popup], ["backdrop", styles.backdrop]] as const) {
      if (s.transform !== "none") dump(`${name} transform offsets fullscreen`, s);
      if (s.position !== "fixed") dump(`${name} not fixed`, s);
    }
    // Takeover must paint above the sticky landing header (z-40).
    const zRaw = await page.evaluate(
      "JSON.stringify({ popup: getComputedStyle(document.querySelector('[data-testid=\"landing-demo-mobile-dialog\"]')).zIndex, backdrop: getComputedStyle(document.querySelector('[data-testid=\"landing-demo-mobile-backdrop\"]')).zIndex })",
    );
    const z = JSON.parse(zRaw as unknown as string) as { popup: string; backdrop: string };
    if (!(Number(z.popup) >= 40 && Number(z.backdrop) >= 40)) dump("takeover below header", z);

    // WhatsApp call screen: hero orb owns center stage, the caption is a
    // subtitle (never a screen-filler), the dock sits at the bottom, and
    // history hides behind the Captions toggle. Hidden context never
    // renders visibly.
    const hangupBtn = dialog.getByRole("button", { name: /^hang up$/i });
    const geomRaw = await page.evaluate(
      "JSON.stringify((() => { const q = (id) => document.querySelector('[data-testid=\"' + id + '\"]'); const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }; const dlg = q('landing-demo-mobile-dialog'); const orb = dlg ? dlg.querySelector('.landing-orb') : null; return { hero: r(q('landing-demo-mobile-hero')), orb: r(orb), caption: r(q('landing-demo-mobile-caption')), dock: r(q('landing-demo-mobile-dock')), transcript: r(q('landing-demo-mobile-transcript')) }; })())",
    );
    const geom = JSON.parse(geomRaw as unknown as string) as {
      hero: Rect | null;
      orb: Rect | null;
      caption: Rect | null;
      dock: Rect | null;
      transcript: Rect | null;
    };
    if (!geom.hero) dump("hero missing", geom);
    if (!geom.orb) dump("orb missing", geom);
    if (!geom.caption) dump("caption missing", geom);
    if (!geom.dock) dump("dock missing", geom);
    const hero = geom.hero as Rect;
    const orb = geom.orb as Rect;
    const caption = geom.caption as Rect;
    const dock = geom.dock as Rect;
    if (!hero.h) dump("hero has no height", geom);
    const orbCx = orb.x + orb.w / 2;
    const orbCy = orb.y + orb.h / 2;
    if (Math.abs(orbCx - vv.w / 2) > 8) dump("orb not centered", { orb, vv });
    if (orbCy < vv.h * 0.25 || orbCy > vv.h * 0.78) dump("orb not center stage", { orb, vv });
    if (caption.h > vv.h * 0.25) dump("caption fills screen", { caption, vv });
    if (dock.y + dock.h < vv.h - 140) dump("dock not bottom-anchored", { dock, vv });
    if ((await hangupBtn.count()) > 0) {
      const hb = await hangupBtn.first().boundingBox();
      if (!hb || hb.width < 56 || hb.height < 56 || Math.abs(hb.width - hb.height) > 4)
        dump("hangup not prominent circle", hb);
    }
    // History hides behind Captions; bounded when open.
    const captionsBtn = dialog.getByRole("button", { name: /^captions$/i });
    if ((await captionsBtn.count()) === 0) {
      if (geom.transcript) dump("transcript visible without toggle", geom);
    } else {
      if (geom.transcript) dump("transcript open by default", geom);
      await captionsBtn.first().click();
      await page.getByTestId("landing-demo-mobile-transcript").waitFor({ state: "visible", timeout: 5000 });
      const openRaw = await page.evaluate(
        "(() => { const b = document.querySelector('[data-testid=\"landing-demo-mobile-transcript\"]').getBoundingClientRect(); return JSON.stringify({ h: b.height }); })()",
      );
      const openH = (JSON.parse(openRaw as unknown as string) as { h: number }).h;
      if (openH > vv.h * 0.4 + 8) dump("open transcript fills screen", { openH, vv });
      await captionsBtn.first().click();
      await page.waitForTimeout(300);
      if ((await page.getByTestId("landing-demo-mobile-transcript").count()) !== 0)
        dump("captions toggle does not collapse", {});
    }
    const dlgText = (await dialog.innerText()).toLowerCase();
    if (dlgText.includes("microphone is muted") || dlgText.includes("microphone is available"))
      dump("visible system-context row", { excerpt: dlgText.slice(0, 200) });

    // Mute is connected-only: with fake mic the call ends in error/ended,
    // so Mute must be absent. (Connected Mute→Unmute is manual on a phone.)
    const stateRaw = await page.evaluate(
      "String(document.querySelector('[data-voice-state]') ? document.querySelector('[data-voice-state]').getAttribute('data-voice-state') : '')",
    );
    const state = String(stateRaw);
    const muteCount = await dialog.getByRole("button", { name: /^mute$|^unmute$/i }).count();
    if (state === "listening" || state === "speaking") {
      if (muteCount !== 1) dump("mute missing while connected", { state });
    } else if (muteCount !== 0) {
      dump("mute visible while not connected", { state });
    }

    // Backdrop click + Escape must never dismiss (only explicit Close may).
    await page.evaluate(
      "document.querySelector('[data-testid=\"landing-demo-mobile-backdrop\"]') ? document.querySelector('[data-testid=\"landing-demo-mobile-backdrop\"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) : 0",
    );
    await page.waitForTimeout(300);
    if ((await dialog.count()) !== 1) dump("backdrop dismissed dialog", {});
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    if ((await dialog.count()) !== 1) dump("escape dismissed dialog", {});

    // Ended/error footer offers Call again + Close. If the fake-mic call
    // is still connecting/active, Hang up first, then Close.
    const closeBtn = dialog.getByRole("button", { name: /^close$/i });
    try {
      await closeBtn.waitFor({ state: "visible", timeout: 15000 });
    } catch {
      if ((await hangupBtn.count()) > 0) {
        await hangupBtn.first().click();
        await closeBtn.waitFor({ state: "visible", timeout: 15000 });
      } else {
        throw new Error("neither Close nor Hang up became visible");
      }
    }
    await closeBtn.click();
    await dialog.waitFor({ state: "hidden", timeout: 10000 });
    await start.first().waitFor({ state: "visible", timeout: 15000 });
    const focusedRaw = await page.evaluate("String(document.activeElement ? document.activeElement.textContent.slice(0, 50) : '')");
    const focused = String(focusedRaw);
    if (!/start call/i.test(focused)) dump("focus not returned to Start", { focused });
    await ctx.close();

    // Desktop: mobile takeover absent, desktop card intact.
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
    const dpage = await desktop.newPage();
    await dpage.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
    assert.equal(await dpage.getByTestId("landing-demo-mobile-dialog").count(), 0, "mobile dialog at desktop");
    await dpage.getByRole("button", { name: /start call/i }).first().waitFor({ state: "visible", timeout: 15000 });
    await desktop.close();

    console.log(JSON.stringify({ ok: true, vv, popup, backdrop, state }));
  } finally {
    await browser?.close();
  }
}

main().catch((e) => {
  console.error(`[verify-mobile-takeover] ${e instanceof Error ? e.stack ?? e.message : e}`);
  process.exit(1);
});

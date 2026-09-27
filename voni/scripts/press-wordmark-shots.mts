/**
 * Press-kit raster pass 2/2 — wordmark + lockup PNGs (real Geist) + OG covers.
 *
 * Chromium shapes the HTML "oni" + slogans in real Geist (next/font), which
 * sharp alone cannot do (no Geist in fontconfig). Captures full-viewport
 * shots of the disposable src/app/press-specimen routes (each owns its
 * background via inline colors — deterministic at any OS theme), then
 * normalizes with sharp. Requires: `agent-browser` on PATH, `next dev`.
 *
 * Capture notes (learned the hard way — keep these invariants):
 * - `set viewport` only sticks when a page is already open: open FIRST,
 *   then set viewport, then shoot. Verify via DPR when in doubt.
 * - Wordmarks/lockups shoot at DPR 2 and DOWNSCALE (never upscale).
 * - Hide the `nextjs-portal` dev overlay before every capture — it is
 *   fixed-positioned and lands inside full-viewport shots.
 *
 *   NEXT_DEV_URL=http://localhost:3000 npx tsx scripts/press-wordmark-shots.mts
 *
 * Delete src/app/press-specimen after a good run (this script asserts
 * dimensions and fails loudly otherwise). The manifest generator excludes
 * press-specimen permanently, so no exclusion cleanup is needed.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const PRESS = join(here, "..", "public", "press");
const OUT = join(PRESS, "png");
const BASE = process.env.NEXT_DEV_URL ?? "http://localhost:3000";
const WORD_W = 2048;
const HIDE_PORTAL =
  "const p=document.querySelector('nextjs-portal');if(p)p.style.display='none'";

function ab(args: string[], env: Record<string, string>): string {
  return execFileSync("agent-browser", args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

let session = "";
try {
  session = ab(["session", "id", "--scope", "worktree", "--prefix", "press-shots"], {}).trim().split("\n").pop()!;
  const env = { AGENT_BROWSER_SESSION: session, AGENT_BROWSER_RESTORE: session };
  const S = (args: string[]) => ab(["--session", session, "--restore", ...args], env);
  const tmp = mkdtempSync(join(tmpdir(), "press-"));

  // Open → viewport → shoot. `set viewport` only sticks on an open page.
  const capture = (route: string, w: number, h: number, dpr: number): string => {
    S(["open", `${BASE}/press-specimen/${route}`]);
    S(["wait", "--load", "networkidle"]);
    S(["set", "viewport", String(w), String(h), String(dpr)]);
    S(["wait", "--load", "networkidle"]);
    S(["eval", HIDE_PORTAL]);
    const file = join(tmp, `${route}.png`);
    S(["screenshot", file]);
    return file;
  };

  // Oversized lockups at DPR 2: trim to ink, then DOWNSCALE (never upscale).
  for (const [route, out] of [
    ["wordmark-light", "voni-wordmark-light-2048.png"],
    ["wordmark-dark", "voni-wordmark-dark-2048.png"],
    ["lockup-work-done-light", "voni-lockup-work-done-light-2048.png"],
    ["lockup-work-done-dark", "voni-lockup-work-done-dark-2048.png"],
    ["lockup-everything-after-light", "voni-lockup-everything-after-light-2048.png"],
    ["lockup-everything-after-dark", "voni-lockup-everything-after-dark-2048.png"],
    ["lockup-while-talking-light", "voni-lockup-while-talking-light-2048.png"],
    ["lockup-while-talking-dark", "voni-lockup-while-talking-dark-2048.png"],
  ] as const) {
    const file = capture(route, 2300, 1300, 2);
    const before = await sharp(file).metadata();
    if ((before.width ?? 0) < WORD_W) {
      throw new Error(`press-wordmark-shots: ${route} captured at ${before.width}w — below ${WORD_W}, cannot upscale`);
    }
    const info = await sharp(file).trim({ threshold: 10 }).resize({ width: WORD_W }).png().toFile(join(OUT, out));
    if (info.width !== WORD_W) throw new Error(`press-wordmark-shots: ${out} is ${info.width}w, expected ${WORD_W}`);
    console.log(`wrote ${out} (${info.width}x${info.height})`);
  }

  // OG covers: viewport matches the exact 1200x630 box at DPR 1 — pixel-exact.
  for (const [route, out] of [
    ["og", "og-cover-1200x630.png"],
    ["og-work-done", "og-work-done-1200x630.png"],
    ["og-everything-after", "og-everything-after-1200x630.png"],
    ["og-while-talking", "og-while-talking-1200x630.png"],
  ] as const) {
    const file = capture(route, 1200, 630, 1);
    const og = await sharp(file).metadata();
    if (og.width !== 1200 || og.height !== 630) {
      throw new Error(`press-wordmark-shots: OG is ${og.width}x${og.height}, expected 1200x630`);
    }
    await sharp(file).png().toFile(join(OUT, out));
    console.log(`wrote ${out} (1200x630)`);
  }
} finally {
  if (session) {
    try {
      ab(["--session", session, "--restore", "close"], {});
    } catch {
      // Session teardown is best-effort; the run already succeeded or threw.
    }
  }
}

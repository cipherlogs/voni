#!/usr/bin/env node
/*
 * invoke-from-laptop.mjs — hammer a deployed DigitalOcean Function URL from this computer.
 *
 * Usage:
 *   FUNCTION_URL=... node functions/invoke-from-laptop.mjs --total 200 --concurrency 20 --clicks 10
 *   FUNCTION_URL=... node functions/invoke-from-laptop.mjs --total 50 --concurrency 5 --clicks 10 --target "https://example.com/"
 *
 * Env / flags:
 *   FUNCTION_URL (required)  Deployed function web URL (see shapes below).
 *   --total N        total invocations (default 200)
 *   --concurrency N  parallel workers (default 20)
 *   --clicks N       `clicks` field in POST body (default 10)
 *   --target URL     `target` field in POST body (default glizzitrium URL below)
 *
 * Each invocation: POST FUNCTION_URL with JSON body { target, clicks }.
 *
 * FUNCTION_URL shapes — use the WEB url, not the doctl CLI form:
 *   Web URL (USE THIS for FUNCTION_URL):
 *     https://<region>.doserverless.co/api/v1/web/<namespace-uuid>/<package>/<function-name>
 *     e.g. https://faas-nyc1-xxx.doserverless.co/api/v1/web/fn-abc123/my-package/my-function
 *     (Find it via: doctl serverless functions list / get --url, or cloud console "Functions > ... > URL".)
 *   doctl CLI form (DO NOT use as FUNCTION_URL — this runs server-side via the API, not HTTP):
 *     doctl serverless functions invoke <package>/<function-name> --param target=X --param clicks=10
 *     doctl serverless functions invoke <package>/<function-name> --full   # --full prints full activation record, still CLI output, not a URL
 *
 * Output: total, ok rate, req/s, p50/p90 latency, distinct egressIp count + top 10,
 *         distinct IPs per 10-invocation bucket.
 */

const DEFAULT_TARGET = "https://www.glizzitrium.com/BCMPW39K/946KZGB/?creative_id=710986";

function parseArgs(argv) {
  const out = { total: 200, concurrency: 20, clicks: 10, target: DEFAULT_TARGET };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--total" && i + 1 < argv.length) out.total = Number(argv[++i]);
    else if (a === "--concurrency" && i + 1 < argv.length) out.concurrency = Number(argv[++i]);
    else if (a === "--clicks" && i + 1 < argv.length) out.clicks = Number(argv[++i]);
    else if (a === "--target" && i + 1 < argv.length) out.target = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("Usage: FUNCTION_URL=... node functions/invoke-from-laptop.mjs --total 200 --concurrency 20 --clicks 10 [--target URL]");
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function pickEgressIp(json) {
  if (!json || typeof json !== "object") return null;
  return (
    json.egressIp ??
    json.egress_ip ??
    json.egressIP ??
    json.ip ??
    json?.data?.egressIp ??
    json?.data?.ip ??
    json?.body?.egressIp ??
    null
  );
}

const FUNCTION_URL = process.env.FUNCTION_URL;
if (!FUNCTION_URL) {
  console.error("Missing FUNCTION_URL env var.");
  console.error("Example: FUNCTION_URL=https://faas-nyc1-xxx.doserverless.co/api/v1/web/fn-abc123/pkg/fn node functions/invoke-from-laptop.mjs --total 200 --concurrency 20 --clicks 10");
  process.exit(1);
}

const { total, concurrency, clicks, target } = parseArgs(process.argv.slice(2));

if (!Number.isFinite(total) || total <= 0) { console.error("--total must be > 0"); process.exit(2); }
if (!Number.isFinite(concurrency) || concurrency <= 0) { console.error("--concurrency must be > 0"); process.exit(2); }
if (!Number.isFinite(clicks) || clicks < 0) { console.error("--clicks must be >= 0"); process.exit(2); }

const results = new Array(total);
let warnedNonJson = false;

async function invokeOnce(index) {
  const body = JSON.stringify({ target, clicks });
  const start = Date.now();
  let status = 0;
  let egressIp = null;
  let ok = false;
  try {
    const res = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    status = res.status;
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      if (!warnedNonJson) {
        warnedNonJson = true;
        console.error(`Non-JSON response (first 200 chars): ${text.slice(0, 200)}`);
      }
    }
    if (json) egressIp = pickEgressIp(json);
    ok = res.ok;
  } catch (err) {
    status = 0;
    if (!warnedNonJson && err) {
      // Network-level failure: report once, keep going.
      warnedNonJson = true;
      console.error(`Request error (showing first only): ${String(err && err.message ? err.message : err).slice(0, 200)}`);
    }
  }
  const latency = Date.now() - start;
  results[index] = { index, status, latency, egressIp: egressIp ? String(egressIp) : null, ok };
}

async function main() {
  const workers = Math.min(concurrency, total);
  const startedAt = Date.now();
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= total) return;
      await invokeOnce(i);
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);

  const okCount = results.filter((r) => r.ok).length;
  const latencies = results.map((r) => r.latency).sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p90 = percentile(latencies, 90);
  const rps = (total / elapsedSec).toFixed(1);

  const counts = new Map();
  for (const r of results) {
    const key = r.egressIp ?? "(none)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const distinct = results.some((r) => r.egressIp) ? [...counts.keys()].filter((k) => k !== "(none)").length : 0;
  const top10 = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  console.log(`total: ${total}`);
  console.log(`ok: ${okCount}/${total} (${((okCount / total) * 100).toFixed(1)}%)`);
  console.log(`req/s: ${rps} (${elapsedSec.toFixed(1)}s elapsed)`);
  console.log(`latency ms: p50=${p50} p90=${p90}`);
  console.log(`distinct egressIps: ${distinct} (missing: ${counts.get("(none)") ?? 0})`);
  console.log("top egressIps:");
  for (const [ip, n] of top10) console.log(`  ${ip}: ${n}`);

  console.log("distinct IPs per 10-invocation bucket:");
  for (let b = 0; b < Math.ceil(total / 10); b++) {
    const slice = results.slice(b * 10, b * 10 + 10);
    const set = new Set(slice.map((r) => r.egressIp ?? "(none)"));
    console.log(`  ${String(b * 10).padStart(4)}-${Math.min(total - 1, b * 10 + 9)}: ${set.size} distinct`);
  }
}

await main();

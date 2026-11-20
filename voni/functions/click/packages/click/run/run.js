// Affiliate click probe. Built-in fetch only, no dependencies.
const DEFAULT_TARGET = 'https://www.glizzitrium.com/BCMPW39K/946KZGB/?creative_id=710986';

// 2x Chrome desktop + 1x iPhone Safari.
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
];

function withUtm(target, utmSource) {
  if (!utmSource) return target;
  try {
    const u = new URL(target);
    if (!u.searchParams.get('utm_source')) u.searchParams.set('utm_source', utmSource);
    return u.toString();
  } catch {
    return target;
  }
}

async function fetchWithTimeout(url, headers, timeoutMs) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: c.signal });
    // Drain body so timing is real; ignore errors.
    try { await res.arrayBuffer(); } catch { /* ignore */ }
    return { status: res.status, ms: Date.now() - start, finalUrl: (res.url || '').slice(0, 120) };
  } catch (e) {
    return { status: 0, ms: Date.now() - start, finalUrl: '', error: String(e && e.name ? e.name : e).slice(0, 80) };
  } finally {
    clearTimeout(t);
  }
}

async function getEgressIp() {
  try {
    const res = await fetch('https://httpbingo.org/ip', { signal: AbortSignal.timeout(15000) });
    const data = await res.json();
    return data.origin || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main(args) {
  const target = withUtm(args.target || args.Target || DEFAULT_TARGET, args.utm_source || args.utmSource);
  const clicks = Math.max(1, parseInt(args.clicks || args.Clicks || '10', 10) || 10);
  const egressIp = await getEgressIp();
  console.log(`click/run: target=${target} clicks=${clicks} egressIp=${egressIp}`);
  const results = [];
  for (let i = 0; i < clicks; i++) {
    const headers = {
      'user-agent': UAS[i % UAS.length],
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      referer: 'https://mail.google.com/',
      'upgrade-insecure-requests': '1',
    };
    const r = await fetchWithTimeout(target, headers, 15000);
    results.push(r);
    console.log(`click ${i + 1}/${clicks}: status=${r.status} ms=${r.ms} finalUrl=${r.finalUrl}`);
  }
  return { ok: true, clicks: results, egressIp };
}

module.exports.main = main;

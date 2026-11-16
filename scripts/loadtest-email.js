/**
 * Load-test the public /email redirect and prove each hit registers as a click.
 *
 * loader.io deliberately does not follow a redirect to a host you have not
 * verified, and glizzitrium.com is a third-party tracker, so a loader.io run
 * measures the 307 and stops there — the destination never sees the request.
 * k6 follows the hop itself, and each iteration ends with the click's own
 * tracker cookie in hand, which is the proof that the click was registered.
 *
 *   k6 run scripts/loadtest-email.js                         # 50 VUs, ~2m
 *   VUS=200 DURATION=3m k6 run scripts/loadtest-email.js
 *   TARGET_URL=http://localhost:3000/email k6 run scripts/loadtest-email.js
 *   FOLLOW_DEEPER=1 k6 run scripts/loadtest-email.js         # continue to the offer
 *
 * Install k6 with your package manager, or run the container:
 *   docker run --rm -i -v "$PWD:/src" -w /src grafana/k6 run scripts/loadtest-email.js
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const TARGET_URL = __ENV.TARGET_URL || 'https://voni.cc/email';
const EXPECT_HOST = __ENV.EXPECT_HOST || 'www.glizzitrium.com';
const VUS = Number(__ENV.VUS || 50);
const RAMP = __ENV.RAMP || '30s';
const DURATION = __ENV.DURATION || '2m';
const FOLLOW_DEEPER = Number(__ENV.FOLLOW_DEEPER || 0) === 1;

const edgeOk = new Counter('email_edge_ok');
const clickOk = new Counter('email_click_ok');

export const options = {
  scenarios: {
    email_redirect: {
      executor: 'ramping-vus',
      startVUs: 0,
      gracefulRampDown: '10s',
      stages: [
        { duration: RAMP, target: VUS },
        { duration: DURATION, target: VUS },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    checks: ['rate>0.98'],
    'http_req_duration{hop:edge}': ['p(95)<1500'],
    'http_req_duration{hop:click}': ['p(95)<8000'],
    email_click_ok: ['count>0'],
  },
};

export default function () {
  // Hop 1: our own 307. redirects:0 keeps k6 from swallowing the location.
  const edge = http.get(TARGET_URL, { redirects: 0, tags: { hop: 'edge' } });
  const location = edge.headers.location || edge.headers.Location;

  if (
    !check(edge, {
      'edge returns a 307': (r) => r.status === 307,
      'edge sends a Location': () => Boolean(location),
    }) ||
    !location
  ) {
    return;
  }

  // k6 has no WHATWG URL global, so the location is checked as text.
  if (
    !check(location, {
      'destination host is the tracker': (l) =>
        l.startsWith(`https://${EXPECT_HOST}/`) || l.startsWith(`http://${EXPECT_HOST}/`),
      'destination carries a source': (l) => /[?&]utm_source=[^&#]+/.test(l),
    })
  ) {
    return;
  }
  edgeOk.add(1);

  // Hop 2: the tracker. A 2xx/3xx here means the click was accepted, and the
  // cookie it sets is the click id, not just a happy status code.
  const click = http.get(location, {
    redirects: FOLLOW_DEEPER ? 10 : 0,
    tags: { hop: 'click' },
  });

  const registered = check(click, {
    'click accepted': (r) => r.status >= 200 && r.status < 400,
    'click registered (tracker cookie)': (r) =>
      Object.keys(r.cookies).some(
        (name) => name.startsWith('uniqueClick_') || name.startsWith('transaction_id'),
      ),
  });
  if (registered) clickOk.add(1);

  // Start each iteration as a fresh visitor: without this the transaction_id
  // cookie grows by one id per hit and the request header balloons.
  const jar = http.cookieJar();
  for (const name of Object.keys(jar.cookiesForURL(location))) {
    jar.delete(location, name);
  }
}

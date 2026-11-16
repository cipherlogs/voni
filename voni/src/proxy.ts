import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { devBypassEnabled } from "@/lib/dev-bypass";

const PROTECTED_PREFIXES = [
  "/dashboard",
  "/agents",
  "/campaigns",
  "/leads",
  "/numbers",
  "/calls",
  "/jobs",
  "/settings",
  "/operator",
];

const APP_PATHS = ["/login", "/signup", ...PROTECTED_PREFIXES];

const DEMO_PATHS = new Set(["/demo", "/demo/"]);
const DEMO_FALLBACK_URL = "https://www.google.com";
const DEMO_NO_STORE = "no-store, no-cache, must-revalidate, max-age=0";

const EMAIL_PATHS = new Set(["/email", "/email/"]);
export const EMAIL_TARGETS = [
  "https://www.glizzitrium.com/BCMPW39K/CZ562T2/",
  "https://www.glizzitrium.com/BCMPW39K/9SQWKW9/?creative_id=86784",
  "https://www.glizzitrium.com/BCMPW39K/J345SSD/?creative_id=691100",
  "https://www.glizzitrium.com/BCMPW39K/JJRFMXZ/?creative_id=709876",
  "https://www.glizzitrium.com/BCMPW39K/946KZGB/?creative_id=710986",
];

/**
 * Who the click should appear to come from: five broadband ISPs and five email
 * providers in one bag. A redirect cannot set the browser's `Referer`, so the
 * source rides as a query key the destination's tracker already reads.
 */
export const EMAIL_PROVIDERS = [
  "xfinity.com",
  "spectrum.com",
  "att.com",
  "verizon.com",
  "cox.com",
  "gmail.com",
  "outlook.com",
  "yahoo.com",
  "icloud.com",
  "proton.me",
];
export const EMAIL_SOURCE_PARAM = "utm_source";

/**
 * Draw without replacement: every entry appears once per pass, in its own
 * shuffled order, then the bag refills. `random` is injectable so a test can
 * pin the order. Instances live as long as the Edge isolate serving the proxy,
 * so a cold start simply begins a new shuffle.
 */
export function shuffleBag<T>(
  items: readonly T[],
  random: () => number = Math.random,
): () => T {
  let order: T[] = [];
  let cursor = 0;
  return () => {
    if (cursor >= order.length) {
      order = [...items];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      cursor = 0;
    }
    return order[cursor++];
  };
}

const nextEmailTarget = shuffleBag(EMAIL_TARGETS);
const nextEmailProvider = shuffleBag(EMAIL_PROVIDERS);

/**
 * Stable public link voni.cc/demo -> DEMO_REDIRECT_URL (307, never cached).
 * Target lives in the env so it can be re-pointed without a code edit.
 * Query strings from the incoming request are forwarded.
 * Note: Next normalizes /demo/ to /demo with its standard 308 first;
 * that hop only caches the slash mapping, never the target — /demo
 * itself is always 307 no-store, so re-pointing takes effect immediately.
 */
function demoRedirect(request: NextRequest): NextResponse | null {
  const { host, pathname, search } = request.nextUrl;
  if (!DEMO_PATHS.has(pathname)) return null;

  const landingHost = process.env.LANDING_HOST;
  if (landingHost) {
    const appHost = safeAppHost();
    if (host !== landingHost && host !== `www.${landingHost}`) {
      // App host (or unknown host): not the public demo link.
      if (!appHost || host === appHost) return null;
    }
  }

  const rawTarget =
    process.env.DEMO_REDIRECT_URL?.trim() || DEMO_FALLBACK_URL;
  let destination: URL;
  try {
    destination = new URL(rawTarget);
  } catch {
    destination = new URL(DEMO_FALLBACK_URL);
  }
  if (destination.protocol !== "http:" && destination.protocol !== "https:") {
    destination = new URL(DEMO_FALLBACK_URL);
  }
  if (search) {
    const incoming = new URLSearchParams(search);
    incoming.forEach((value, key) => {
      if (!destination.searchParams.has(key)) {
        destination.searchParams.set(key, value);
      }
    });
  }

  const response = NextResponse.redirect(destination, 307);
  response.headers.set("Cache-Control", DEMO_NO_STORE);
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  return response;
}

/**
 * Stable public link voni.cc/email -> random EMAIL_TARGETS entry (307, never cached).
 * Each hit draws a target and a provider from their own no-repeat bag, and the
 * provider travels as `utm_source`. Exact URLs, incoming query dropped.
 * Landing host only, same host gate as demoRedirect.
 * Server-side 307, so it works with JS disabled.
 */
function emailRedirect(request: NextRequest): NextResponse | null {
  const { host, pathname } = request.nextUrl;
  if (!EMAIL_PATHS.has(pathname)) return null;

  const landingHost = process.env.LANDING_HOST;
  if (landingHost) {
    const appHost = safeAppHost();
    if (host !== landingHost && host !== `www.${landingHost}`) {
      // App host (or unknown host): not the public email link.
      if (!appHost || host === appHost) return null;
    }
  }

  const destination = new URL(nextEmailTarget());
  destination.searchParams.set(EMAIL_SOURCE_PARAM, nextEmailProvider());
  const emailResponse = NextResponse.redirect(destination, 307);
  emailResponse.headers.set("Cache-Control", DEMO_NO_STORE);
  emailResponse.headers.set("Pragma", "no-cache");
  emailResponse.headers.set("Expires", "0");
  return emailResponse;
}

function safeAppHost(): string | null {
  try {
    const appUrl = process.env.BETTER_AUTH_URL;
    if (!appUrl) return null;
    return new URL(appUrl).host;
  } catch {
    return null;
  }
}

/**
 * Production serves two hosts from one Worker: the landing (and its demo) on
 * LANDING_HOST, everything else on the BETTER_AUTH_URL host. Unset (dev,
 * preview) means one host serves everything, as before.
 */
function hostRedirect(request: NextRequest): NextResponse | null {
  const landingHost = process.env.LANDING_HOST;
  const appUrl = process.env.BETTER_AUTH_URL;
  if (!landingHost || !appUrl) return null;
  const { host, pathname, search } = request.nextUrl;
  if (host === landingHost || host === `www.${landingHost}`) {
    const appPath = APP_PATHS.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );
    if (appPath) return NextResponse.redirect(new URL(`${pathname}${search}`, appUrl));
    if (host !== landingHost) {
      return NextResponse.redirect(`https://${landingHost}${pathname}${search}`, 301);
    }
  } else if (host === new URL(appUrl).host && pathname === "/") {
    return NextResponse.redirect(new URL("/dashboard", appUrl));
  }
  return null;
}

export function proxy(request: NextRequest) {
  const demo = demoRedirect(request);
  if (demo) return demo;
  const email = emailRedirect(request);
  if (email) return email;
  const redirect = hostRedirect(request);
  if (redirect) return redirect;
  const path = request.nextUrl.pathname;
  const protectedRoute = PROTECTED_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
  if (protectedRoute && !devBypassEnabled() && !getSessionCookie(request)) {
    const destination = new URL("/login", request.url);
    destination.searchParams.set("next", `${path}${request.nextUrl.search}`);
    return NextResponse.redirect(destination);
  }
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-voni-next-path", `${path}${request.nextUrl.search}`);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: [
    "/",
    "/demo",
    "/demo/",
    "/email",
    "/email/",
    "/login",
    "/signup",
    "/dashboard/:path*",
    "/agents/:path*",
    "/campaigns/:path*",
    "/leads/:path*",
    "/numbers/:path*",
    "/calls/:path*",
    "/jobs/:path*",
    "/settings/:path*",
    "/operator/:path*",
  ],
};

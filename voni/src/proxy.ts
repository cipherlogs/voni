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

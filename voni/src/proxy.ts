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
  "/settings",
];

export function proxy(request: NextRequest) {
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
    "/dashboard/:path*",
    "/agents/:path*",
    "/campaigns/:path*",
    "/leads/:path*",
    "/numbers/:path*",
    "/calls/:path*",
    "/settings/:path*",
  ],
};

import { Suspense } from "react";
import { connection } from "next/server";
import { Badge } from "@/components/ui/badge";
import { LandingDemo } from "@/components/landing-demo";
import { LandingHeader } from "@/components/landing-header";
import { GridListShowcase } from "@/components/landing-grid-list";
import { headers } from "next/headers";
import { VoniLogo } from "@/components/voni-logo";
import { auth } from "@/lib/auth";
import { devBypassEnabled } from "@/lib/dev-bypass";

/* One gutter for the whole page, so the header logo, the hero, and the feature
   grid all sit on the same left edge instead of each finding its own. */
const CONTAINER = "mx-auto w-full max-w-6xl px-6";

/**
 * Session-dependent header controls behind their own boundary (Task 9): the
 * hero and feature content prerender without awaiting authentication.
 */
async function LandingHeaderGate() {
  const authBypassed = devBypassEnabled();
  const session = authBypassed
    ? null
    : await auth.api.getSession({ headers: await headers() });
  return (
    <LandingHeader
      initialAuthenticated={Boolean(session)}
      authBypassed={authBypassed}
    />
  );
}

/**
 * Request-time footer leaf (Task 9): isolates the current-year read so the
 * rest of the landing page stays prerenderable. No fixed year invented.
 */
async function FooterYear() {
  // Request-time leaf: runs per request behind its boundary, never in the
  // static shell.
  await connection();
  return <>© {new Date().getFullYear()} Voni</>;
}

export default function LandingPage() {
  return (
    <div className="flex flex-1 flex-col">
      <Suspense fallback={null}>
        <LandingHeaderGate />
      </Suspense>

      <section data-testid="landing-shell" className={`${CONTAINER} flex flex-col items-center gap-7 py-24 text-center md:py-32`}>
        <Badge variant="secondary">Live voice calls</Badge>
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-balance md:text-[3.25rem] md:leading-[1.08]">
          An AI employee with a mission, not another chatbot
        </h1>
        <p className="text-muted-foreground max-w-xl text-lg leading-relaxed text-balance">
          Describe the outcome you want. Your agent calls leads, remembers
          every conversation across phone and WhatsApp, and shows you exactly
          why it made each decision.
        </p>

        {/* Live-demo widget: Vapi's pattern (mic + scenario + one-click call)
            — see plan Section E. Public and unauthenticated, so it runs in
            demo mode against a server-owned stored agent, behind per-IP and
            per-day rate limits. */}
        <div className="w-full pt-4">
          <LandingDemo />
        </div>
      </section>

      <section className="border-t">
        <div className={`${CONTAINER} py-16 md:py-20`}>
          <GridListShowcase />
        </div>
      </section>

      <footer className="border-t">
        <div
          className={`${CONTAINER} text-muted-foreground flex flex-col items-center justify-between gap-4 py-8 text-sm sm:flex-row`}
        >
          <span className="flex items-center gap-2">
            <VoniLogo size="sm" />
            <span>It sees the lead. It seals the deal.</span>
          </span>
          <Suspense fallback={<span>© Voni</span>}>
            <FooterYear />
          </Suspense>
        </div>
      </footer>
    </div>
  );
}

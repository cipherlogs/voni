import { Suspense } from "react";
import { Badge } from "@/components/ui/badge";
import { LandingDemo } from "@/components/landing-demo";
import { LandingHeader } from "@/components/landing-header";
import { GridListShowcase } from "@/components/landing-grid-list";
import { headers } from "next/headers";
import { FooterYear, PUBLIC_CONTAINER, SiteFooter } from "@/components/site-footer";
import { auth } from "@/lib/auth";
import { devBypassEnabled } from "@/lib/dev-bypass";

/* Public gutter is shared from site-footer.tsx (PUBLIC_CONTAINER) so the landing
   document and the shared footer cannot drift apart. */

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



export default function LandingPage() {
  return (
    <div className="flex flex-1 flex-col">
      <Suspense fallback={null}>
        <LandingHeaderGate />
      </Suspense>

      <section data-testid="landing-shell" className={`${PUBLIC_CONTAINER} flex flex-col items-center gap-7 py-16 text-center md:py-24`}>
        <Badge variant="secondary">Live voice calls</Badge>
        <h1 className="max-w-3xl font-editorial text-4xl font-medium tracking-tight text-balance md:text-5xl md:leading-tight">
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
            per-day rate limits. Constrained to the document measure so the
            widget reads as part of the hero composition, not a bolted-on
            embed. */}
        <div className="mx-auto w-full max-w-2xl pt-4">
          <LandingDemo />
        </div>
      </section>

      <section className="border-t">
        <div className={`${PUBLIC_CONTAINER} py-16 md:py-20`}>
          <GridListShowcase />
        </div>
      </section>

      <SiteFooter
        year={
          <Suspense fallback={<span>© Voni</span>}>
            <FooterYear />
          </Suspense>
        }
      />
    </div>
  );
}

import { Suspense } from "react";
import { LandingDemo } from "@/components/landing-demo";
import { LandingHeader } from "@/components/landing-header";
import { LandingOrb } from "@/components/landing-orb";
import { LandingPlay } from "@/components/landing-play";
import {
  LandingBento,
  LandingFaq,
  LandingFooter,
  LandingJourney,
  LandingMarquee,
  LandingSteps,
} from "@/components/landing-sections";
import { headers } from "next/headers";
import { FooterYear, PUBLIC_CONTAINER } from "@/components/site-footer";
import { auth } from "@/lib/auth";
import { devBypassEnabled } from "@/lib/dev-bypass";

/* Measured to the approved B1 mockup (DESIGN.md §10c): 1152px measure on
   desktop, 16px gutters on phones. The public gutter literal lives in
   site-footer.tsx (PUBLIC_CONTAINER) so nothing drifts. */
const SECTION = `${PUBLIC_CONTAINER} max-md:px-4`;

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

/* The mockup balances section headings on desktop only; phones wrap naturally. */
/* Phones set their own leading; md:text-title brings its token line-height. */
const SECTION_HEADING = "text-3xl leading-[1.15] font-semibold tracking-[-0.025em] md:text-title md:leading-(--text-title--line-height)";

export default function LandingPage() {
  return (
    <div className="landing-page bg-background flex flex-1 flex-col">
      <a
        href="#main"
        className="bg-background sr-only z-50 rounded-md border px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      {/* Same-height placeholder: when the session check streams in late,
          the header no longer pushes the hero down (measured CLS 0.045). */}
      <Suspense fallback={<div className="h-14 border-b md:h-16" />}>
        <LandingHeaderGate />
      </Suspense>
      <LandingPlay />

      <main id="main" className="flex flex-col">
        {/* One-column B1 hero (DESIGN.md §10c): claim on top, the live call
            card beneath it at the mockup's 880px. The card's green Start call
            is the page's only call to action. */}
        <section data-testid="landing-shell" className="relative">
          <div aria-hidden="true" className="landing-grid-bg absolute inset-0" />
          <div className={`${SECTION} relative flex flex-col items-center gap-8 pt-10 pb-14 md:gap-14 md:pt-22 md:pb-24`}>
            <div className="flex flex-col items-center gap-4.5 text-center md:gap-6">
              <span className="bg-background inline-flex h-7 items-center rounded-full border px-2.5 text-xs font-medium">
                Phone and WhatsApp voice agents
              </span>
              <h1 className="font-editorial text-hero-sm md:text-hero max-w-225 font-medium tracking-[-0.03em] text-balance">
                Every call ends with the work <em>already done</em>
              </h1>
              <p className="text-muted-foreground max-w-140 text-base leading-[1.6] text-balance md:text-lg md:leading-[1.6]">
                Voni answers and places your calls, then books the slot, updates
                the record and sends the <span className="whitespace-nowrap">follow-up</span>. You decide what happens
                after each call.
              </p>
            </div>

            {/* The call card is VoiceCall's demo layout (orb portrait inside,
                §10c). Public and unauthenticated, so it runs in demo mode
                against a server-owned stored agent, behind per-IP and per-day
                limits. */}
            <div id="demo" className="w-full scroll-mt-24 md:max-w-220">
              <LandingDemo />
            </div>
          </div>
        </section>

        <section aria-label="What the agent can do" className="bg-background border-y py-4.5 md:py-6">
          <LandingMarquee />
        </section>

        <section id="journey" className="scroll-mt-16">
          <div className={`${SECTION} flex flex-col gap-8 py-16 md:gap-12 md:py-24`}>
            <div className="flex flex-col gap-3 md:gap-3.5">
              <h2 className={SECTION_HEADING}>One call, and everything after it.</h2>
              <p className="text-muted-foreground max-w-140 text-base leading-[1.6] text-balance">
                One example from a property team. Voni books the viewing and
                schedules the WhatsApp follow-up, and nobody on the team updates
                the record by hand.
              </p>
            </div>
            <LandingJourney />
          </div>
        </section>

        <section id="features" data-play className="bg-muted/50 scroll-mt-16 border-t">
          <div className={`${SECTION} flex flex-col gap-8 py-16 md:gap-12 md:py-24`}>
            <h2 className={`${SECTION_HEADING} md:max-w-200 md:self-center md:text-center md:text-balance`}>
              A wizard builds the agent, and nothing goes live until you switch it on.
            </h2>
            <LandingBento />
          </div>
        </section>

        <section id="how" data-play className="scroll-mt-16 border-t">
          <div className={`${SECTION} flex flex-col gap-8 py-16 md:gap-14 md:py-24`}>
            <h2 className={SECTION_HEADING}>Test every campaign in dry run before it makes a real call.</h2>
            <LandingSteps />
          </div>
        </section>

        <section id="faq" className="scroll-mt-16 border-t">
          <div className={`${SECTION} flex flex-col gap-6 py-16 md:flex-row md:gap-24 md:py-24`}>
            <div className="flex shrink-0 flex-col gap-3.5 md:w-90">
              <h2 className={SECTION_HEADING}>Before you let it make calls for you</h2>
              <p className="text-muted-foreground text-base leading-[1.6]">
                Rather listen?{" "}
                <a href="#demo" className="text-foreground underline underline-offset-3">
                  Call the demo agent
                </a>
                .
              </p>
            </div>
            <div className="flex-1">
              <LandingFaq />
            </div>
          </div>
        </section>

        <section className="landing-lazy border-t">
          <div className={`${SECTION} flex flex-col items-center gap-5 py-16 text-center md:gap-6 md:py-28`}>
            <LandingOrb size="sm" />
            <h2 className="font-editorial text-display-sm md:text-display max-w-180 font-medium tracking-[-0.025em] md:text-balance">
              Call the demo agent, then build your own.
            </h2>
          </div>
        </section>
      </main>

      <LandingFooter
        year={
          <Suspense fallback={<span>© Voni</span>}>
            <FooterYear />
          </Suspense>
        }
      />
    </div>
  );
}

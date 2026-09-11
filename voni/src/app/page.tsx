import { Suspense } from "react";
import { connection } from "next/server";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Phone, MessageCircle, Wrench } from "lucide-react";
import { LandingDemo } from "@/components/landing-demo";
import { LandingHeader } from "@/components/landing-header";
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
        <div className={`${CONTAINER} grid gap-4 py-16 md:grid-cols-3 md:py-20`}>
          <FeatureCard
            icon={<Phone className="size-4" />}
            title="Goal-pursuing, not scripted"
            description="Your agent tracks Intent, Blocker, State, and Next Action for every lead — and picks up exactly where it left off on the next call."
          />
          <FeatureCard
            icon={<MessageCircle className="size-4" />}
            title="One conversation, every channel"
            description="Phone and WhatsApp feed the same lead timeline. A reply on WhatsApp is remembered on the next call — not a separate silo."
          />
          <FeatureCard
            icon={<Wrench className="size-4" />}
            title="Reasoning you can see"
            description="Every Blocker and Next Action is traced back to the tool call or transcript moment that produced it — not a black box."
          />
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

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Card className="interactive-card">
      <CardContent className="flex flex-col gap-3 py-2">
        <div className="bg-muted text-foreground flex size-8 items-center justify-center rounded-md">
          {icon}
        </div>
        <p className="font-medium">{title}</p>
        <p className="text-muted-foreground leading-relaxed">{description}</p>
      </CardContent>
    </Card>
  );
}

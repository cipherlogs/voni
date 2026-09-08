import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Phone, MessageCircle, Wrench } from "lucide-react";
import { LandingDemo } from "@/components/landing-demo";
import { ModeToggle } from "@/components/mode-toggle";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { VoniLogo } from "@/components/voni-logo";

/* One gutter for the whole page, so the header logo, the hero, and the feature
   grid all sit on the same left edge instead of each finding its own. */
const CONTAINER = "mx-auto w-full max-w-6xl px-6";

export default function LandingPage() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="bg-background/80 sticky top-0 z-40 border-b backdrop-blur-md">
        <div className={`${CONTAINER} flex h-16 items-center justify-between`}>
          <Link href="/" aria-label="Voni home" className="cursor-pointer rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            <VoniLogo size="sm" wordmark animate />
          </Link>
          <div className="flex items-center gap-1.5">
            <Button nativeButton={false} variant="ghost" render={<Link href="/login" />}>
              Sign in
            </Button>
            <Button nativeButton={false} render={<Link href="/signup" />}>
              Get started
            </Button>
            <div className="bg-border mx-1 h-5 w-px" />
            <ModeToggle />
          </div>
        </div>
      </header>

      <section className={`${CONTAINER} flex flex-col items-center gap-7 py-24 text-center md:py-32`}>
        <Badge variant="secondary">Built on AssemblyAI Voice Agent API</Badge>
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
          <span>© {new Date().getFullYear()} Voni</span>
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

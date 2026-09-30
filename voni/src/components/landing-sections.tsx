import type { ReactNode } from "react";
import { PUBLIC_CONTAINER } from "@/lib/public-container";
import { Mic, Minus, Phone, Plus } from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { cn } from "@/lib/utils";

/* Landing sections below the hero, measured to the approved B1 mockup
   (DESIGN.md §10c). Every animated visual is decorative and `aria-hidden`;
   the text beside it carries the meaning. Motion lives in globals.css
   `.landing-*` and stops under reduced motion. */

const TOOLS = [
  "Search",
  "Availability",
  "Booking",
  "Lead update",
  "Human transfer",
  "WhatsApp follow-up",
  "Calling windows",
  "Consent policy",
  "CSV import",
  "Call history",
  "Voice copilot",
  "Dry run",
];

export function LandingMarquee() {
  return (
    <div className="landing-edge-mask overflow-hidden">
      <ul className="landing-marquee text-foreground/60 md:text-md flex w-max gap-8 text-sm leading-[normal] font-medium md:gap-12">
        {[...TOOLS, ...TOOLS].map((tool, i) => (
          <li
            key={i}
            aria-hidden={i >= TOOLS.length || undefined}
            className="flex items-center gap-8 whitespace-nowrap md:gap-12"
          >
            {tool}
            <span className="bg-foreground/15 size-1 rounded-full" />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Cell({
  title,
  description,
  inverted = false,
  children,
}: {
  title: string;
  description: string;
  inverted?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2.5 rounded-xl border p-6 md:p-7",
        inverted ? "border-foreground bg-foreground text-background" : "bg-card",
      )}
    >
      <h3 className="text-lg leading-[normal] font-semibold tracking-[-0.01em]">{title}</h3>
      <p className={cn("text-sm leading-[1.55]", inverted ? "text-background/65" : "text-muted-foreground")}>
        {description}
      </p>
      <div aria-hidden="true" className="mt-auto pt-4">
        {children}
      </div>
    </div>
  );
}

const VOICES = ["Warm, unhurried", "Crisp, direct", "Bright, upbeat", "Calm, formal"];

function WizardCell() {
  return (
    <div className="bg-card flex flex-col gap-5 rounded-xl border p-6 md:col-span-2 md:flex-row md:gap-7 md:p-7">
      <div className="flex flex-col gap-2.5 md:w-65 md:shrink-0">
        <h3 className="text-lg leading-[normal] font-semibold tracking-[-0.01em]">A wizard that builds the agent</h3>
        <p className="text-muted-foreground text-sm leading-[1.55]">
          Pick the goal, personality, voice and language, hear a sample, then
          choose what it does after each call.
        </p>
      </div>
      <div aria-hidden="true" className="bg-muted/50 flex flex-1 flex-col gap-3 rounded-lg border p-4">
        <div className="flex gap-1.5">
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className={cn("h-1 flex-1 overflow-hidden rounded-full", i < 2 ? "bg-foreground" : "bg-border")}
            >
              {i === 2 ? <span className="landing-fill bg-foreground block h-full" /> : null}
            </span>
          ))}
        </div>
        <div className="flex items-center justify-between">
          <span className="text-foreground/60 text-xs">Step 3 of 4 · Voice</span>
          <span className="landing-bars">
            {Array.from({ length: 10 }, (_, i) => (
              <span key={i} />
            ))}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {VOICES.map((voice, i) => (
            <div
              key={voice}
              className={cn(
                "bg-card text-ui flex h-13 items-center gap-2.5 rounded-lg border px-3",
                i === 0 && "border-foreground",
              )}
            >
              <span className={cn("size-5.5 shrink-0 rounded-full", i === 0 ? "bg-foreground" : "bg-border")} />
              <span className="truncate">{voice}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function LandingBento() {
  return (
    <div className="flex flex-col gap-3 md:grid md:grid-cols-3 md:gap-4">
      <WizardCell />
      <Cell
        title="Remembers across channels"
        description="Tuesday's call and Thursday's WhatsApp reply are on the same record."
      >
        <div className="text-ui flex flex-col gap-1.5 leading-[normal]">
          <span className="landing-seq bg-muted self-start rounded-[10px] rounded-bl-[3px] px-3 py-2">
            Can I bring my partner?
          </span>
          <span className="landing-seq landing-seq-2 bg-foreground text-background self-end rounded-[10px] rounded-br-[3px] px-3 py-2">
            Of course. Saturday 10:30 still works.
          </span>
          <span className="landing-seq landing-seq-3 text-foreground/60 flex items-center gap-1.5 self-start text-xs">
            <Phone className="size-3" />
            From Tuesday&apos;s call: two-bed, June
          </span>
        </div>
      </Cell>
      <Cell
        title="Dry run by default"
        description="Every campaign has a consent policy and calling windows. It makes no real calls until you switch it to live."
      >
        <div className="flex flex-col gap-3">
          <div className="flex justify-between text-xs">
            <span className="font-medium">Calling window</span>
            <span className="text-foreground/60 font-mono">09:00 to 18:00</span>
          </div>
          <div className="bg-muted relative h-1.5 overflow-x-clip rounded-full">
            <span className="bg-foreground/15 absolute inset-y-0 right-[22%] left-[30%] rounded-full" />
            <span className="landing-now absolute inset-x-0 -top-[5px] h-4">
              <span className="bg-foreground absolute left-[30%] h-full w-0.5 rounded-full" />
            </span>
          </div>
          <div className="text-ui flex h-11 items-center justify-between rounded-lg border px-3.5">
            Go live
            <span className="bg-border relative h-5 w-8.5 rounded-full">
              <span className="bg-background absolute top-0.5 left-0.5 size-4 rounded-full shadow-sm" />
            </span>
          </div>
        </div>
      </Cell>
      <Cell
        title="Transfers with a summary"
        description="When the agent can't answer, it transfers the call and gives your teammate a written summary."
      >
        <div className="bg-muted/50 text-ui text-foreground/70 rounded-lg border p-3">
          <span className="text-foreground/60 text-2xs block pb-1 font-mono tracking-[0.06em]">
            HANDOFF BRIEF
          </span>
          Wants a pet clause before signing. Budget confirmed
          <span className="landing-caret bg-foreground ml-0.5 inline-block h-3.5 w-px align-[-2px]" />
        </div>
      </Cell>
      <Cell
        inverted
        title="Voice copilot"
        description="Speak a command and confirm it. The copilot opens pages, fills in the wizard and runs actions like pausing a campaign."
      >
        <div className="border-background/15 text-ui text-background/85 flex h-11 items-center gap-2.5 rounded-full border px-1.5">
          <span className="relative size-8 shrink-0">
            <span className="landing-pulse bg-background/25 absolute inset-0 rounded-full" />
            <span className="bg-background/15 text-background absolute inset-0 flex items-center justify-center rounded-full">
              <Mic className="size-3.5" />
            </span>
          </span>
          <span className="flex-1 truncate">&quot;Pause Maple Street&quot;</span>
          <span className="landing-glow bg-background text-foreground flex h-8 items-center rounded-full px-3 font-medium">
            Confirm
          </span>
        </div>
      </Cell>
    </div>
  );
}

/* One lead through the loop, as the lead record shows it. Tool names are the
   real ones in `lib/tools/definitions.ts`; the lead and times are an example
   and the section says so (PRODUCT.md: no invented outcomes or metrics). */
const JOURNEY = [
  ["Tue 10:00", "New lead from your CSV import", "Two-bed apartment, moving in June.", []],
  ["Tue 10:05", "Voni calls inside your calling window", "Budget and moving date confirmed on the call.", ["update_lead"]],
  ["Tue 10:08", "Viewing booked", "Saturday 10:30, checked against your calendar.", ["check_availability", "book_viewing"]],
  ["Tue 10:09", "WhatsApp follow-up scheduled", "Thursday evening, with the address and time.", ["schedule_follow_up"]],
  ["Thu 18:40", "The lead writes back on WhatsApp", "\"Can I bring my partner?\" The agent answers using notes from Tuesday's call.", []],
] as const;

export function LandingJourney() {
  return (
    <div className="bg-card overflow-hidden rounded-xl border">
      <div className="bg-muted/50 flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3 text-sm">
        <span className="font-medium">Example lead · two-bed, June</span>
        <span className="text-foreground/60 font-mono text-xs">Phone + WhatsApp · one record</span>
      </div>
      <ol>
        {JOURNEY.map(([time, event, detail, tools]) => (
          <li
            key={time}
            className="flex flex-col gap-1.5 border-t px-5 py-4 first:border-t-0 md:grid md:grid-cols-[7rem_minmax(0,1fr)_auto] md:items-baseline md:gap-6"
          >
            <span className="text-foreground/60 font-mono text-xs tabular-nums">{time}</span>
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">{event}</span>
              <span className="text-muted-foreground text-sm">{detail}</span>
            </div>
            {tools.length > 0 ? (
              <span className="flex flex-wrap gap-1.5">
                {tools.map((tool) => (
                  <code key={tool} className="bg-muted text-foreground/70 rounded px-1.5 py-0.5 font-mono text-xs">
                    {tool}
                  </code>
                ))}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

const STEPS = [
  ["01", "Describe the outcome", "Tell the wizard what a good call looks like and what should happen after it. It builds the agent and its tools."],
  ["02", "Rehearse in dry run", "Each campaign previews its calls before any go out. You review them and adjust the agent."],
  ["03", "Go live", "Switch the campaign to live. It calls only inside your calling windows and transfers stuck calls to your team."],
] as const;

export function LandingSteps() {
  return (
    <div className="relative overflow-x-clip">
      <div
        aria-hidden="true"
        className="bg-border absolute top-5 bottom-15 left-[19px] w-px md:top-[19px] md:right-1/3 md:bottom-auto md:left-5 md:h-px md:w-auto"
      >
        <span className="landing-travel" />
      </div>
      <ol className="relative flex flex-col gap-8 md:grid md:grid-cols-3 md:gap-12">
        {STEPS.map(([n, title, body], i) => (
          <li key={n} className="flex gap-4 md:flex-col md:gap-3.5">
            <span
              className={cn(
                "flex size-10 shrink-0 items-center justify-center rounded-full border font-mono text-xs",
                i === STEPS.length - 1 ? "border-foreground bg-foreground text-background" : "bg-background",
              )}
            >
              {n}
            </span>
            <div className="flex flex-col gap-1.5 pt-2 md:gap-3.5 md:pt-0">
              <h3 className="md:text-lead text-base leading-[normal] font-semibold md:tracking-[-0.01em]">{title}</h3>
              <p className="text-muted-foreground text-sm leading-[1.55] md:max-w-75">{body}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

const FAQ = [
  ["replace", "Does Voni replace my team?", "No. It handles the calls and the work after them. When a caller needs a person, it transfers the call with a written summary."],
  ["consent", "Will it call people who haven't agreed to it?", "Campaigns follow your consent policy and calling windows, and start as dry runs. Nothing goes live until you switch it on."],
  ["field", "What kinds of calls can it handle?", "Any call that ends in a clear next step: checking availability, booking, updating a record, scheduling a follow-up or transferring to your team. The example on this page is property."],
  ["languages", "Which languages can it speak?", "English, Spanish, French, German, Italian, and Portuguese. You pick the language and voice in the wizard."],
] as const;

export function LandingFaq() {
  return (
    <Accordion defaultValue={["replace"]} className="landing-faq border-t">
      {FAQ.map(([value, question, answer]) => (
        <AccordionItem key={value} value={value} className="border-b not-last:border-b">
          <AccordionTrigger className="text-md min-h-15 items-center gap-4 rounded-none py-0 font-medium hover:no-underline md:text-base">
            {question}
            <Plus className="text-muted-foreground ml-auto size-4 shrink-0 group-aria-expanded/accordion-trigger:hidden" />
            <Minus className="text-muted-foreground ml-auto hidden size-4 shrink-0 group-aria-expanded/accordion-trigger:block" />
          </AccordionTrigger>
          <AccordionContent className="text-muted-foreground text-md pr-8 pb-5">
            {answer}
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

const FOOTER_LINKS = [
  ["#demo", "Live demo", "hidden md:inline"],
  ["#faq", "FAQ", "hidden md:inline"],
  ["/privacy", "Privacy", ""],
  ["/terms", "Terms", ""],
  ["/login", "Sign in", ""],
] as const;

/** The landing's light footer strip (mockup B1). Auth screens keep SiteFooter. */
export function LandingFooter({ year }: { year: ReactNode }) {
  return (
    <footer className="border-t">
      <div className={`text-foreground/60 ${PUBLIC_CONTAINER} flex items-center justify-between py-6 max-md:px-4 md:h-20 md:py-0`}>
        <span className="font-mono text-xs tracking-[0.06em] uppercase">{year}</span>
        <nav aria-label="Footer" className="text-ui flex gap-4 leading-[normal] md:gap-6">
          {FOOTER_LINKS.map(([href, label, visibility]) => (
            <a
              key={href}
              href={href}
              className={cn("hover:text-foreground inline-flex h-11 items-center transition-colors md:h-auto", visibility)}
            >
              {label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}

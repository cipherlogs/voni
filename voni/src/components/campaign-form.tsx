"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/loading-button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { TriangleAlert } from "lucide-react";
import {
  DEFAULT_CALLING_WINDOW,
  DEFAULT_CONSENT_POLICY,
  WEEKDAY_LABELS,
} from "@/lib/campaigns/policy";
import { createCampaignAction } from "@/app/(dashboard)/campaigns/actions";

/**
 * Campaign creation (plan Day 7-8).
 *
 * Ordered the way an operator already expects from every list-and-send tool
 * they have used: name it, pick who works it, say when calling is allowed, then
 * say how persistent to be. Leads are imported *after* creation rather than as
 * a step here, because an import is something you repeat — a campaign is not.
 *
 * Every field ships with a working default, so the fast path is "type a name,
 * choose an agent, create". The rest is there to be adjusted, not filled in.
 */

/** Server bounds (mirrored from campaigns/actions.ts): 1–10 attempts, 5–10080 min. */
const MAX_ATTEMPTS_MIN = 1;
const MAX_ATTEMPTS_MAX = 10;
const RETRY_MINUTES_MIN = 5;
const RETRY_MINUTES_MAX = 10080;

const clampInt = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.trunc(value)));

/** A common set, offered by name so nobody has to recall IANA spelling. */
const TIMEZONES = [
  "Asia/Dubai",
  "Asia/Riyadh",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Europe/London",
  "Europe/Paris",
  "America/New_York",
  "America/Los_Angeles",
  "UTC",
];

export function CampaignForm({
  agents,
  workspaceTimezone,
}: {
  agents: { id: string; name: string; deployed: string | null }[];
  /** The workspace's stored timezone, when the loader could read it. */
  workspaceTimezone?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Field-scoped server error: the server returns one message (its zod
  // first-issue), so map it back onto the control it names instead of leaving
  // it only in the bottom alert.
  const [fieldError, setFieldError] = useState<"numeric" | null>(null);

  // Smart default: prefer the first deployed agent — a draft agent can own a
  // campaign but can never dial it, so defaulting to agents[0] when it is a
  // draft just moves the failure to activation time.
  const defaultAgentId =
    agents.find((agent) => agent.deployed)?.id ?? agents[0]?.id ?? "";
  // Smart default: the workspace's own timezone when it is in the offered
  // list, so the window says what the workspace already runs in.
  const defaultTimezone =
    workspaceTimezone && TIMEZONES.includes(workspaceTimezone)
      ? workspaceTimezone
      : DEFAULT_CALLING_WINDOW.timezone;
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState(defaultAgentId);
  const [start, setStart] = useState(DEFAULT_CALLING_WINDOW.start);
  const [end, setEnd] = useState(DEFAULT_CALLING_WINDOW.end);
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [days, setDays] = useState<number[]>(DEFAULT_CALLING_WINDOW.daysOfWeek);
  const [consent, setConsent] = useState(DEFAULT_CONSENT_POLICY.require);
  const [maxAttempts, setMaxAttempts] = useState("2");
  const [retryAfterMinutes, setRetryAfterMinutes] = useState("60");

  // Numeric guards: the inputs are text-state (never NaN), clamped to the
  // server bounds (1–10 attempts, 5–10080 min) on submit, with inline
  // FieldError + aria-invalid while out of range so the problem is visible
  // next to the control that causes it, not after a round trip.
  const parsedAttempts = maxAttempts.trim() === "" ? NaN : Number(maxAttempts);
  const parsedRetry = retryAfterMinutes.trim() === "" ? NaN : Number(retryAfterMinutes);
  const attemptsInvalid =
    !Number.isInteger(parsedAttempts) ||
    parsedAttempts < MAX_ATTEMPTS_MIN ||
    parsedAttempts > MAX_ATTEMPTS_MAX;
  const retryInvalid =
    !Number.isInteger(parsedRetry) ||
    parsedRetry < RETRY_MINUTES_MIN ||
    parsedRetry > RETRY_MINUTES_MAX;

  // Validated here as well as on the server so the problem is visible next to
  // the control that causes it, rather than after a round trip.
  const windowInvalid = end <= start;
  const blocked =
    !name.trim() ||
    !agentId ||
    days.length === 0 ||
    windowInvalid ||
    attemptsInvalid ||
    retryInvalid ||
    pending;

  // Any deviation from the shipped defaults counts as something to lose, so
  // the Cancel guard below fires on real input, not on mount.
  const dirty =
    name.trim() !== "" ||
    agentId !== defaultAgentId ||
    start !== DEFAULT_CALLING_WINDOW.start ||
    end !== DEFAULT_CALLING_WINDOW.end ||
    timezone !== defaultTimezone ||
    days.join(",") !== DEFAULT_CALLING_WINDOW.daysOfWeek.join(",") ||
    consent !== DEFAULT_CONSENT_POLICY.require ||
    maxAttempts !== "2" ||
    retryAfterMinutes !== "60";

  function submit() {
    setError(null);
    setFieldError(null);
    startTransition(async () => {
      const result = await createCampaignAction({
        name,
        agentId,
        callingWindow: { start, end, timezone, daysOfWeek: days },
        consentPolicy: { require: consent },
        maxAttempts: clampInt(parsedAttempts, MAX_ATTEMPTS_MIN, MAX_ATTEMPTS_MAX),
        retryAfterMinutes: clampInt(parsedRetry, RETRY_MINUTES_MIN, RETRY_MINUTES_MAX),
      });
      if (!result.ok) {
        setError(result.message);
        // The server's zod schema names attempts/retry bounds explicitly —
        // surface that message next to the numeric controls as well as in
        // the bottom alert.
        if (/attempt|retr|between|greater|less|number|integer/i.test(result.message)) {
          setFieldError("numeric");
        }
        return;
      }
      // Straight to the campaign, where the next step — importing leads — is
      // the most prominent thing on the page.
      router.push(`/campaigns/${result.id}`);
    });
  }

  if (agents.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <p className="font-medium">You need an agent first</p>
          <p className="text-muted-foreground max-w-sm text-sm">
            A campaign is the work you give an agent. Create one, publish it, then
            come back and point a campaign at it.
          </p>
          <Button nativeButton={false} render={<Link href="/agents/new" />}>
            Create an agent
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6" data-copilot-form="campaign">
      <section
        aria-labelledby="campaign-who-heading"
        className="grid gap-6 md:grid-cols-3"
      >
        <div>
          <h2 id="campaign-who-heading" className="text-balance font-semibold">
            Who works this campaign
          </h2>
          <p className="text-pretty text-muted-foreground text-sm leading-6">
            Name it, then pick the agent that places the calls.
          </p>
        </div>
        <div className="sm:max-w-3xl md:col-span-2">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="campaign-name">Campaign name</FieldLabel>
              <Input
                id="campaign-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Marina 2BR enquiries — September"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="campaign-agent">Agent</FieldLabel>
              <Select value={agentId} onValueChange={(v) => setAgentId(v ?? "")}>
                <SelectTrigger id="campaign-agent" aria-label="Agent" className="w-full">
                  <SelectValue placeholder="Select an agent" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {agents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name}
                        {agent.deployed ? "" : " (draft)"}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            {agentId && !agents.find((a) => a.id === agentId)?.deployed ? (
              <p className="text-muted-foreground text-xs">
                This agent is still a draft. You can create the campaign now, but
                publishing the agent is required before it can start calling.
              </p>
            ) : null}
            </Field>
          </FieldGroup>
        </div>
      </section>

      <Separator />

      <section
        aria-labelledby="campaign-when-heading"
        className="grid gap-6 md:grid-cols-3"
      >
        <div>
          <h2 id="campaign-when-heading" className="text-balance font-semibold">
            When calling is allowed
          </h2>
          <p className="text-pretty text-muted-foreground text-sm leading-6">
            The window and days the dialer may place calls in.
          </p>
        </div>
        <div className="sm:max-w-3xl md:col-span-2">
          <FieldGroup className="grid gap-4 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="window-start">Start</FieldLabel>
              <Input
                id="window-start"
                type="time"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="window-end">End</FieldLabel>
              <Input
                id="window-end"
                type="time"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="window-timezone">Timezone</FieldLabel>
              <Select value={timezone} onValueChange={(v) => setTimezone(v ?? timezone)}>
                <SelectTrigger id="window-timezone" aria-label="Timezone" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {TIMEZONES.map((zone) => (
                      <SelectItem key={zone} value={zone}>
                        {zone}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          {windowInvalid ? (
            <FieldError className="text-xs">
              The end time has to be after the start time. Overnight windows are
              not supported.
            </FieldError>
          ) : null}

          <Field data-invalid={days.length === 0}>
            <FieldLabel>Days</FieldLabel>
            <ToggleGroup
              multiple
              value={days.map(String)}
              onValueChange={(values) =>
                setDays(
                  (Array.isArray(values) ? values : [])
                    .map(Number)
                    .filter((d) => Number.isInteger(d) && d >= 0 && d < 7)
                    .sort((a, b) => a - b),
                )
              }
              variant="outline"
              aria-label="Calling days"
              className="flex flex-wrap"
            >
              {WEEKDAY_LABELS.map((label, day) => (
                <ToggleGroupItem
                  key={label}
                  value={String(day)}
                  aria-label={label}
                  aria-pressed={days.includes(day)}
                >
                  {label.slice(0, 3)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {days.length === 0 ? (
              <FieldError className="text-xs">Pick at least one day.</FieldError>
            ) : null}
          </Field>

          <Field>
            <FieldLabel htmlFor="consent-policy">Consent</FieldLabel>
            <Select
              value={consent}
              onValueChange={(v) => setConsent(v as typeof consent)}
            >
              <SelectTrigger id="consent-policy" aria-label="Consent" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="granted">
                    Only leads who explicitly consented
                  </SelectItem>
                  <SelectItem value="not_revoked">
                    Anyone who has not opted out
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Leads marked as opted out are never called, under either setting.
            </p>
          </Field>
        </div>
      </section>

      <Separator />

      <section
        aria-labelledby="campaign-how-heading"
        className="grid gap-6 md:grid-cols-3"
      >
        <div>
          <h2 id="campaign-how-heading" className="text-balance font-semibold">
            How persistent to be
          </h2>
          <p className="text-pretty text-muted-foreground text-sm leading-6">
            How many tries per lead, and how long to wait between them.
          </p>
        </div>
        <div className="sm:max-w-3xl md:col-span-2">
          <FieldGroup className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={attemptsInvalid || fieldError === "numeric"}>
            <FieldLabel htmlFor="max-attempts">Call attempts per lead</FieldLabel>
            <Input
              id="max-attempts"
              type="number"
              min={MAX_ATTEMPTS_MIN}
              max={MAX_ATTEMPTS_MAX}
              value={maxAttempts}
              onChange={(e) => setMaxAttempts(e.target.value)}
              aria-invalid={attemptsInvalid ? true : undefined}
              aria-describedby={
                attemptsInvalid ? "max-attempts-error" : undefined
              }
            />
            {attemptsInvalid ? (
              <FieldError id="max-attempts-error">
                Use a whole number from {MAX_ATTEMPTS_MIN} to {MAX_ATTEMPTS_MAX}.
              </FieldError>
            ) : fieldError === "numeric" && error ? (
              <FieldError>{error}</FieldError>
            ) : null}
          </Field>
          <Field data-invalid={retryInvalid || fieldError === "numeric"}>
            <FieldLabel htmlFor="retry-after">Wait between attempts (minutes)</FieldLabel>
            <Input
              id="retry-after"
              type="number"
              min={RETRY_MINUTES_MIN}
              max={RETRY_MINUTES_MAX}
              value={retryAfterMinutes}
              onChange={(e) => setRetryAfterMinutes(e.target.value)}
              aria-invalid={retryInvalid ? true : undefined}
              aria-describedby={retryInvalid ? "retry-after-error" : undefined}
            />
            {retryInvalid ? (
              <FieldError id="retry-after-error">
                Use a whole number from {RETRY_MINUTES_MIN} to {RETRY_MINUTES_MAX}.
              </FieldError>
            ) : fieldError === "numeric" && error ? (
              <FieldError>{error}</FieldError>
            ) : null}
          </Field>
          </FieldGroup>
        </div>
      </section>

      {error ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <LoadingButton onClick={submit} disabled={blocked} pending={pending} pendingText="Creating…">
          Create campaign
        </LoadingButton>
        <Button
          nativeButton={false}
          render={
            <Link
              href="/campaigns"
              onClick={(e) => {
                if (
                  dirty &&
                  !window.confirm(
                    "Leave without creating this campaign? Your entries will be lost.",
                  )
                ) {
                  e.preventDefault();
                }
              }}
            />
          }
          variant="ghost"
        >
          Cancel
        </Button>
        <p className="text-muted-foreground w-full text-sm">
          You will import leads on the next screen. Nothing is called until you
          activate the campaign.
        </p>
      </div>
    </div>
  );
}

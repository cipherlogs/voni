"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/loading-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
}: {
  agents: { id: string; name: string; deployed: string | null }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [start, setStart] = useState(DEFAULT_CALLING_WINDOW.start);
  const [end, setEnd] = useState(DEFAULT_CALLING_WINDOW.end);
  const [timezone, setTimezone] = useState(DEFAULT_CALLING_WINDOW.timezone);
  const [days, setDays] = useState<number[]>(DEFAULT_CALLING_WINDOW.daysOfWeek);
  const [consent, setConsent] = useState(DEFAULT_CONSENT_POLICY.require);
  const [maxAttempts, setMaxAttempts] = useState(2);
  const [retryAfterMinutes, setRetryAfterMinutes] = useState(60);

  const toggleDay = (day: number) =>
    setDays((current) =>
      current.includes(day)
        ? current.filter((d) => d !== day)
        : [...current, day].sort((a, b) => a - b),
    );

  // Validated here as well as on the server so the problem is visible next to
  // the control that causes it, rather than after a round trip.
  const windowInvalid = end <= start;
  const blocked =
    !name.trim() || !agentId || days.length === 0 || windowInvalid || pending;

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await createCampaignAction({
        name,
        agentId,
        callingWindow: { start, end, timezone, daysOfWeek: days },
        consentPolicy: { require: consent },
        maxAttempts,
        retryAfterMinutes,
      });
      if (!result.ok) {
        setError(result.message);
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
      <Card>
        <CardHeader>
          <CardTitle>Who works this campaign</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="campaign-name">Campaign name</Label>
            <Input
              id="campaign-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Marina 2BR enquiries — September"
            />
          </div>
          <div className="grid gap-2">
            <Label>Agent</Label>
            <Select value={agentId} onValueChange={(v) => setAgentId(v ?? "")}>
              <SelectTrigger aria-label="Agent" className="w-full">
                <SelectValue placeholder="Select an agent" />
              </SelectTrigger>
              <SelectContent>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                    {agent.deployed ? "" : " (draft)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {agentId && !agents.find((a) => a.id === agentId)?.deployed ? (
              <p className="text-muted-foreground text-xs">
                This agent is still a draft. You can create the campaign now, but
                publishing the agent is required before it can start calling.
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>When calling is allowed</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="window-start">Start</Label>
              <Input
                id="window-start"
                type="time"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="window-end">End</Label>
              <Input
                id="window-end"
                type="time"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label>Timezone</Label>
              <Select value={timezone} onValueChange={(v) => setTimezone(v ?? timezone)}>
                <SelectTrigger aria-label="Timezone" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((zone) => (
                    <SelectItem key={zone} value={zone}>
                      {zone}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {windowInvalid ? (
            <p className="text-destructive text-xs">
              The end time has to be after the start time. Overnight windows are
              not supported.
            </p>
          ) : null}

          <div className="grid gap-2">
            <Label>Days</Label>
            <div className="flex flex-wrap gap-2">
              {WEEKDAY_LABELS.map((label, day) => (
                <Button
                  key={label}
                  type="button"
                  size="sm"
                  variant={days.includes(day) ? "default" : "outline"}
                  onClick={() => toggleDay(day)}
                  aria-pressed={days.includes(day)}
                >
                  {label.slice(0, 3)}
                </Button>
              ))}
            </div>
            {days.length === 0 ? (
              <p className="text-destructive text-xs">Pick at least one day.</p>
            ) : null}
          </div>

          <div className="grid gap-2">
            <Label>Consent</Label>
            <Select
              value={consent}
              onValueChange={(v) => setConsent(v as typeof consent)}
            >
              <SelectTrigger aria-label="Consent" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="granted">
                  Only leads who explicitly consented
                </SelectItem>
                <SelectItem value="not_revoked">
                  Anyone who has not opted out
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Leads marked as opted out are never called, under either setting.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How persistent to be</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="max-attempts">Call attempts per lead</Label>
            <Input
              id="max-attempts"
              type="number"
              min={1}
              max={10}
              value={maxAttempts}
              onChange={(e) => setMaxAttempts(Number(e.target.value))}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="retry-after">Wait between attempts (minutes)</Label>
            <Input
              id="retry-after"
              type="number"
              min={5}
              max={10080}
              value={retryAfterMinutes}
              onChange={(e) => setRetryAfterMinutes(Number(e.target.value))}
            />
          </div>
        </CardContent>
      </Card>

      {error ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex items-center gap-3">
        <LoadingButton onClick={submit} disabled={blocked} pending={pending} pendingText="Creating…">
          Create campaign
        </LoadingButton>
        <p className="text-muted-foreground text-sm">
          You will import leads on the next screen. Nothing is called until you
          activate the campaign.
        </p>
      </div>
    </div>
  );
}

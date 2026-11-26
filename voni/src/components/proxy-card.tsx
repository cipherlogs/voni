"use client";

import { useActionState } from "react";
import { Network } from "lucide-react";
import { LoadingButton } from "@/components/loading-button";
import { useActionToast } from "@/components/action-feedback";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { useCardDisclosure } from "@/components/card-disclosure";
import { CollapsibleCardTitle } from "@/components/collapsible-card-title";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { ControlState } from "@/app/email/actions";
import {
  PROXY_COUNTRY,
  PROXY_POOL_MAX,
  PROXY_POOL_MIN,
  PROXY_PROVIDER,
  PROXY_STATUS_LABELS,
  asnLabel,
  describeProxyHealth,
  failureWords,
  isProxyReportStale,
  proxyReportAge,
  type ProxyHealthRead,
  type ProxySettings,
  type ProxyStatus,
} from "@/lib/email/proxy-policy";

/**
 * The Tuxler exit layer, before it is trusted with traffic.
 *
 * The card names the provider in its title, not only in a description an
 * operator has to read: "Proxy exits" asked "where is Tuxler?".
 *
 * The card answers three questions in the order an operator asks them: is the
 * client alive; if so, can it hold the pool; and if it can hold it, is there
 * quota to keep refilling it. Those are three different failures, so they get
 * three different headlines rather than one "unavailable" — a dead client, a
 * thin pool and a spent bucket send the operator to three different places.
 * The badge, the pool depth and (when there is one) the failure headline stay
 * in the header, so folding the card never hides how the pool is doing.
 *
 * The form is deliberately small. Country is not a control: the client refuses
 * any exit that is not US, so a dropdown would offer answers the system would
 * then have to refuse. The field travels as a fixed value so the server-side
 * refusal is still exercised, and the only choice is the pool target.
 *
 * `health` is read on the page, reset by reset. Nothing on this card spends a
 * change; the save writes two settings and the read is a plain `GET /health`.
 */

export type ProxyCardProps = {
  settings: ProxySettings;
  health: ProxyHealthRead;
  /** The request clock, so the report's age is one value per render. */
  now: Date;
  action: (previous: ControlState, formData: FormData) => Promise<ControlState>;
};

const INITIAL: ControlState = { ok: false };

const STATUS_VARIANT: Record<ProxyStatus, "default" | "secondary" | "destructive"> = {
  ok: "default",
  "short-of-exits": "secondary",
  "client-down": "destructive",
  "out-of-quota": "destructive",
};

/** A thin pool is a warning; a dead client or a spent budget is an error. */
const ALERT_VARIANT: Record<ProxyStatus, "default" | "destructive"> = {
  ok: "default",
  "short-of-exits": "default",
  "client-down": "destructive",
  "out-of-quota": "destructive",
};

function bucketName(depth: number | undefined): string {
  if (depth === undefined || depth === 0) return "Root bucket";
  return `Child bucket, depth ${depth}`;
}

export function ProxyCard({ settings, health, now, action }: ProxyCardProps) {
  const [state, formAction, saving] = useActionState(action, INITIAL);

  useActionToast(state, "Could not save the proxy settings", {
    successTitle: "Proxy saved",
  });

  const verdict = describeProxyHealth(health, settings.poolTarget);
  const reported = health.state === "reported" ? health.health : null;
  const stored =
    health.state === "reported" && health.source === "report" ? health : null;
  const stale = stored !== null && isProxyReportStale(stored.receivedAt, now);
  const age = stored === null ? null : proxyReportAge(stored.receivedAt, now);
  const provenance =
    health.state === "reported"
      ? health.source === "live"
        ? "Live client"
        : `Last Segment report · ${health.runnerOs} · ${proxyReportAge(health.receivedAt, now)}${stale ? " · stale" : ""}`
      : null;
  const exits = reported?.pool ?? [];
  const buckets = reported?.buckets ?? [];
  const failure = reported?.lastError ?? null;
  const reconnects = reported?.reconnects ?? 0;
  const refills = reported?.refills ?? 0;
  const { open, onOpenChange } = useCardDisclosure("email-proxy-card");

  return (
    <Card data-testid="email-proxy-card">
      <Collapsible
        open={open}
        onOpenChange={onOpenChange}
        className="group/card grid gap-(--card-spacing)"
      >
        <CardHeader className="gap-2">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <CollapsibleCardTitle
              icon={<Network className="size-4" />}
              testId="email-proxy-trigger"
            >
              Tuxler exits
            </CollapsibleCardTitle>

            <div className="flex flex-wrap items-center gap-2">
              <span
                className="text-muted-foreground font-mono text-xs whitespace-nowrap"
                data-testid="email-proxy-exits"
              >
                {stale ? "At last report: " : null}
                <span className="text-foreground font-medium">
                  {exits.length}
                </span>{" "}
                of {settings.poolTarget} exits ready
              </span>
              <Badge
                variant={stale ? "secondary" : STATUS_VARIANT[verdict.status]}
                data-testid="email-proxy-status"
              >
                {stale ? "Stale report" : PROXY_STATUS_LABELS[verdict.status]}
              </Badge>
            </div>
          </div>
          <CardDescription>
            The residential US exits the GitHub Source clicks through. Provider:{" "}
            {PROXY_PROVIDER}.
          </CardDescription>
          {provenance === null ? null : (
            <p
              className="text-muted-foreground font-mono text-xs"
              data-testid="email-proxy-provenance"
            >
              {provenance}
            </p>
          )}
          {/* The verdict stays in the header: a folded card that hid a dead
              client, a spent bucket or a report that is no longer current would
              be hiding the failure. */}
          {stale ? (
            <p
              className="text-sm font-medium"
              data-testid="email-proxy-headline"
            >
              The last report arrived {age}; nothing here is live.
            </p>
          ) : verdict.status === "ok" ? null : (
            <p
              className="text-sm font-medium"
              data-testid="email-proxy-headline"
            >
              {verdict.headline}
            </p>
          )}
        </CardHeader>

        <CollapsibleContent>
          <CardContent className="grid gap-4">
            {stale ? (
              <Alert>
                <AlertTitle>Last report, not a live reading</AlertTitle>
                <AlertDescription>
                  The last Segment reported {age}. The pool may have changed
                  since, so the counts below describe that run, not the pool
                  now.
                </AlertDescription>
              </Alert>
            ) : null}
            <Alert variant={ALERT_VARIANT[verdict.status]}>
              <AlertTitle>
                {stale
                  ? `At the last report: ${verdict.headline}`
                  : verdict.headline}
              </AlertTitle>
              <AlertDescription>{verdict.detail}</AlertDescription>
            </Alert>

            <section className="grid gap-2">
              <h3 className="text-sm font-medium">Ready exits</h3>
              {exits.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No US exit is ready right now.
                </p>
              ) : (
                <ul className="grid gap-1 text-sm">
                  {exits.map((exit) => (
                    <li
                      key={`${exit.ip}:${exit.city ?? ""}`}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
                    >
                      <span className="font-mono text-xs">{exit.ip}</span>
                      <span>{[exit.city, exit.state].filter(Boolean).join(", ") || "City not reported"}</span>
                      <span className="text-muted-foreground font-mono text-xs">
                        {exit.country} · {asnLabel(exit.asn) ?? "ASN not reported"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="grid gap-2">
              <h3 className="text-sm font-medium">Change budget</h3>
              {buckets.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {stored === null
                    ? "No bucket has reported a limit yet. Changes are spent on refills, never on clicks."
                    : "The Segment report carries no bucket snapshot, so per-bucket limits and changes are unknown. Its refill count is only an upper bound on changes spent."}
                </p>
              ) : (
                <ul className="grid gap-1 text-sm">
                  {buckets.map((bucket) => (
                    <li
                      key={bucket.clientIpHash ?? bucketName(bucket.depth)}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
                    >
                      <span>{bucketName(bucket.depth)}</span>
                      <span className="text-muted-foreground">
                        {bucket.used ?? "?"} spent
                        {bucket.limit === null ? " (unmetered)" : ` of ${bucket.limit}`} ·{" "}
                        {bucket.remaining ?? "?"} left
                      </span>
                      {bucket.resetAt === null ? null : (
                        <span className="text-muted-foreground font-mono text-xs">
                          resets {bucket.resetAt}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <p className="text-muted-foreground text-sm">
              Last failure:{" "}
              <span className="text-foreground">
                {failure === null ? "none reported" : failureWords(failure.reason)}
              </span>
              {refills === 0 ? null : ` · ${refills} refills`}
              {reconnects === 0 ? null : ` · ${reconnects} reconnects since the client started`}
            </p>

            <form action={formAction} className="grid gap-4 border-t pt-4">
              <Field>
                {/* The country is a fact, not a choice: the field exists so the
                    server validates it, and the client refuses any other value. */}
                <input type="hidden" name="country" value={PROXY_COUNTRY} />
                <FieldLabel htmlFor="email-proxy-country">Country</FieldLabel>
                <div className="flex items-center gap-2">
                  <span id="email-proxy-country">United States (US)</span>
                  <Badge variant="outline">US only</Badge>
                </div>
                <FieldDescription>
                  US only — the client refuses an exit in any other country, and the
                  server refuses a request that names one. Nothing else can be
                  stored.
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="email-proxy-pool-target">Pool target</FieldLabel>
                <Input
                  id="email-proxy-pool-target"
                  name="poolTarget"
                  type="number"
                  min={PROXY_POOL_MIN}
                  max={PROXY_POOL_MAX}
                  step={1}
                  defaultValue={settings.poolTarget}
                  disabled={saving}
                  className="max-w-40"
                />
                <FieldDescription>
                  Three to eight exits; five by default. The pool fills to this size
                  and starts a refill below three.
                </FieldDescription>
              </Field>

              <div className="flex flex-wrap items-center gap-3">
                <LoadingButton
                  type="submit"
                  pending={saving}
                  pendingText="Saving…"
                  icon={<Network />}
                  disabled={saving}
                >
                  Save proxy
                </LoadingButton>
              </div>
            </form>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

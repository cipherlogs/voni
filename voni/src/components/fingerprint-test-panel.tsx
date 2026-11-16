"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useVisitorData } from "@fingerprint/react";
import {
  AlertCircle,
  CheckCircle2,
  FingerprintIcon,
  LoaderCircle,
  RefreshCw,
  Server,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LoadingButton } from "@/components/loading-button";

/**
 * Shape of `POST /api/test/fingerprint` — see that route for the mapping from
 * Fingerprint's Server API. Kept here rather than imported so the test page
 * stays deletable in one piece.
 */
type VerifySuccess = {
  ok: true;
  eventId: string;
  visitorId: string | null;
  visitorFound: boolean | null;
  confidence: number | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  suspectScore: number | null;
  tampering: unknown;
  bot: unknown;
  raw: unknown;
};

type VerifyFailure = {
  ok: false;
  reason: string;
  message: string;
  status?: number;
};

type VerifyResponse = VerifySuccess | VerifyFailure;

type ServerState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; payload: VerifyResponse }
  | { status: "error"; message: string };

function isVerifyResponse(value: unknown): value is VerifyResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { ok?: unknown }).ok === "boolean"
  );
}

/** `FingerprintError` carries a `code`; the hook types it as plain `Error`. */
function errorCodeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground font-mono text-xs">{label}</dt>
      <dd className="font-mono text-sm break-all">{children}</dd>
    </div>
  );
}

function RawJson({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground font-mono text-xs">{label}</p>
      <pre className="bg-muted max-h-72 overflow-auto rounded-md p-3 font-mono text-xs leading-relaxed">
        {value === undefined ? "No data yet." : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

/**
 * The whole point of `/test`: identify this browser with the public key, then
 * look the resulting `event_id` up in Fingerprint's Server API with the secret
 * key. The two edits users make while debugging — flip a region, swap a key —
 * make one half succeed while the other fails, so both halves report
 * separately instead of collapsing into one "something went wrong".
 */
export function FingerprintTestPanel() {
  const {
    data,
    isLoading,
    isFetched,
    error,
    getData,
  } = useVisitorData({ immediate: true });
  const [server, setServer] = useState<ServerState>({ status: "idle" });
  const [verifying, setVerifying] = useState(false);

  const eventId = data?.event_id ?? null;

  const verify = useCallback(async (id: string) => {
    setVerifying(true);
    setServer({ status: "loading" });
    try {
      const response = await fetch("/api/test/fingerprint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: id }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!isVerifyResponse(payload)) {
        setServer({
          status: "error",
          message: `The verify route answered ${response.status} without a recognisable body.`,
        });
        return;
      }
      setServer({ status: "done", payload });
    } catch (cause) {
      setServer({
        status: "error",
        message:
          cause instanceof Error
            ? cause.message
            : "The verify request failed before it reached the server.",
      });
    } finally {
      setVerifying(false);
    }
  }, []);

  // Verify the first identification automatically so opening the page shows
  // the full round trip; the button re-runs it on demand afterwards. A ref
  // guards the one-shot per event id so the effect never needs its own state.
  const autoVerifiedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!eventId || autoVerifiedFor.current === eventId) return;
    autoVerifiedFor.current = eventId;
    void verify(eventId);
  }, [eventId, verify]);

  const errorCode = errorCodeOf(error);

  return (
    <div className="grid gap-6" data-testid="fingerprint-panel">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FingerprintIcon className="size-4" />
            Browser identification
          </CardTitle>
          <CardDescription>
            Public key <code className="font-mono">QVTz4…</code> · Global
            region. Everything in this card comes from the JS agent in your
            browser.
          </CardDescription>
          <CardAction>
            {isLoading ? (
              <Badge variant="secondary" data-testid="fingerprint-browser-status">
                Identifying…
              </Badge>
            ) : error ? (
              <Badge variant="destructive" data-testid="fingerprint-browser-status">
                Failed
              </Badge>
            ) : isFetched ? (
              <Badge data-testid="fingerprint-browser-status">Identified</Badge>
            ) : (
              <Badge variant="outline" data-testid="fingerprint-browser-status">
                Idle
              </Badge>
            )}
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-5">
          {error ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>The JS agent could not identify this browser</AlertTitle>
              <AlertDescription>
                {error.message}
                {errorCode ? (
                  <span className="mt-1 block font-mono text-xs">
                    code: {errorCode}
                  </span>
                ) : null}
                {errorCode === "script_load_fail" ? (
                  <span className="mt-2 block text-xs">
                    The agent script never loaded, so no identification was
                    attempted. This is almost always a content blocker (ad
                    blocker, Brave Shields, Firefox Enhanced Tracking
                    Protection) or a DNS/VPN filter stopping
                    fpnpmcdn.net, fpjscdn.net, or api.fpjs.io. Try an
                    incognito window with extensions off or allow-list those
                    hosts, then press Reload data.
                  </span>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}

          <dl className="grid gap-4 sm:grid-cols-2">
            <Field label="visitor_id">
              {data?.visitor_id ?? (
                <span className="text-muted-foreground">not returned</span>
              )}
            </Field>
            <Field label="event_id">{data?.event_id ?? "—"}</Field>
            <Field label="suspect_score">{data?.suspect_score ?? "—"}</Field>
            <Field label="cache_hit">
              {data?.cache_hit === undefined ? "—" : String(data.cache_hit)}
            </Field>
          </dl>

          {isFetched && data && !data.visitor_id ? (
            <Alert>
              <AlertTitle>visitor_id is missing on purpose</AlertTitle>
              <AlertDescription>
                Zero Trust mode or Sealed Client Results is enabled for this
                key, so the identifier is only available server-side. The
                Server API lookup below still resolves the event.
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <LoadingButton
              onClick={() => {
                void getData().catch(() => undefined);
              }}
              pending={isLoading}
              pendingText="Identifying…"
              icon={<RefreshCw />}
              data-testid="fingerprint-reload"
            >
              Reload data
            </LoadingButton>
            <LoadingButton
              variant="outline"
              onClick={() => {
                if (eventId) void verify(eventId);
              }}
              pending={verifying}
              pendingText="Verifying…"
              disabled={!eventId}
              icon={<Server />}
              data-testid="fingerprint-verify"
            >
              Verify on server
            </LoadingButton>
          </div>

          <RawJson label="raw GetResult" value={data} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="size-4" />
            Server verification
          </CardTitle>
          <CardDescription>
            Our route calls Fingerprint&apos;s Server API with the secret key
            and reports what Fingerprint stored for this event. Runs once
            automatically after identification.
          </CardDescription>
          <CardAction>
            {verifying ? (
              <Badge variant="secondary" data-testid="fingerprint-verify-status">
                Checking…
              </Badge>
            ) : server.status === "done" && server.payload.ok ? (
              <Badge data-testid="fingerprint-verify-status">Verified</Badge>
            ) : server.status === "done" || server.status === "error" ? (
              <Badge
                variant="destructive"
                data-testid="fingerprint-verify-status"
              >
                Not verified
              </Badge>
            ) : (
              <Badge
                variant="outline"
                data-testid="fingerprint-verify-status"
              >
                Waiting
              </Badge>
            )}
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-5">
          {server.status === "idle" ? (
            <p className="text-muted-foreground text-sm">
              Waiting for the browser identification to finish.
            </p>
          ) : null}

          {server.status === "loading" ? (
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <LoaderCircle className="size-4 animate-spin" />
              Asking api.fpjs.io…
            </p>
          ) : null}

          {server.status === "error" ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>Could not reach the verify route</AlertTitle>
              <AlertDescription>{server.message}</AlertDescription>
            </Alert>
          ) : null}

          {server.status === "done" && !server.payload.ok ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>Server did not verify this event</AlertTitle>
              <AlertDescription>
                {server.payload.message}
                <span className="mt-1 block font-mono text-xs">
                  reason: {server.payload.reason}
                  {server.payload.status
                    ? ` · upstream status ${server.payload.status}`
                    : ""}
                </span>
              </AlertDescription>
            </Alert>
          ) : null}

          {server.status === "done" && server.payload.ok ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge>
                  <CheckCircle2 />
                  Verified by server
                </Badge>
                {server.payload.visitorFound === true ? (
                  <Badge variant="outline">Returning visitor</Badge>
                ) : server.payload.visitorFound === false ? (
                  <Badge variant="outline">First seen</Badge>
                ) : null}
              </div>

              <dl className="grid gap-4 sm:grid-cols-2">
                <Field label="identification.visitor_id">
                  {server.payload.visitorId ?? "—"}
                </Field>
                <Field label="identification.visitor_found">
                  {server.payload.visitorFound === null
                    ? "—"
                    : String(server.payload.visitorFound)}
                </Field>
                <Field label="identification.confidence.score">
                  {server.payload.confidence === null
                    ? "—"
                    : server.payload.confidence.toFixed(3)}
                </Field>
                <Field label="event_id">{server.payload.eventId}</Field>
                <Field label="first_seen_at">
                  {formatTimestamp(server.payload.firstSeenAt)}
                </Field>
                <Field label="last_seen_at">
                  {formatTimestamp(server.payload.lastSeenAt)}
                </Field>
                <Field label="suspect_score">
                  {server.payload.suspectScore ?? "—"}
                </Field>
              </dl>

              <RawJson label="raw Server API event" value={server.payload.raw} />
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

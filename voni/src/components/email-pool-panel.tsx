"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Globe,
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
 * Shape of `POST /api/email-pool` — see `docs/agents/email-pool.md`. Kept here
 * rather than imported from the route so the panel stays a self-contained
 * client component.
 */
type PoolWorker = {
  worker: string;
  ok: boolean;
  reason: string | null;
  status?: number | null;
  ms?: number | null;
  colo?: string | null;
  region?: string | null;
  target?: string | null;
  finalUrl?: string | null;
  redirected?: boolean;
};

type PoolSuccess = {
  ok: true;
  visitId: string;
  target: string;
  source: string | null;
  workers: PoolWorker[];
};

type PoolFailure = {
  ok: false;
  reason: string;
  message: string;
};

type PoolResponse = PoolSuccess | PoolFailure;

type PanelState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; payload: PoolResponse }
  | { status: "error"; message: string };

function isPoolResponse(value: unknown): value is PoolResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { ok?: unknown }).ok === "boolean"
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground font-mono text-xs">{label}</dt>
      <dd className="font-mono text-sm break-all">{children}</dd>
    </div>
  );
}

function statusLabel(worker: PoolWorker): string {
  if (worker.ok) return "ok";
  return worker.reason && worker.reason.length > 0 ? worker.reason : "failed";
}

function WorkerRow({ worker }: { worker: PoolWorker }) {
  return (
    <li
      className="flex flex-wrap items-start justify-between gap-3 rounded-lg border px-3 py-2.5"
      data-testid="email-pool-worker"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <Server className="text-muted-foreground size-3.5" />
          <span className="font-mono text-sm font-medium">{worker.worker}</span>
        </div>
        {worker.ok && worker.redirected && worker.finalUrl ? (
          <span className="text-muted-foreground font-mono text-xs break-all">
            redirected to {worker.finalUrl}
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Badge
          variant={worker.ok ? "default" : "destructive"}
          data-testid="email-pool-worker-status"
        >
          {worker.ok ? <CheckCircle2 /> : <AlertCircle />}
          {statusLabel(worker)}
        </Badge>
        <span className="text-muted-foreground font-mono text-xs">
          HTTP {worker.ok ? (worker.status ?? "—") : "—"}
        </span>
        <span className="text-muted-foreground font-mono text-xs">
          {worker.ok && typeof worker.ms === "number" ? `${worker.ms} ms` : "— ms"}
        </span>
        <span
          className="text-muted-foreground font-mono text-xs"
          data-testid="email-pool-worker-region"
        >
          region {worker.ok ? (worker.region ?? "—") : "—"}
        </span>
        {worker.ok && worker.colo ? (
          <span
            className="text-muted-foreground font-mono text-xs"
            data-testid="email-pool-worker-colo"
          >
            colo {worker.colo}
          </span>
        ) : null}
      </div>
    </li>
  );
}

/**
 * `/email`: one drawn target, one claimed source, and a report from every
 * Worker in the pool. Runs once on mount because that is the whole point of the
 * page; the button re-runs it after a config change or a bad draw.
 *
 * Failures are never silent. A worker row shows its own reason, an unresolved
 * pool shows an Alert naming the missing env vars, and a dead route shows the
 * transport error.
 */
export function EmailPoolPanel() {
  const [state, setState] = useState<PanelState>({ status: "idle" });

  const run = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const response = await fetch("/api/email-pool", {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!isPoolResponse(payload)) {
        setState({
          status: "error",
          message: `The pool route answered ${response.status} without a recognisable body.`,
        });
        return;
      }
      setState({ status: "done", payload });
    } catch (cause) {
      setState({
        status: "error",
        message:
          cause instanceof Error
            ? cause.message
            : "The pool request failed before it reached the server.",
      });
    }
  }, []);

  // One automatic run per page load, as the fingerprint panel does: a ref
  // guards the one-shot so the effect never needs its own state.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    void run();
  }, [run]);

  const running = state.status === "loading";
  const payload = state.status === "done" ? state.payload : null;
  const workers = payload?.ok ? payload.workers : [];
  const answered = workers.filter((worker) => worker.ok).length;

  return (
    <div className="grid gap-6" data-testid="email-pool-panel">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="size-4" />
            Edge-worker pool
          </CardTitle>
          <CardDescription>
            Each Worker below fetches the drawn target from its own Cloudflare
            edge location with a real outbound request, following redirects
            wherever they lead. Targets are pages on voni.cc or off-site
            affiliate links, chosen server-side and never by the browser. Results
            run once on load; the button draws a new target and source. Each row
            shows the region the object was created with and, when the runtime
            reports one, the colo it actually ran in; the region is a
            best-effort hint.
          </CardDescription>
          <CardAction>
            {running ? (
              <Badge variant="secondary" data-testid="email-pool-status">
                Fanning out…
              </Badge>
            ) : state.status === "error" ? (
              <Badge variant="destructive" data-testid="email-pool-status">
                Failed
              </Badge>
            ) : payload && !payload.ok ? (
              <Badge variant="destructive" data-testid="email-pool-status">
                {payload.reason}
              </Badge>
            ) : payload ? (
              <Badge data-testid="email-pool-status">
                {answered} of {workers.length}
              </Badge>
            ) : (
              <Badge variant="outline" data-testid="email-pool-status">
                Idle
              </Badge>
            )}
          </CardAction>
        </CardHeader>

        <CardContent className="grid gap-5">
          {state.status === "loading" ? (
            <p className="text-muted-foreground text-sm">
              Asking every Worker in the pool…
            </p>
          ) : null}

          {state.status === "error" ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>Could not reach the pool route</AlertTitle>
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
          ) : null}

          {payload && !payload.ok ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>The email pool is not configured</AlertTitle>
              <AlertDescription>
                {payload.message}
                <span className="mt-1 block font-mono text-xs">
                  reason: {payload.reason}
                </span>
              </AlertDescription>
            </Alert>
          ) : null}

          {payload?.ok ? (
            <>
              <dl className="grid gap-4 sm:grid-cols-2">
                <Field label="target">
                  <a
                    className="underline underline-offset-4"
                    href={payload.target}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {payload.target}
                  </a>
                </Field>
                <Field label="source">{payload.source ?? "—"}</Field>
                <Field label="visit_id">{payload.visitId}</Field>
                <Field label="workers">{workers.length}</Field>
              </dl>

              <p className="text-sm font-medium" data-testid="email-pool-summary">
                {answered} of {workers.length} workers answered
              </p>

              {answered < workers.length ? (
                <Alert variant="destructive">
                  <AlertCircle />
                  <AlertTitle>
                    {workers.length - answered} worker
                    {workers.length - answered === 1 ? "" : "s"} did not come
                    back ok
                  </AlertTitle>
                  <AlertDescription>
                    The pool still reported every member separately, so the rows
                    below are the full picture. A dead or misconfigured Worker
                    does not hide the rest.
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert>
                  <CheckCircle2 />
                  <AlertTitle>Every worker answered</AlertTitle>
                  <AlertDescription>
                    Each Worker reported the status it saw for{" "}
                    <span className="font-mono">{payload.target}</span> and,
                    where the chain moved, the URL it ended on. A followed
                    redirect can land outside voni.cc.
                  </AlertDescription>
                </Alert>
              )}

              <ul className="grid gap-2">
                {workers.map((worker) => (
                  <WorkerRow key={worker.worker} worker={worker} />
                ))}
              </ul>
            </>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <LoadingButton
              onClick={() => {
                void run();
              }}
              pending={running}
              pendingText="Fanning out…"
              icon={<RefreshCw />}
              data-testid="email-pool-rerun"
            >
              Re-run
            </LoadingButton>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

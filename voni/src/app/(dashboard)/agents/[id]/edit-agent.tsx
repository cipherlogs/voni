"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "@/components/ui/toast";
import {
  Check,
  CircleCheck,
  LoaderCircle,
  Mic,
  RotateCw,
  TriangleAlert,
} from "lucide-react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { getJobProgressPercent } from "@/lib/jobs/ui-helpers";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/loading-button";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { BackLink } from "@/components/back-link";
import { AgentConfigForm } from "@/components/agent-config-form";
import { VoiceCall } from "@/components/voice-call";
import type { AgentConfig } from "@/lib/agents/config";
import type { JobJson } from "@/lib/jobs/serialize";
import { useJobs } from "@/components/jobs/jobs-provider";
import { useOptimisticJob } from "@/components/jobs/use-optimistic-job";
import { retryAgentDeploymentAction, updateAgentAction } from "../actions";
import { AgentDeleteButton } from "../delete-agent-button";

export type DeploymentState = "draft" | "queued" | "deploying" | "ready" | "failed";

/** LocalStorage key for one agent's unsaved edits, mirroring use-wizard-draft.ts. */
const editDraftKey = (agentId: string) => `voni:edit-draft:${agentId}`;

type EditDraftSnapshot = { name: string; config: AgentConfig };

/**
 * Pure snapshot parser (same shape as parseWizardDraftCache): corrupt,
 * partial, or foreign-shape payloads are rejected so the editor falls back to
 * the server state.
 */
export function parseEditDraftCache(raw: string | null): EditDraftSnapshot | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const v = parsed as Record<string, unknown>;
    if (typeof v.name !== "string") return null;
    if (typeof v.config !== "object" || v.config === null) return null;
    return { name: v.name, config: v.config as AgentConfig };
  } catch {
    return null;
  }
}

function readEditDraft(agentId: string): EditDraftSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    return parseEditDraftCache(window.localStorage.getItem(editDraftKey(agentId)));
  } catch {
    return null;
  }
}

/**
 * Border-only surfaces: the statusline, all banners, and the config form
 * cards and footer on this editor carry a border and no shadow token, per
 * the border-OR-shadow floor. The mockup arrived with a hairline lift plus
 * a wide, very soft drop, but border AND shadow together would break the
 * floor — so the elevation was dropped on both files.
 */

function deploymentLabel(state: DeploymentState): string {
  switch (state) {
    case "draft":
      return "Draft — not yet deployed";
    case "queued":
      return "Deployment queued";
    case "deploying":
      return "Deploying…";
    case "ready":
      return "Deployed and ready";
    case "failed":
      return "Deployment failed";
  }
}

/**
 * Edit an agent, and test it in the browser without a phone number —
 * plan Section F's free "Test this agent" browser call.
 *
 * Saves are local-first: the configuration writes immediately and deployment
 * runs as a background job, so the editor returns control at once. The
 * previous deployed version keeps taking calls until the new one succeeds.
 * This panel polls the latest deployment job while one is active so its
 * status banner resolves on its own if the user stays.
 *
 * Generation placeholders (created by /agents/new at Generate time) arrive
 * with `isGenerationStub` set and a placeholder voiceId/language: the
 * generating banner and test-call card stay gated until the generation job
 * succeeds, while saves stay gated only while generation is still in flight
 * — a failed, cancelled, or aged-out generation will never produce a config,
 * so manual edit-and-save must stay available. The generated config itself
 * lives in the job result and is consumed only on the canonical review
 * screen (/agents/new?job=<id>); this page never applies job.result, so the
 * ready banner links there instead of implying the form below holds it.
 */
export function EditAgent(props: {
  id: string;
  name: string;
  config: AgentConfig;
  initialDeploymentAttention?: boolean;
  deploymentStatus?: string;
  deploymentError?: string | null;
  /**
   * Null until the agent is registered with AssemblyAI. Its absence marks a
   * never-provisioned row, which shortens the delete dialog copy. Already
   * on the fetched row — no new query.
   */
  assemblyaiAgentId?: string | null;
  // Live generation state from getAgentWithGeneration: the job id, its
  // current status (null when the job aged out), and whether this row still
  // holds a placeholder config awaiting its reviewed save.
  generationJobId?: string | null;
  generationStatus?: string | null;
  /** Sanitized failure message for the did-not-finish banner; null when the
   * job did not fail (or aged out, where no row was found). */
  generationError?: string | null;
  isGenerationStub?: boolean;
  /** True when this agent is the platform bridge default — the delete dialog
   * carries a blocking note (the DB clears the default with the row). */
  isBridgeAgent?: boolean;
}) {
  const {
    id,
    name,
    config,
    initialDeploymentAttention = false,
    deploymentStatus = "draft",
    deploymentError = null,
    assemblyaiAgentId = null,
    generationJobId = null,
    generationStatus = null,
    generationError = null,
    isGenerationStub = false,
    isBridgeAgent = false,
  } = props;
  // Durable pre-save draft (mirrors use-wizard-draft.ts): unsaved edits
  // survive reload/navigation via localStorage, keyed by agent id. The cache
  // is cleared on every save, so anything present belongs to edits made after
  // the last save — recover it only when it actually differs from the server
  // state (a no-op cache from a clean save restores nothing).
  const serverSnapshot = JSON.stringify({ name, config });
  const [recovered] = useState<EditDraftSnapshot | null>(() => {
    const cached = readEditDraft(id);
    if (!cached) return null;
    try {
      if (JSON.stringify(cached) === serverSnapshot) return null;
      return cached;
    } catch {
      return null;
    }
  });
  const [current, setCurrent] = useState<AgentConfig>(() => recovered?.config ?? config);
  const [currentName, setCurrentName] = useState<string>(() => recovered?.name ?? name);
  const [restoredDraft, setRestoredDraft] = useState(recovered !== null);
  // Dirty when the live name/config differ from the last-saved snapshot.
  // The form reports both via onChange (name passthrough included).
  const [savedSnapshot, setSavedSnapshot] = useState<string>(() => serverSnapshot);
  const isDirty =
    JSON.stringify({ name: currentName, config: current }) !== savedSnapshot;

  // Persist every unsaved edit so reload/navigation restores the editor.
  // Best-effort: quota or private-mode failures never break the form.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (!isDirty) {
        window.localStorage.removeItem(editDraftKey(id));
        return;
      }
      window.localStorage.setItem(
        editDraftKey(id),
        JSON.stringify({ name: currentName, config: current }),
      );
    } catch {
      // Ignore write failures; in-memory state stays authoritative.
    }
  }, [id, isDirty, currentName, current]);

  // Unsaved edits survive reload now; still warn on reload/close while dirty.
  // Scoped to this editor on purpose — the creation wizard owns its own
  // navigation handling and shares the form component below.
  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);
  const [deployState, setDeployState] = useState<DeploymentState>(
    (["draft", "queued", "deploying", "ready", "failed"] as const).includes(
      deploymentStatus as DeploymentState,
    )
      ? (deploymentStatus as DeploymentState)
      : "draft",
  );
  const [deployMessage, setDeployMessage] = useState<string | null>(
    initialDeploymentAttention || deploymentStatus === "failed"
      ? (deploymentError ??
        "The configuration was saved, but voice deployment did not complete.")
      : null,
  );
  const [deployJobId, setDeployJobId] = useState<string | null>(null);
  // Determinate 0..100 deployment progress, when the job reports it.
  // Deployment jobs today never do (only csv-import reports progress), so
  // this stays null and the bar renders indeterminate — never an invented
  // number.
  const [deployPercent, setDeployPercent] = useState<number | null>(null);
  const [retrying, startRetry] = useTransition();
  // Single-flight guard for deployment retries (mirrors the generation
  // idempotency shape): a double-click or a retry-after-retry must not queue
  // duplicate deployment jobs. State (not a ref) drives the disabled prop —
  // refs cannot be read during render — plus a synchronous ref check in the
  // handler drops the second press of a double-click before state commits.
  const [retryQueued, setRetryQueued] = useState(false);
  const retryInFlight = useRef(false);
  const deployment = useOptimisticJob("agent_deployment");
  const generation = useOptimisticJob("agent_generation");
  const { markSeen } = useJobs();
  // Live copy of the generation status: starts at the server-rendered value
  // and flips when the watcher below observes the terminal state.
  const [liveGenerationStatus, setLiveGenerationStatus] = useState<string | null>(
    generationStatus,
  );

  // While a deployment job is active, watch it so the banner reflects the
  // outcome without a reload. Slow work still completes (and notifies)
  // through the pill and Jobs if the user leaves.
  useEffect(() => {
    if (!deployJobId) return;
    return deployment.trackExternal(
      deployJobId,
      { title: `Deploy ${name}`, kind: "agent_deployment" },
      (job: JobJson) => {
        setDeployPercent(getJobProgressPercent(job));
        if (job.status === "succeeded") {
          setDeployState("ready");
          setDeployMessage(null);
          toast.add({ type: "success", title: "Voice deployment is ready" });
          return;
        }
        setDeployState("failed");
        setDeployMessage(
          job.status === "cancelled"
            ? "Deployment was cancelled. The previous version is still live."
            : (job.errorMessage ?? "Voice deployment did not complete."),
        );
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deployJobId]);

  // While the generation job is still in flight, watch it so the banner flips
  // from generating to ready/failed without a reload. Status/copy only — the
  // generated config stays in the job result and is consumed exclusively on
  // the canonical review screen (/agents/new?job=<id>); this watcher never
  // applies job.result. It marks the job seen on terminal state so the
  // global ready-pill clears once the outcome is on screen.
  useEffect(() => {
    if (!isGenerationStub || !generationJobId) return;
    if (liveGenerationStatus !== "queued" && liveGenerationStatus !== "running") {
      return;
    }
    return generation.trackExternal(
      generationJobId,
      { title: "Generate agent draft", kind: "agent_generation" },
      (job: JobJson) => {
        setLiveGenerationStatus(job.status);
        if (job.status === "succeeded") {
          toast.add({ type: "success", title: "Configuration is ready to review" });
        }
        void markSeen(job.id);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGenerationStub, generationJobId]);

  const needsAttention = deployState === "failed" || deployMessage !== null;

  const generationRunning =
    isGenerationStub &&
    (liveGenerationStatus === "queued" || liveGenerationStatus === "running");
  const generationReady = isGenerationStub && liveGenerationStatus === "succeeded";
  // A stub's voiceId/language are placeholders until its generation job
  // succeeds, so test calls stay gated until the config is real. Saves stay
  // gated only while generation is still in flight — a terminal
  // (failed/cancelled/aged-out) generation will never produce a config, so
  // the banner's edit-and-save-manually path must stay open.
  const canTestCall = !isGenerationStub || generationReady;
  const canSave = !isGenerationStub || !generationRunning;

  // Direction B (task-split): on wide screens the config stream sits left
  // and the test call rides a sticky right rail; on small screens the test
  // card stacks first with a sticky bottom save bar. Backlink, heading, the
  // deployment statusline, and the generation banners all live inside the
  // left stream in that order, followed by the form and the delete card; the
  // rail is DOM-last inside the grid so tab order follows the primary
  // configure → test → save flow.
  // The mockup's deployment statusline: badge + explanatory copy + a
  // progress bar while a deploy is in flight. The bar is determinate only
  // when the job reports progress (see deployPercent); otherwise Base UI
  // renders it indeterminate with value={null}.
  const deployActive = deployState === "deploying" || deployState === "queued";
  // Onboarding-06 step markers + stats-11 progress idiom: draft → queued →
  // deploying → ready, with failed as the terminal alert state. Markers ride
  // the wizard-timeline idiom (filled Check when done, primary ring when
  // active, muted outline upcoming); the bar renders indeterminate with
  // value={null} until the job reports progress.
  const deployStepIndex =
    deployState === "ready" || deployState === "failed"
      ? 3
      : deployState === "deploying"
        ? 2
        : deployState === "queued"
          ? 1
          : 0;
  const deploySteps = ["Draft", "Queued", "Deploying", "Ready"] as const;
  const deployStatusCopy =
    deployState === "deploying"
      ? "Deploying new version… previous version still taking calls"
      : deployState === "queued"
        ? "Agent saved — voice deployment is running in the background"
        : deployState === "ready"
          ? "New calls use the saved version."
          : null;

  return (
    <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_25rem] lg:items-start">
      {/* Config stream. The mockup's vertical rhythm is not uniform, so the
          column is a block with per-child margins rather than a flex gap:
          backlink → h1 (8/4) → sub (16) → statusline (16) → each banner (16)
          → form → delete card (12 below the footer bar). */}
      <div className="min-w-0">
        <BackLink href="/agents" label="Agents" />
        {restoredDraft ? (
          <Alert className="mb-4 rounded-xl text-sm">
            <RotateCw />
            <AlertTitle>Unsaved edits restored</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>
                These edits were never saved. Save them, or discard to return
                to the last saved version.
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setCurrent(config);
                  setCurrentName(name);
                  setSavedSnapshot(serverSnapshot);
                  setRestoredDraft(false);
                  try {
                    window.localStorage.removeItem(editDraftKey(id));
                  } catch {
                    // Best-effort; in-memory state stays authoritative.
                  }
                }}
              >
                Discard restored edits
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        <h1 className="mt-2 mb-1 text-2xl font-semibold tracking-[-0.02em]">
          {name}
        </h1>
        <p className="text-muted-foreground mb-4 text-sm">
          Changes take effect on the next call this agent takes.
        </p>
        <div
          className="bg-card mb-4 flex flex-col gap-3 rounded-xl border px-3.5 py-3"
          aria-live="polite"
        >
          <ol className="flex items-stretch gap-1" aria-label="Deployment progress">
            {deploySteps.map((label, i) => {
              const failed = deployState === "failed";
              const done =
                i < deployStepIndex || (deployState === "ready" && i === deployStepIndex);
              const active = !failed && i === deployStepIndex;
              const failedHere = failed && i === deployStepIndex;
              return (
                <li key={label} className="flex min-w-0 flex-1 items-center gap-2">
                  <span
                    aria-hidden
                    className={
                      "flex size-5 shrink-0 items-center justify-center rounded-full text-xs " +
                      (done
                        ? "bg-primary text-primary-foreground"
                        : failedHere
                          ? "bg-destructive text-destructive-foreground"
                          : active
                            ? "border border-primary text-primary ring-1 ring-primary/30"
                            : "border text-muted-foreground")
                    }
                  >
                    {done ? (
                      <Check aria-hidden className="size-3" />
                    ) : failedHere ? (
                      <TriangleAlert aria-hidden className="size-3" />
                    ) : active && deployState === "deploying" ? (
                      <LoaderCircle aria-hidden className="size-3 animate-spin" />
                    ) : (
                      i + 1
                    )}
                  </span>
                  <span
                    className={
                      "flex min-w-0 flex-col items-start gap-0.5 text-left " +
                      (active || failedHere ? "font-medium" : "text-muted-foreground")
                    }
                  >
                    <span className="text-xs">Step {i + 1}</span>
                    <span className="min-w-0 truncate text-sm">{label}</span>
                  </span>
                </li>
              );
            })}
          </ol>
          <p className="text-sm font-medium">{deploymentLabel(deployState)}</p>
          {deployStatusCopy ? (
            <span className="text-muted-foreground text-xs">
              {deployStatusCopy}
            </span>
          ) : null}
          {deployActive ? (
            <Progress
              value={deployPercent}
              aria-label="Deployment progress"
              className="w-full [&_[data-slot=progress-track]]:h-1.5"
            />
          ) : null}
        </div>

        {isGenerationStub ? (
          generationRunning ? (
            <Alert className="mb-4 rounded-xl text-sm">
              <LoaderCircle className="animate-spin" />
              <AlertTitle>Configuration generating</AlertTitle>
              <AlertDescription>
                This agent&apos;s configuration is still being generated.
                Review, test, and save unlock when it&apos;s ready.{" "}
                <Link
                  href="/jobs"
                  className="focus-visible:ring-ring cursor-pointer rounded-sm underline underline-offset-4 outline-none focus-visible:ring-2"
                >
                  View progress in Jobs
                </Link>
              </AlertDescription>
            </Alert>
          ) : generationReady ? (
            <Alert className="mb-4 rounded-xl text-sm">
              <CircleCheck />
              <AlertTitle>Ready to review</AlertTitle>
              <AlertDescription>
                Generation finished. The result waits on the review screen —
                review and save it there; this form still shows the earlier
                draft.{" "}
                <Link
                  href={
                    generationJobId
                      ? `/agents/new?job=${generationJobId}`
                      : "/jobs"
                  }
                  className="focus-visible:ring-ring cursor-pointer rounded-sm underline underline-offset-4 outline-none focus-visible:ring-2"
                >
                  Review the generated configuration
                </Link>
              </AlertDescription>
            </Alert>
          ) : (
            <Alert className="mb-4 rounded-xl text-sm">
              <TriangleAlert />
              <AlertTitle>Generation didn&apos;t finish</AlertTitle>
              <AlertDescription className="flex flex-col gap-2">
                <span>
                  {generationError ??
                    "The generated configuration isn't available."}{" "}
                  Edit and save manually, or go back to the wizard to see the
                  error and retry.
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  {generationJobId ? (
                    <Button
                      nativeButton={false}
                      size="sm"
                      variant="outline"
                      render={<Link href={`/agents/new?job=${generationJobId}`} />}
                    >
                      Retry in the wizard
                    </Button>
                  ) : null}
                  <Link
                    href="/jobs"
                    className="focus-visible:ring-ring cursor-pointer rounded-sm text-xs underline underline-offset-4 outline-none focus-visible:ring-2"
                  >
                    View in Jobs
                  </Link>
                </span>
              </AlertDescription>
            </Alert>
          )
        ) : null}

        {needsAttention ? (
          <Alert
            variant="destructive"
            className="mb-4 rounded-xl text-sm"
          >
            <TriangleAlert />
            <AlertTitle>Saved, but voice deployment needs attention</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>
                {deployMessage} Phone calls will keep using the previous
                deployed version until this succeeds.
              </span>
              <LoadingButton
                type="button"
                variant="outline"
                size="sm"
                pending={retrying}
                pendingText="Queuing…"
                disabled={retryQueued}
                icon={<RotateCw />}
                onClick={() => {
                  // Single-flight: drop the click when a retry is already in
                  // flight. The ref flips synchronously so a double-click's
                  // second press is dropped before state commits;
                  // LoadingButton's pending-while-retrying keeps it disabled
                  // through the round trip.
                  if (retryInFlight.current) return;
                  retryInFlight.current = true;
                  setRetryQueued(true);
                  startRetry(async () => {
                    try {
                      // Stable per-agent retry key (mirrors
                      // generationIdempotencyKey): a retry-after-retry for the
                      // same saved version dedupes server-side instead of
                      // queueing a second deployment.
                      const result = await retryAgentDeploymentAction(id);
                      if (!result.ok) {
                        setDeployMessage(result.message);
                      } else if (result.deployment === "attention") {
                        setDeployState("failed");
                        setDeployMessage(
                          result.deploymentMessage ?? "Voice deployment did not complete.",
                        );
                      } else {
                        setDeployState("queued");
                        setDeployMessage(null);
                        setDeployJobId(result.jobId ?? null);
                        toast.add({ type: "success", title: "Deployment queued — it runs in the background" });
                      }
                    } finally {
                      // The deployment watcher owns the longer-lived "queued"
                      // state via deployJobId; this flag only guards the
                      // submit round trip itself.
                      retryInFlight.current = false;
                      setRetryQueued(false);
                    }
                  });
                }}
              >
                Retry deployment
              </LoadingButton>
            </AlertDescription>
          </Alert>
        ) : null}

        <AgentConfigForm
          initialName={name}
          initialConfig={config}
          submitLabel="Save changes"
          isDirty={isDirty}
          onChange={(next, nextName) => {
            setCurrent(next);
            setCurrentName(nextName);
          }}
          onSubmit={async (nextName, nextConfig) => {
            if (!canSave) {
              toast.add({
                type: "error",
                title: "Configuration is still generating — save once it is ready.",
              });
              return;
            }
            // Forwarded so the save upgrades the generation placeholder in
            // place (clearing generationJobId) once updateAgentAction accepts
            // it; today's three-arg signature ignores the extra argument.
            const save = updateAgentAction as (
              saveId: string,
              saveName: string,
              saveConfig: AgentConfig,
              opts?: { generationJobId?: string },
            ) => ReturnType<typeof updateAgentAction>;
            const result = await save(
              id,
              nextName,
              nextConfig,
              generationJobId ? { generationJobId } : undefined,
            );
            if (!result.ok) {
              toast.add({ type: "error", title: result.message });
              return;
            }
            if (result.deployment === "attention") {
              setDeployState("failed");
              setDeployMessage(
                result.deploymentMessage ?? "Voice deployment did not complete.",
              );
              setSavedSnapshot(JSON.stringify({ name: nextName, config: nextConfig }));
              setRestoredDraft(false);
              try {
                window.localStorage.removeItem(editDraftKey(id));
              } catch {
                // Best-effort; in-memory state stays authoritative.
              }
              return;
            }
            setDeployState("queued");
            setDeployMessage(null);
            setDeployJobId(result.jobId ?? null);
            setSavedSnapshot(JSON.stringify({ name: nextName, config: nextConfig }));
            setRestoredDraft(false);
            try {
              window.localStorage.removeItem(editDraftKey(id));
            } catch {
              // Best-effort; in-memory state stays authoritative.
            }
            toast.add({ type: "success", title: "Agent saved — voice deployment is running" });
          }}
          // Delete lives in the footer secondary slot (left on desktop,
          // full-width above Save on mobile) opening the same typed-name
          // dialog. The footer uses ConfigFormFooter's default document-flow
          // layout — no sticky positioning.
          footerSecondary={
            <AgentDeleteButton
              id={id}
              name={name}
              layout="full"
              redirectTo="/agents"
              // Live deployState, not the frozen server snapshot: once a
              // background deploy succeeds nothing remote is short-copy
              // anymore, even though the neverProvisioned prop can't update.
              neverProvisioned={!assemblyaiAgentId && deployState !== "ready"}
              isBridgeAgent={isBridgeAgent}
            />
          }
        />
      </div>

      <aside
        id="test-rail"
        aria-label="Test this agent"
        className="lg:sticky lg:top-[4.5rem] lg:z-10 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto lg:rounded-xl lg:bg-background"
      >
        {canTestCall ? (
          <>
            {/* The call card is the whole surface: VoiceCall already owns
                the border, padding, version strip, portrait, status, call
                button, and transcript. A wrapping Card here would nest a
                bordered card inside a duplicate header — nested cards are
                always wrong. */}
            {/* Keyed on the voice: it is immutable for the life of a session, so
                switching it has to start a fresh one rather than mutate this one.
                The previous transcript is discarded — disclosed at the picker. */}
            <VoiceCall
              key={current.voiceId}
              mode={{ kind: "inline", config: current, agentId: id, isDirty }}
            />
          </>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Mic />
              </EmptyMedia>
              <EmptyTitle>Test this agent</EmptyTitle>
              <EmptyDescription>
                Test calls unlock once generation finishes — the voice and
                language here are placeholders until then.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                nativeButton={false}
                size="sm"
                variant="outline"
                render={<Link href="/jobs" />}
              >
                View progress in Jobs
              </Button>
            </EmptyContent>
          </Empty>
        )}
      </aside>
    </div>
  );
}

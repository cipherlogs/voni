"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "@/components/ui/toast";
import {
  CircleCheck,
  LoaderCircle,
  RotateCw,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/loading-button";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { BackLink } from "@/components/back-link";
import { AgentConfigForm } from "@/components/agent-config-form";
import { TestAgentDialog } from "@/components/test-agent-dialog";
import type { AgentConfig } from "@/lib/agents/config";
import type { JobJson } from "@/lib/jobs/serialize";
import { useJobs } from "@/components/jobs/jobs-provider";
import { useOptimisticJob } from "@/components/jobs/use-optimistic-job";
import { shouldSuppressJobToast, jobErrorCopy, BACKGROUND_AFTER_MS } from "@/lib/jobs/ui-helpers";
import { UnsavedPill } from "@/components/unsaved-pill";
import { GenerationRetryCard } from "@/components/generation-retry-card";
import { retryAgentDeploymentAction, updateAgentAction } from "../actions";
import { AgentDeleteButton } from "../delete-agent-button";

export type DeploymentState = "draft" | "queued" | "deploying" | "ready" | "failed" | "cancelled";

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
 * Border-only surfaces: all banners, and the config form cards and footer on
 * this editor carry a border and no shadow token, per the border-OR-shadow
 * floor.
 */

/** States the deployment watcher can report, including jobs cancelled mid-flight. */
function coerceDeploymentState(status: string): DeploymentState {
  return (["draft", "queued", "deploying", "ready", "failed", "cancelled"] as const).includes(
    status as DeploymentState,
  )
    ? (status as DeploymentState)
    : "draft";
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
  /** Channel integration state, derived server-side — see AgentConfigForm. */
  phoneReady?: boolean | null;
  whatsappReady?: boolean | null;
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
    phoneReady = null,
    whatsappReady = null,
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
  const [deployState, setDeployState] = useState<DeploymentState>(() =>
    coerceDeploymentState(deploymentStatus),
  );
  const [deployMessage, setDeployMessage] = useState<string | null>(
    initialDeploymentAttention || deploymentStatus === "failed"
      ? (deploymentError ??
        "The configuration was saved, but voice deployment did not complete.")
      : null,
  );
  const [deployJobId, setDeployJobId] = useState<string | null>(null);
  const [retrying, startRetry] = useTransition();
  // Single-flight guard for deployment retries (mirrors the generation
  // idempotency shape): a double-click or a retry-after-retry must not queue
  // duplicate deployment jobs. State (not a ref) drives the disabled prop —
  // refs cannot be read during render — plus a synchronous ref check in the
  // handler drops the second press of a double-click before state commits.
  const [retryQueued, setRetryQueued] = useState(false);
  const retryInFlight = useRef(false);
  const router = useRouter();
  const deployment = useOptimisticJob("agent_deployment");
  const generation = useOptimisticJob("agent_generation");
  const { markSeen } = useJobs();
  // Live generation job snapshot for the terminal-retry card (Goal 6): the
  // server-rendered generationError is message-only, so the watcher keeps the
  // error code for jobErrorCopy. Null until a terminal watch resolves.
  const [liveGenerationErrorCode, setLiveGenerationErrorCode] = useState<string | null>(null);
  // Applying a live completion into the visible form (Goal 7): the form holds
  // its own state seeded once from props, so applying means bumping this key
  // to remount it with the new config — never a silent in-place mutation.
  const [appliedJobResult, setAppliedJobResult] = useState<{
    name: string;
    config: AgentConfig;
    jobId: string;
  } | null>(null);
  // Review/Apply affordance when the user is dirty-editing (Goal 7): the
  // completed config waits here instead of overwriting their edits.
  const [pendingJobResult, setPendingJobResult] = useState<{
    name: string;
    config: AgentConfig;
    jobId: string;
  } | null>(null);
  // Regeneration submit state (Goals 6–7): fresh-key start.
  const [regenInFlight, setRegenInFlight] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);
  // Backgrounded-regeneration notice (Goal 7): flips after
  // BACKGROUND_AFTER_MS without a terminal state.
  const [regenBackgrounded, setRegenBackgrounded] = useState(false);
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
        if (job.status === "succeeded") {
          setDeployState("ready");
          setDeployMessage(null);
          toast.add({ type: "success", title: "Voice deployment is ready" });
          return;
        }
        if (job.status === "cancelled") {
          setDeployState("cancelled");
          setDeployMessage(
            "Deployment was cancelled. The previous version is still live.",
          );
          return;
        }
        setDeployState("failed");
        setDeployMessage(job.errorMessage ?? "Voice deployment did not complete.");
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deployJobId]);

  // While the generation job is still in flight, watch it so the banner flips
  // from generating to ready/failed without a reload. Every terminal state
  // resolves live here (succeeded/failed/cancelled). Status/copy only — the
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
        setLiveGenerationErrorCode(job.errorCode ?? null);
        if (
          job.status === "succeeded" &&
          !shouldSuppressJobToast(job.kind, job.status, window.location.pathname)
        ) {
          toast.add({ type: "success", title: "Configuration is ready to review" });
        }
        void markSeen(job.id);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGenerationStub, generationJobId]);

  // Live snapshot refs for the regeneration completion below: the effect
  // fires once at completion time, so it reads the edit state then — not the
  // render-time closure. Synced in an effect (never during render).
  const liveEditRef = useRef({ name: currentName, dirty: isDirty });
  useEffect(() => {
    liveEditRef.current = { name: currentName, dirty: isDirty };
  }, [currentName, isDirty]);
  // Regeneration completion (Goal 7): the retry card's own start() onTerminal
  // already resolves every terminal state live (succeeded/failed/cancelled)
  // and flips the stub banner. This block owns only the succeeded-apply step:
  // job.result config lands in the visible form in place (remount + notice) —
  // EXCEPT when the user is dirty-editing, where a Review/Apply affordance
  // waits instead of a silent overwrite.
  useEffect(() => {
    const terminal = generation.result?.job;
    if (!terminal || terminal.status !== "succeeded") return;
    if (appliedJobResult?.jobId === terminal.id) return;
    if (pendingJobResult?.jobId === terminal.id) return;
    const result = terminal.result as {
      config?: AgentConfig;
    } | null;
    if (!result?.config) return;
    const live = liveEditRef.current;
    const applied = { name: live.name, config: result.config, jobId: terminal.id };
    if (live.dirty) {
      setPendingJobResult(applied);
    } else {
      setAppliedJobResult(applied);
      setSavedSnapshot(JSON.stringify({ name: live.name, config: result.config }));
      setCurrent(result.config);
      toast.add({ type: "success", title: "Regenerated configuration applied" });
    }
    // shouldSuppressJobToast: the toast above fires only on terminal jobs the
    // provider would not also toast for — agent_generation terminal states on
    // /agents/<id> are never suppressed (the rule covers /agents/new and
    // agent_deployment success), so exactly one toast fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation.result]);

  const needsAttention = deployState === "failed" || deployMessage !== null;

  const generationRunning =
    isGenerationStub &&
    (liveGenerationStatus === "queued" || liveGenerationStatus === "running");
  const generationReady = isGenerationStub && liveGenerationStatus === "succeeded";
  // Terminal stub failure (Goal 6): failed, cancelled, or aged-out (the job
  // row is gone so liveGenerationStatus is null). The retry card owns this
  // state and the empty config sections below hide.
  const generationTerminalFailure =
    isGenerationStub && !generationRunning && !generationReady;
  // A stub's voiceId/language are placeholders until its generation job
  // succeeds, so test calls stay gated until the config is real. Saves stay
  // gated only while generation is still in flight — a terminal
  // (failed/cancelled/aged-out) generation will never produce a config, so
  // the banner's edit-and-save-manually path must stay open.
  const canTestCall = !isGenerationStub || generationReady;
  const canSave = !isGenerationStub || !generationRunning;

  // The editor is a single reading column. Voice testing opens from the form
  // footer in a full-screen dialog, so the form keeps its full working width.
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      {/* Config stream. The column is a block with per-child margins rather
          than a flex gap: backlink → h1 (8/4) → sub (16) → each banner
          (16) → form. */}
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
        <UnsavedPill isDirty={isDirty} />
        <h1 className="mt-2 mb-1 text-2xl font-semibold tracking-[-0.02em]">
          {name}
        </h1>
        <p className="text-muted-foreground mb-4 text-sm">
          Changes take effect on the next call this agent takes.
        </p>

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
            // Terminal stub failure (Goal 6): the StepCard retry card owns
            // this state. Copy contract — (1) the draft didn't finish, (2)
            // the retry starts a fresh attempt, (3) a completed draft appears
            // here for review. Failure copy is jobErrorCopy(live code), never
            // generic; the server-rendered message covers the aged-out case
            // where no job row (and no code) exists.
            <div className="mb-4">
              <GenerationRetryCard
                title="Generation didn't finish"
                description={`${liveGenerationErrorCode ? jobErrorCopy(liveGenerationErrorCode) : (generationError ?? "The generated configuration isn't available.")} Retry to start a fresh attempt — a completed draft appears here for review.`}
                retrying={regenInFlight}
                onRetry={() => {
                  // Fresh-key retry (Goal 6): a new submission with a random
                  // nonce suffix, never the stable per-brief key — even though
                  // start.ts refuses to replay terminal rows, the retry is a
                  // fresh submission by construction.
                  if (regenInFlight) return;
                  setRegenInFlight(true);
                  setRegenError(null);
                  setRegenBackgrounded(false);
                  const brief = [
                    currentName.trim() ? `The agent is ${currentName.trim()}.` : null,
                    "Regenerate the full agent configuration.",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  const timer = setTimeout(() => setRegenBackgrounded(true), BACKGROUND_AFTER_MS);
                  void generation
                    .start(
                      {
                        brief,
                        wizardDraft: {
                          goals: current.goals ?? [],
                          tasks: current.tasks ?? [],
                          agentName: currentName.trim(),
                          styleTraits: current.styleTraits ?? [],
                          conversationLanguage: current.conversationLanguage ?? "en",
                          voiceId: current.voiceId,
                        },
                      },
                      {
                        title: "Regenerate agent draft",
                        idempotencyKey: `generation:retry:${crypto.randomUUID()}`,
                      },
                      (job: JobJson) => {
                        clearTimeout(timer);
                        setRegenInFlight(false);
                        setRegenBackgrounded(false);
                        setLiveGenerationStatus(job.status);
                        setLiveGenerationErrorCode(job.errorCode ?? null);
                        void markSeen(job.id);
                      },
                    )
                    .then((started) => {
                      clearTimeout(timer);
                      if (!started) {
                        setRegenInFlight(false);
                        setRegenBackgrounded(false);
                        setRegenError("This could not start. Check your connection and retry.");
                      }
                    });
                }}
                onOpenJobs={() => {
                  router.push("/jobs");
                }}
                retryTestId="generation-retry-stub"
              />
              {regenError ? (
                <p className="mt-2 text-muted-foreground text-sm">{regenError}</p>
              ) : null}
              {regenBackgrounded && regenInFlight ? (
                <p className="mt-2 text-muted-foreground text-sm">
                  This is continuing in the background. You can browse Voni and
                  return when it is ready.
                </p>
              ) : null}
            </div>
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

        {/* Review/Apply affordance (Goal 7): a live regeneration completed
            while the user was dirty-editing, so the fresh config waits here
            instead of silently overwriting their edits. */}
        {pendingJobResult ? (
          <Alert className="mb-4 rounded-xl border-primary/30 bg-primary/5 text-sm">
            <CircleCheck />
            <AlertTitle>Regenerated configuration ready</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>
                The regeneration finished while you had unsaved edits. Review
                it, then apply — or keep editing and it stays waiting.
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    setCurrent(pendingJobResult.config);
                    setSavedSnapshot(
                      JSON.stringify({
                        name: pendingJobResult.name,
                        config: pendingJobResult.config,
                      }),
                    );
                    setAppliedJobResult(pendingJobResult);
                    setPendingJobResult(null);
                    toast.add({ type: "success", title: "Regenerated configuration applied" });
                  }}
                >
                  Review and apply
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setPendingJobResult(null)}
                >
                  Keep my edits
                </Button>
              </span>
            </AlertDescription>
          </Alert>
        ) : null}
        {appliedJobResult && !isDirty ? (
          <Alert className="mb-4 rounded-xl text-sm">
            <CircleCheck />
            <AlertTitle>Regenerated configuration applied</AlertTitle>
            <AlertDescription>
              The live regeneration result is now in the form below — review
              and save it. Your previous view is gone; saving persists the new
              configuration.
            </AlertDescription>
          </Alert>
        ) : null}

        {/* Goal 6: on stub terminal failure the retry card above owns the
            state — the empty placeholder sections hide so the stub shows ONLY
            the retry path. Manual edit-and-save must stay available per the
            canSave gate, so the form renders only when NOT a terminal stub
            failure. */}
        {!generationTerminalFailure ? (
        <AgentConfigForm
          key={appliedJobResult ? `applied-${appliedJobResult.jobId}` : "server"}
          initialName={appliedJobResult ? appliedJobResult.name : name}
          initialConfig={appliedJobResult ? appliedJobResult.config : config}
          submitLabel="Save changes"
          isDirty={isDirty}
          phoneReady={phoneReady}
          whatsappReady={whatsappReady}
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
          footerPrimaryActions={
            <TestAgentDialog
              agentId={id}
              name={currentName}
              config={current}
              isDirty={isDirty}
              canTest={canTestCall}
            />
          }
        />
        ) : null}
      </div>
    </div>
  );
}

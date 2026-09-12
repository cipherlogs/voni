"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { toast } from "@/components/ui/toast";
import {
  CircleCheck,
  LoaderCircle,
  RotateCw,
  TriangleAlert,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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

/**
 * The mockup's card elevation: a hairline lift plus a wide, very soft drop.
 * Shared by the statusline, the state banners, and the delete card so they
 * read as one surface language with the form's cards.
 */
const CARD_SHADOW =
  "shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-16px_rgba(0,0,0,0.18)]";

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
  } = props;
  const [current, setCurrent] = useState<AgentConfig>(config);
  const [currentName, setCurrentName] = useState<string>(name);
  // Dirty when the live name/config differ from the last-saved snapshot.
  // The form reports both via onChange (name passthrough included).
  const [savedSnapshot, setSavedSnapshot] = useState<string>(() =>
    JSON.stringify({ name, config }),
  );
  const isDirty =
    JSON.stringify({ name: currentName, config: current }) !== savedSnapshot;
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
  // Badge variants from the mockup's states strip: a red-tinted pill for a
  // failed deployment, the muted pill while deploying, and the plain
  // bordered pill for queued / ready / draft.
  const deployBadgeVariant =
    deployState === "failed"
      ? "destructive"
      : deployState === "deploying"
        ? "secondary"
        : "outline";
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
        <h1 className="mt-2 mb-1 text-2xl font-semibold tracking-[-0.02em]">
          {name}
        </h1>
        <p className="text-muted-foreground mb-4 text-sm">
          Changes take effect on the next call this agent takes.
        </p>
        <div
          className={`bg-card mb-4 flex flex-wrap items-center gap-2.5 rounded-xl border px-3.5 py-3 ${CARD_SHADOW}`}
          aria-live="polite"
        >
          <Badge
            variant={deployBadgeVariant}
            className={`h-auto gap-1.5 rounded-full px-2.5 py-1 font-semibold [&>svg]:size-3.5! ${
              deployBadgeVariant === "destructive"
                ? "border-destructive/25"
                : deployBadgeVariant === "outline"
                  ? "bg-card"
                  : ""
            }`}
          >
            {deployState === "deploying" ? (
              <LoaderCircle aria-hidden className="animate-spin" />
            ) : null}
            {deploymentLabel(deployState)}
          </Badge>
          {deployStatusCopy ? (
            <span className="text-muted-foreground text-[13px]">
              {deployStatusCopy}
            </span>
          ) : null}
          {deployActive ? (
            <Progress
              value={deployPercent}
              aria-label="Deployment progress"
              className="basis-full [&_[data-slot=progress-track]]:h-1.5"
            />
          ) : null}
        </div>

        {isGenerationStub ? (
          generationRunning ? (
            <Alert className={`mb-4 rounded-xl text-[13px] ${CARD_SHADOW}`}>
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
            <Alert className={`mb-4 rounded-xl text-[13px] ${CARD_SHADOW}`}>
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
            <Alert className={`mb-4 rounded-xl text-[13px] ${CARD_SHADOW}`}>
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
            className={`mb-4 rounded-xl text-[13px] ${CARD_SHADOW}`}
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
                icon={<RotateCw />}
                onClick={() =>
                  startRetry(async () => {
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
                  })
                }
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
          footerSecondary={
            <AgentDeleteButton
              id={id}
              name={name}
              layout="full"
              redirectTo="/agents"
              // The mockup's .btn-danger-ghost: white surface, red text, soft
              // red border, red-tinted hover — not the solid destructive fill.
              label="Delete"
              showIcon={false}
              className={"bg-card text-destructive border-destructive/25 hover:bg-destructive/5 hover:text-destructive min-h-11 rounded-full px-5.5 text-sm font-semibold"}
              // Live deployState, not the frozen server snapshot: once a
              // background deploy succeeds nothing remote is short-copy
              // anymore, even though the neverProvisioned prop can't update.
              neverProvisioned={!assemblyaiAgentId && deployState !== "ready"}
            />
          }
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
              return;
            }
            setDeployState("queued");
            setDeployMessage(null);
            setDeployJobId(result.jobId ?? null);
            setSavedSnapshot(JSON.stringify({ name: nextName, config: nextConfig }));
            toast.add({ type: "success", title: "Agent saved — voice deployment is running" });
          }}
          // Sticky bottom save bar on small screens so Save stays reachable
          // past the long config form; static footer content on desktop.
          // A z-index sits it above the global bottom nav — both are
          // position:fixed, and without one the bar slides under the nav.
          footerClassName="sticky bottom-18 z-10 -mx-1 border-t bg-background/95 px-1 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:static lg:z-auto lg:mx-0 lg:border-0 lg:bg-transparent lg:px-0 lg:pt-4 lg:pb-0 lg:backdrop-blur-none"
        />
        {/* Quiet second door to the same typed-name delete dialog — the one
            full-weight delete path lives in the footer bar next to Save.
            A second bordered card here competed with Save and doubled the
            destructive affordance, so this is a muted sentence, not a card. */}
        <p className="mt-3 text-center text-xs text-muted-foreground">
          Done with this agent?{" "}
          <AgentDeleteButton
            id={id}
            name={name}
            layout="full"
            redirectTo="/agents"
            label={`Delete ${name}`}
            showIcon={false}
            className="h-auto min-h-0 rounded-none border-0 bg-transparent p-0 text-xs font-normal text-muted-foreground underline underline-offset-4 shadow-none hover:bg-transparent hover:text-destructive hover:underline dark:bg-transparent"
            // Live deployState, not the frozen server snapshot: once a
            // background deploy succeeds nothing remote is short-copy
            // anymore, even though the neverProvisioned prop can't update.
            neverProvisioned={!assemblyaiAgentId && deployState !== "ready"}
          />
        </p>
      </div>

      <aside
        id="test-rail"
        aria-label="Test this agent"
        className="order-first lg:order-none lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto"
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
          <Card>
            <CardHeader>
              <CardTitle>Test this agent</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="text-muted-foreground text-sm">
                Test calls unlock once generation finishes — the voice and
                language here are placeholders until then.
              </p>
            </CardContent>
          </Card>
        )}
      </aside>
    </div>
  );
}

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
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/loading-button";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { AgentConfigForm } from "@/components/agent-config-form";
import { VoiceCall } from "@/components/voice-call";
import { voiceLabel } from "@/lib/agents/voices";
import type { AgentConfig } from "@/lib/agents/config";
import type { JobJson } from "@/lib/jobs/serialize";
import { useJobs } from "@/components/jobs/jobs-provider";
import { useOptimisticJob } from "@/components/jobs/use-optimistic-job";
import { retryAgentDeploymentAction, updateAgentAction } from "../actions";
import { AgentDeleteButton } from "../delete-agent-button";

export type DeploymentState = "draft" | "queued" | "deploying" | "ready" | "failed";

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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <Badge variant={deployState === "ready" ? "secondary" : deployState === "failed" ? "destructive" : "outline"}>
          {deploymentLabel(deployState)}
        </Badge>
      </div>

      {isGenerationStub ? (
        generationRunning ? (
          <Alert>
            <LoaderCircle className="animate-spin" />
            <AlertTitle>Configuration generating</AlertTitle>
            <AlertDescription>
              This agent&apos;s configuration is still being generated.
              Review, test, and save unlock when it&apos;s ready.{" "}
              <Link
                href="/jobs"
                className="cursor-pointer rounded-sm underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                View progress in Jobs
              </Link>
            </AlertDescription>
          </Alert>
        ) : generationReady ? (
          <Alert>
            <CircleCheck />
            <AlertTitle>Ready to review</AlertTitle>
            <AlertDescription>
              Generation finished. The result waits on the review screen —
              the form below still shows the placeholder, so review and
              save there.{" "}
              <Link
                href={
                  generationJobId
                    ? `/agents/new?job=${generationJobId}`
                    : "/jobs"
                }
                className="cursor-pointer rounded-sm underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Review the generated configuration
              </Link>
            </AlertDescription>
          </Alert>
        ) : (
          <Alert>
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
                  className="cursor-pointer rounded-sm text-xs underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  View in Jobs
                </Link>
              </span>
            </AlertDescription>
          </Alert>
        )
      ) : null}

      {needsAttention ? (
        <Alert variant="destructive">
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

      <Card>
        <CardHeader>
          <CardTitle>Test this agent</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {canTestCall ? (
            <>
              <p className="text-muted-foreground text-sm">
                Talks to the version on screen, including unsaved edits, in{" "}
                {voiceLabel(current.voiceId)}&apos;s voice. No phone number
                involved.
              </p>
              {/* Keyed on the voice: it is immutable for the life of a session, so
                  switching it has to start a fresh one rather than mutate this one. */}
              <VoiceCall
                key={current.voiceId}
                mode={{ kind: "inline", config: current, agentId: id }}
              />
            </>
          ) : (
            <p className="text-muted-foreground text-sm">
              Test calls unlock once generation finishes — the voice and
              language here are placeholders until then.
            </p>
          )}
        </CardContent>
      </Card>

      <AgentConfigForm
        initialName={name}
        initialConfig={config}
        submitLabel="Save changes"
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
          />
        }
        onChange={setCurrent}
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
            return;
          }
          setDeployState("queued");
          setDeployMessage(null);
          setDeployJobId(result.jobId ?? null);
          toast.add({ type: "success", title: "Agent saved — voice deployment is running" });
        }}
      />
    </div>
  );
}

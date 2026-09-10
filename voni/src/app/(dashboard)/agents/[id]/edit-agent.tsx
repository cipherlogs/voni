"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/toast";
import { LoaderCircle, RotateCw, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/loading-button";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { AgentConfigForm } from "@/components/agent-config-form";
import { VoiceCall } from "@/components/voice-call";
import { composeBrief } from "@/components/agent-wizard/starters";
import { voiceLabel } from "@/lib/agents/voices";
import {
  REAL_ESTATE_TEMPLATE,
  type AgentConfig,
} from "@/lib/agents/config";
import type { JobJson } from "@/lib/jobs/serialize";
import { useJobs } from "@/components/jobs/jobs-provider";
import { useOptimisticJob } from "@/components/jobs/use-optimistic-job";
import { retryAgentDeploymentAction, updateAgentAction } from "../actions";

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
 */
export function EditAgent({
  id,
  name,
  config,
  initialDeploymentAttention = false,
  deploymentStatus = "draft",
  deploymentError = null,
  generationJobId = null,
}: {
  id: string;
  name: string;
  config: AgentConfig;
  initialDeploymentAttention?: boolean;
  deploymentStatus?: string;
  deploymentError?: string | null;
  /** Draft-first generation job to watch (?job= after /agents/new). */
  generationJobId?: string | null;
}) {
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
  const router = useRouter();
  const { markSeen } = useJobs();

  // Draft-first generation watcher (?job= after /agents/new): the draft row
  // already exists, so this only surfaces progress and the outcome. The form
  // below remounts from generated values via formRevision — never silently
  // merged into unsaved typing.
  const generation = useOptimisticJob("agent_generation");
  const [watchingGeneration, setWatchingGeneration] = useState(
    generationJobId !== null,
  );
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [unappliedConfig, setUnappliedConfig] = useState<AgentConfig | null>(null);
  const [formRevision, setFormRevision] = useState(0);
  const [applyingGenerated, startApplyGenerated] = useTransition();

  const handleGenerationTerminal = useCallback(
    (job: JobJson) => {
      // The agent page itself consumes the result — no lingering pill.
      void markSeen(job.id);
      if (job.status === "succeeded") {
        const result = job.result as {
          config?: AgentConfig;
          applied?: boolean;
        } | null;
        if (result?.applied && result.config) {
          setWatchingGeneration(false);
          setCurrent(result.config);
          setFormRevision((r) => r + 1);
          toast.add({ type: "success", title: "Draft generated — review below" });
        } else if (result?.config) {
          // Saved edits mid-flight won their race: keep the generated
          // config for an explicit choice instead of clobbering them.
          setWatchingGeneration(false);
          setUnappliedConfig(result.config);
        } else {
          setWatchingGeneration(false);
        }
        return;
      }
      setWatchingGeneration(false);
      setGenerationError(
        job.status === "cancelled"
          ? "Generation was cancelled."
          : (job.errorMessage ?? "Generation failed."),
      );
    },
    [markSeen],
  );

  useEffect(() => {
    if (!generationJobId) return;
    return generation.trackExternal(
      generationJobId,
      { title: `Generate ${name} draft`, kind: "agent_generation" },
      handleGenerationTerminal,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generationJobId]);

  // Retry rebuilds the brief from the saved draft — the wizard answers live
  // on in the placeholder config (goals/tasks survive a failed job).
  const retryGeneration = async () => {
    const draft = {
      goals: config.goals ?? [],
      tasks: config.tasks ?? [],
      agentName: name,
      styleTraits: config.styleTraits ?? [],
      conversationLanguage: config.conversationLanguage ?? "en",
      voiceId: config.voiceId,
    } as Parameters<typeof composeBrief>[0];
    const brief = composeBrief(draft);
    if (brief.trim().length < 10) {
      setGenerationError("The saved draft is too thin to retry from — edit it below first.");
      return;
    }
    setGenerationError(null);
    setUnappliedConfig(null);
    setWatchingGeneration(true);
    const started = await generation.start(
      { brief, wizardDraft: draft, agentId: id },
      { title: `Generate ${name} draft` },
      handleGenerationTerminal,
    );
    if (!started) {
      setWatchingGeneration(false);
      setGenerationError("Generation could not start. Check your connection and retry.");
    }
  };

  const applyGeneratedConfig = (next: AgentConfig) => {
    startApplyGenerated(async () => {
      const result = await updateAgentAction(id, name, next);
      if (!result.ok) {
        toast.add({ type: "error", title: result.message });
        return;
      }
      setCurrent(next);
      setFormRevision((r) => r + 1);
      setUnappliedConfig(null);
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
    });
  };

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

  const needsAttention = deployState === "failed" || deployMessage !== null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <Badge variant={deployState === "ready" ? "secondary" : deployState === "failed" ? "destructive" : "outline"}>
          {deploymentLabel(deployState)}
        </Badge>
      </div>

      {watchingGeneration && generation.phase !== "done" ? (
        <Card aria-live="polite">
          <CardContent className="flex flex-col gap-3 py-6">
            <p className="flex items-center gap-2 text-sm font-medium">
              <LoaderCircle className="animate-spin" aria-hidden />
              Generating your draft…
            </p>
            <p className="text-muted-foreground text-sm">
              Composing mission and rules from your answers. Nothing here is
              locked — the draft fills in on its own when the run finishes.
            </p>
            <Progress value={null} aria-label="Generation in progress" />
            <span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => router.push("/jobs")}
              >
                Open Jobs
              </Button>
            </span>
          </CardContent>
        </Card>
      ) : null}

      {generationError ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Draft saved, but generation failed</AlertTitle>
          <AlertDescription className="flex flex-col gap-3">
            <span>{generationError} Your answers are safe in the draft below.</span>
            <span className="flex flex-wrap gap-2">
              <LoadingButton
                type="button"
                size="sm"
                variant="outline"
                pending={watchingGeneration}
                pendingText="Retrying…"
                icon={<RotateCw />}
                onClick={() => void retryGeneration()}
              >
                Retry generation
              </LoadingButton>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => applyGeneratedConfig(REAL_ESTATE_TEMPLATE)}
              >
                Use the real estate template
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      ) : null}

      {unappliedConfig ? (
        <Alert>
          <TriangleAlert />
          <AlertTitle>Generation finished after your edits</AlertTitle>
          <AlertDescription className="flex flex-col gap-3">
            <span>
              Your saved changes were kept. Load the generated values to
              replace what&apos;s below, or keep editing — nothing changes
              until you choose.
            </span>
            <span className="flex flex-wrap gap-2">
              <LoadingButton
                type="button"
                size="sm"
                pending={applyingGenerated}
                pendingText="Loading…"
                onClick={() => applyGeneratedConfig(unappliedConfig)}
              >
                Load generated values
              </LoadingButton>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setUnappliedConfig(null)}
              >
                Keep my edits
              </Button>
            </span>
          </AlertDescription>
        </Alert>
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
        </CardContent>
      </Card>

      <AgentConfigForm
        key={formRevision}
        initialName={name}
        initialConfig={current}
        submitLabel="Save changes"
        onChange={setCurrent}
        onSubmit={async (nextName, nextConfig) => {
          const result = await updateAgentAction(id, nextName, nextConfig);
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

"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { RotateCw, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
}: {
  id: string;
  name: string;
  config: AgentConfig;
  initialDeploymentAttention?: boolean;
  deploymentStatus?: string;
  deploymentError?: string | null;
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
          toast.success("Voice deployment is ready");
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
                    toast.success("Deployment queued — it runs in the background");
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
        initialName={name}
        initialConfig={config}
        submitLabel="Save changes"
        onChange={setCurrent}
        onSubmit={async (nextName, nextConfig) => {
          const result = await updateAgentAction(id, nextName, nextConfig);
          if (!result.ok) {
            toast.error(result.message);
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
          toast.success("Agent saved — voice deployment is running");
        }}
      />
    </div>
  );
}

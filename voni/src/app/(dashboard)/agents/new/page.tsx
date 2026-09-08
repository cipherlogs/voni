"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AgentConfigForm } from "@/components/agent-config-form";
import { ManualLlmGuidance } from "@/components/manual-llm-guidance";
import { REAL_ESTATE_TEMPLATE, type AgentConfig } from "@/lib/agents/config";
import type { JobJson } from "@/lib/jobs/serialize";
import { useOptimisticJob } from "@/components/jobs/use-optimistic-job";
import { useJobs } from "@/components/jobs/jobs-provider";
import { useCopilot } from "@/components/copilot/copilot-provider";
import type {
  BusContext,
  BusToolResult,
  RegisteredTool,
} from "@/lib/copilot/bus";
import {
  createWizardExecutor,
  createWizardTargetReader,
  wizardFieldSchema,
  wizardKeyPhrases,
  wizardSummary,
} from "@/lib/copilot/wizard-tools";
import { useWizardDraft } from "@/components/agent-wizard/use-wizard-draft";
import { composeBrief } from "@/components/agent-wizard/starters";
import { TimelineBar } from "@/components/agent-wizard/wizard-timeline";
import { BackLink } from "@/components/back-link";
import {
  GoalStep,
  PersonalityStep,
  ReviewStep,
  STEP_MASCOTS,
  TasksStep,
  type ReviewPhase,
} from "@/components/agent-wizard/wizard-step-bodies";
import { WIZARD_STEPS } from "@/components/agent-wizard/use-wizard-draft";
import { createAgentAction } from "../actions";

/**
 * Guided agent creation: four steps build a structured brief (type it here,
 * or talk to the global voice copilot — it can propose every field through
 * the confirm gate), then the existing agent_generation job compiles it.
 * Generation, review, save, and restore semantics are unchanged from the
 * single-textarea page this replaces: the draft is never auto-saved, and a
 * ?job= link restores the watched result.
 */
function NewAgentInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const restoreJobId = searchParams.get("job");
  const wiz = useWizardDraft();
  const [draft, setDraft] = useState<AgentConfig | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showGuidance, setShowGuidance] = useState(false);
  const generation = useOptimisticJob("agent_generation");
  const { markSeen } = useJobs();
  const [restoring, setRestoring] = useState(restoreJobId !== null);
  const running =
    restoring ||
    generation.phase === "starting" ||
    generation.phase === "waiting" ||
    generation.phase === "backgrounded";
  const backgrounded = generation.phase === "backgrounded";
  const reviewPhase: ReviewPhase = backgrounded
    ? "backgrounded"
    : generation.phase === "starting" || generation.phase === "waiting" || restoring
      ? "working"
      : "idle";
  const briefError = error ?? generation.error;

  const applyResult = useCallback((job: JobJson) => {
    const result = job.result as {
      config?: AgentConfig;
      provider?: string;
      model?: string;
      latencyMs?: number;
    } | null;
    if (job.status === "succeeded" && result?.config) {
      setDraft(result.config);
      setSource(
        `${result.provider ?? "unknown"} · ${result.model ?? ""} · ${((result.latencyMs ?? 0) / 1000).toFixed(1)}s`,
      );
      setError(null);
      setShowGuidance(false);
      return true;
    }
    if (job.status === "failed" || job.status === "cancelled") {
      setError(
        job.status === "cancelled"
          ? "Generation was cancelled."
          : (job.errorMessage ?? "Generation failed."),
      );
      setShowGuidance(job.errorCode === "provider-exhausted");
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    if (!restoreJobId || draft) return;
    const stop = generation.trackExternal(
      restoreJobId,
      { title: "Generate agent draft", kind: "agent_generation" },
      (job) => {
        // A ?job= link means the user came to consume this result: applying
        // it marks the job seen so no "ready" pill sticks around afterward.
        if (applyResult(job)) {
          setRestoring(false);
          void markSeen(job.id);
        }
      },
    );
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreJobId, draft]);

  const generate = async () => {
    const brief = composeBrief(wiz.draft);
    if (brief.trim().length < 10) {
      setError("Describe what the agent should do — a sentence or two is enough.");
      return;
    }
    setError(null);
    setShowGuidance(false);
    setRestoring(false);
    const started = await generation.start(
      { brief },
      { title: "Generate agent draft" },
      (job) => {
        // The draft review (or inline error) consumes the result right here,
        // so mark it seen: the global pill stays for work in flight, not for
        // results already on screen. /jobs keeps the full history.
        if (applyResult(job)) void markSeen(job.id);
      },
    );
    if (!started) {
      setError("Generation could not start.");
      return;
    }
    if (started.deduped) {
      toast("A matching generation is already running — showing that one.");
    }
    router.replace("/agents/new");
  };

  const useTemplate = () => {
    setError(null);
    setShowGuidance(false);
    setDraft(REAL_ESTATE_TEMPLATE);
    setSource("Real estate template");
  };

  const save = async (name: string, config: AgentConfig) => {
    // The wizard is the source of truth for voice + languages: the generated
    // draft's voice is overwritten, never merged.
    const merged: AgentConfig = {
      ...config,
      voiceId: wiz.draft.voiceId,
      languageCodes: [...wiz.draft.languageCodes],
    };
    const result = await createAgentAction(name, merged);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    if (result.deployment === "attention") {
      router.push(`/agents/${result.id}?deployment=attention`);
      return;
    }
    toast.success("Agent saved — voice deployment is running");
    router.push(`/agents/${result.id}`);
  };

  const undo = () => wiz.undo();

  // Copilot route registration: the global voice session can propose wizard
  // changes through the confirm gate. Brief carries presence only (never
  // free text — no PII in the prompt); readers/executors stay live via refs.
  const { registerRoute, unregisterRoute, proposeChange, proposeUndo } = useCopilot();
  const { applyAgentPatch, draftRef } = wiz;
  const wizardCopilotTools = useMemo<RegisteredTool[]>(
    () => [
      {
        name: "wizard_propose_change",
        description:
          "Propose setting the agent draft's goal, agent name, personality, tasks list, voice, or listened languages. Call when the user asks to set or change any of these. Returns a proposal id and summary — read the summary back verbatim, then wait for yes or Apply before calling confirm_proposal.",
        parameters: {
          type: "object",
          properties: {
            field: { type: "string", enum: ["goal", "agentName", "personality", "tasks", "voice", "languages"] },
            value: { type: "string" },
          },
          required: ["field", "value"],
          additionalProperties: false,
        },
        schema: wizardFieldSchema,
        effect: { mutates: false, scope: "wizard-draft", reversible: true },
        routes: ["/agents/new"],
        mode: "interactive",
        listed: true,
        run: async (args, ctx: BusContext): Promise<BusToolResult> => {
          const parsed = wizardFieldSchema.safeParse(args);
          if (!parsed.success) {
            return {
              ok: false,
              error: "Say which field to change and the new value.",
              retryable: false,
            };
          }
          const { field, value } = parsed.data;
          const summary = wizardSummary(field, value);
          const draftKey =
            field === "voice" ? "voiceId" : field === "languages" ? "languageCodes" : field;
          const { proposal_id } = proposeChange(
            {
              target: { kind: "wizard", id: field },
              payload: { field, value },
              executor: "wizard_apply_exec",
              summary,
              keyPhrases: wizardKeyPhrases(field, value),
              inverse: {
                summary: `Restore the previous ${field}`,
                payload: { field, value: draftRef.current[draftKey] },
              },
            },
            ctx,
          );
          return {
            ok: true,
            data: {
              proposal_id,
              summary,
              next: "Read the summary back verbatim, then await yes or Apply.",
            },
          };
        },
        executor: null,
      },
      {
        name: "wizard_apply_exec",
        description:
          "Internal: applies a confirmed wizard patch. Never call directly — propose first.",
        parameters: { type: "object" },
        schema: wizardFieldSchema,
        effect: { mutates: true, scope: "wizard-draft", reversible: true },
        routes: ["/agents/new"],
        mode: "interactive",
        listed: false,
        run: null,
        executor: createWizardExecutor((patch, touched, label) =>
          applyAgentPatch(patch, touched, label),
        ),
      },
      {
        name: "wizard_undo_propose",
        description:
          "Propose undoing the most recent voice-applied wizard change. Call when the user asks to undo or revert. Returns a proposal id and summary — read it back, then await confirmation like any other change.",
        parameters: { type: "object", properties: {} },
        schema: z.object({}),
        effect: { mutates: false, scope: "wizard-draft", reversible: true },
        routes: ["/agents/new"],
        mode: "interactive",
        listed: true,
        run: async (_args, ctx: BusContext): Promise<BusToolResult> => {
          const result = proposeUndo(ctx);
          return result.ok
            ? {
                ok: true,
                data: {
                  proposal_id: result.proposal_id as string,
                  summary: result.summary as string,
                  next: "Read the summary back verbatim, then await yes or Apply.",
                },
              }
            : { ok: false, error: result.error as string, retryable: false };
        },
        executor: null,
      },
    ],
    [proposeChange, proposeUndo, applyAgentPatch, draftRef],
  );
  const wizardBrief = useMemo(() => {
    const draft = wiz.draft;
    return [
      `step ${wiz.step + 1} of 4 (${WIZARD_STEPS[wiz.step]})`,
      `goal ${draft.goal ? "set" : "empty"}`,
      `name ${draft.agentName ? "set" : "empty"}`,
      `personality ${draft.personality ? "set" : "empty"}`,
      `${draft.tasks.length} tasks`,
      `voice ${draft.voiceId || "unset"}`,
      `${draft.languageCodes.length} langs`,
    ].join("; ");
  }, [wiz.step, wiz.draft]);
  useEffect(() => {
    registerRoute("/agents/new", {
      tools: wizardCopilotTools,
      targets: createWizardTargetReader(() => draftRef.current),
      brief: `Building a phone agent. Now on ${wizardBrief}.`,
    });
    return () => unregisterRoute("/agents/new");
  }, [registerRoute, unregisterRoute, wizardCopilotTools, wizardBrief, draftRef]);

  /** Review edit jumps navigate, then focus the field. */
  const goToStep = (step: number) => {
    wiz.setStep(step);
    requestAnimationFrame(() => {
      const sel =
        step === 0
          ? "#new-goal"
          : step === 1
            ? "#new-name"
            : step === 2
              ? "#new-tasks button"
              : null;
      if (sel) document.querySelector<HTMLElement>(sel)?.focus();
    });
  };

  if (draft) {
    return (
      <div className="flex flex-col gap-6">
        <BackLink href="/agents" label="Agents" />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Review agent
            </h1>
            <p className="text-muted-foreground text-sm">
              Everything here is editable. Nothing is saved until you say so.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {source ? <Badge variant="secondary">{source}</Badge> : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(null);
                setSource(null);
              }}
            >
              Start over
            </Button>
          </div>
        </div>

        <AgentConfigForm
          initialName={wiz.draft.agentName}
          initialConfig={draft}
          submitLabel="Save agent"
          onSubmit={save}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <BackLink href="/agents" label="Agents" />
      <div>
          <h1 className="text-2xl font-semibold tracking-tight">New agent</h1>
          <p className="text-muted-foreground text-sm">
            Answer four quick steps and we&apos;ll generate a starting
            mission, tasks, and rules, editable afterward. Prefer talking?
            The voice copilot (mic, top right) fills in every field with
            you.
          </p>
      </div>

        <div className="flex min-w-0 flex-col gap-4">
          <TimelineBar current={wiz.step} completed={wiz.completed} onSelect={wiz.setStep} />
          {wiz.step === 0 ? (
            <GoalStep api={wiz} mascot={STEP_MASCOTS[0]} idPrefix="new" />
          ) : null}
          {wiz.step === 1 ? (
            <PersonalityStep api={wiz} mascot={STEP_MASCOTS[1]} idPrefix="new" />
          ) : null}
          {wiz.step === 2 ? (
            <TasksStep api={wiz} mascot={STEP_MASCOTS[2]} idPrefix="new" />
          ) : null}
          {wiz.step === 3 ? (
            <ReviewStep
              api={wiz}
              mascot={STEP_MASCOTS[3]}
              phase={reviewPhase}
              canGenerate={composeBrief(wiz.draft).trim().length >= 10}
              onGenerate={generate}
              onOpenJobs={() => router.push("/jobs")}
              error={briefError}
              onUseTemplate={useTemplate}
              flashed={wiz.flashed}
              canUndo={wiz.canUndo}
              undoLabel={wiz.undoLabel}
              onUndo={undo}
              onJump={goToStep}
            />
          ) : null}
          {showGuidance && wiz.step === 3 ? <ManualLlmGuidance /> : null}

          <div className="flex items-center justify-between">
            <Button
              type="button"
              variant="ghost"
              disabled={wiz.step === 0}
              data-copilot-effect="view" onClick={() => wiz.setStep(Math.max(0, wiz.step - 1))}
            >
              <ArrowLeft aria-hidden />
              Back
            </Button>
            <span className="flex items-center gap-2">
              {wiz.step < WIZARD_STEPS.length - 1 ? (
                <Button
                  type="button"
                  data-copilot-effect="view" onClick={() => wiz.setStep(Math.min(WIZARD_STEPS.length - 1, wiz.step + 1))}
                >
                  Continue
                  <ArrowRight aria-hidden />
                </Button>
              ) : null}
            </span>
          </div>
        </div>

      {/* Screen-reader status for backgrounded generation outside the card. */}
      {running && backgrounded ? <span className="sr-only">Generation continuing in the background.</span> : null}
    </div>
  );
}

export default function NewAgentPage() {
  return (
    <Suspense>
      <NewAgentInner />
    </Suspense>
  );
}

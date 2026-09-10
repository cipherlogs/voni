"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "@/components/ui/toast";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentConfigForm } from "@/components/agent-config-form";
import { LoadingButton } from "@/components/loading-button";
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
  resolveWizardValue,
  wizardFieldSchema,
  wizardKeyPhrases,
  type WizardField,
} from "@/lib/copilot/wizard-tools";
import { useWizardDraft } from "@/components/agent-wizard/use-wizard-draft";
import type { WizardDraft } from "@/components/agent-wizard/use-wizard-draft";
import { composeBrief } from "@/components/agent-wizard/starters";
import { TimelineBar } from "@/components/agent-wizard/wizard-timeline";
import { WizardFooter } from "@/components/wizard/form-layout";
import type { TagFieldHandle } from "@/components/wizard/tag-field";
import { BackLink } from "@/components/back-link";
import {
  GenerationStatus,
  PersonalityStep,
  PlanStep,
  type GenerationStatusPhase,
} from "@/components/agent-wizard/wizard-step-bodies";
import { WIZARD_STEPS } from "@/components/agent-wizard/use-wizard-draft";
import { createAgentAction } from "../actions";

/**
 * Guided agent creation: two steps build a structured draft (type it here,
 * or talk to the global voice copilot — it can propose every field through
 * the confirm gate), then the existing agent_generation job compiles it.
 * Generation, review, save, and restore semantics are unchanged from the
 * single-textarea page this replaces: the draft is never auto-saved, and a
 * ?job= link restores the watched result.
 */
function NewAgentInner({ restoreJobId }: { restoreJobId: string | null }) {
  const router = useRouter();
  const wiz = useWizardDraft();
  const [draft, setDraft] = useState<AgentConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [showGuidance, setShowGuidance] = useState(false);
  const generation = useOptimisticJob("agent_generation");
  const { markSeen } = useJobs();
  const [restoring, setRestoring] = useState(restoreJobId !== null);
  const goalsRef = useRef<TagFieldHandle>(null);
  const tasksRef = useRef<TagFieldHandle>(null);
  const styleRef = useRef<TagFieldHandle>(null);
  const running =
    restoring ||
    generation.phase === "starting" ||
    generation.phase === "waiting" ||
    generation.phase === "backgrounded";
  const backgrounded = generation.phase === "backgrounded";
  const generationPhase: GenerationStatusPhase = backgrounded
    ? "backgrounded"
    : generation.phase === "starting" || generation.phase === "waiting" || restoring
      ? "working"
      : "idle";
  const briefError = error ?? generation.error;

  const applyResult = useCallback((job: JobJson) => {
    const result = job.result as {
      config?: AgentConfig;
    } | null;
    if (job.status === "succeeded" && result?.config) {
      setDraft(result.config);
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
    // No review step: validate everything here, jumping back on failure.
    if (goalsRef.current && !goalsRef.current.commitPending()) {
      wiz.setStep(0);
      return;
    }
    tasksRef.current?.commitPending();
    if (wiz.draft.goals.length === 0) {
      setStepError("Add at least one goal first.");
      wiz.setStep(0);
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>("#new-goals")?.focus();
      });
      return;
    }
    styleRef.current?.commitPending();
    if (!wiz.draft.agentName.trim()) {
      setStepError("Give the agent a name first.");
      wiz.setStep(1);
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>("#new-name")?.focus();
      });
      return;
    }
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
      toast.add({ title: "A matching generation is already running — showing that one." });
    }
    router.replace("/agents/new");
  };

  const useTemplate = () => {
    setError(null);
    setShowGuidance(false);
    setDraft(REAL_ESTATE_TEMPLATE);
  };

  const save = async (name: string, config: AgentConfig) => {
    // The wizard is the source of truth for voice + language: the generated
    // draft's voice is overwritten, never merged. (PR4 saves Review as shown.)
    const merged: AgentConfig = {
      ...config,
      voiceId: wiz.draft.voiceId,
      languageCodes: [wiz.draft.conversationLanguage],
    };
    const result = await createAgentAction(name, merged);
    if (!result.ok) {
      toast.add({ type: "error", title: result.message });
      return;
    }
    if (result.deployment === "attention") {
      router.push(`/agents/${result.id}?deployment=attention`);
      return;
    }
    toast.add({ type: "success", title: "Agent saved — voice deployment is running" });
    router.push(`/agents/${result.id}`);
  };

  /** Forward navigation validates preceding required fields. */
  const goNext = () => {
    // Pending valid text commits first; invalid goal text blocks here.
    // Tasks are optional: valid pending text commits, invalid never blocks.
    if (goalsRef.current && !goalsRef.current.commitPending()) return;
    tasksRef.current?.commitPending();
    if (wiz.draft.goals.length === 0) {
      setStepError("Add at least one goal first.");
      document.querySelector<HTMLElement>("#new-goals")?.focus();
      return;
    }
    setStepError(null);
    wiz.setStep(1);
  };

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
          "Propose setting the agent draft's goals, tasks, agent name, conversational style, voice, or conversation language. Call when the user asks to set or change any of these. Returns a proposal id and summary — read the summary back verbatim, then wait for yes or Apply before calling confirm_proposal.",
        parameters: {
          type: "object",
          properties: {
            field: { type: "string", enum: ["goals", "tasks", "agentName", "styleTraits", "voice", "conversationLanguage"] },
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
          const resolved = resolveWizardValue(field, value, draftRef.current);
          if (!resolved.ok) {
            return { ok: false, error: resolved.error, retryable: false };
          }
          const summary = resolved.summary;
          const draftKey =
            field === "voice"
              ? "voiceId"
              : field;
          const currentValue = draftRef.current[draftKey as keyof typeof draftRef.current];
          // Undoing a language change restores the exact previous voice,
          // which restores the pair exactly; otherwise restore the field.
          const inverse =
            field === "conversationLanguage" && "voiceId" in resolved.patch
              ? { field: "voice" as WizardField, value: draftRef.current.voiceId }
              : { field, value: currentValue as string | string[] };
          const { proposal_id } = proposeChange(
            {
              target: { kind: "wizard", id: field },
              payload: { field, value: flattenResolved(field, resolved.patch) },
              executor: "wizard_apply_exec",
              summary,
              keyPhrases: wizardKeyPhrases(field, value),
              inverse: {
                summary: `Restore the previous ${field}`,
                payload: inverse,
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
    const current = wiz.draft;
    return [
      `step ${wiz.step + 1} of 2 (${WIZARD_STEPS[wiz.step]})`,
      `${current.goals.length} goals`,
      `${current.tasks.length} tasks`,
      `name ${current.agentName ? "set" : "empty"}`,
      `${current.styleTraits.length} style tags`,
      `voice ${current.voiceId || "unset"}`,
      `language ${current.conversationLanguage}`,
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

  if (draft) {
    return (
      <div className="flex flex-col gap-6">
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
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(null);
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
    <>
      <div>
          <h1 className="text-2xl font-semibold tracking-tight">New agent</h1>
          <p className="text-muted-foreground text-sm">
            Answer two quick steps and we&apos;ll generate a starting
            mission and rules, editable afterward. Prefer talking?
            The voice copilot (mic, top right) fills in every field with
            you.
          </p>
      </div>

        <div className="flex min-w-0 flex-col gap-4">
          <TimelineBar current={wiz.step} completed={wiz.completed} onSelect={wiz.setStep} />
          {wiz.step === 0 ? (
            <PlanStep
              api={wiz}
              idPrefix="new"
              goalsRef={goalsRef}
              tasksRef={tasksRef}
              error={stepError}
              onClearError={() => setStepError(null)}
            />
          ) : null}
          {wiz.step === 1 ? (
            <PersonalityStep api={wiz} idPrefix="new" styleRef={styleRef} onClearError={() => setStepError(null)} />
          ) : null}
          {wiz.step === 1 ? (
            <GenerationStatus
              phase={generationPhase}
              onOpenJobs={() => router.push("/jobs")}
              error={briefError}
              onUseTemplate={useTemplate}
            />
          ) : null}
          {showGuidance && wiz.step === 1 ? <ManualLlmGuidance /> : null}
          {stepError && wiz.step === 1 ? (
            <p role="alert" className="text-destructive text-sm">{stepError}</p>
          ) : null}

          <WizardFooter
            onBack={() => wiz.setStep(Math.max(0, wiz.step - 1))}
            backDisabled={wiz.step === 0}
            primary={
              wiz.step === 0 ? (
                <Button
                  type="button"
                  className="w-full md:w-auto pointer-coarse:min-h-11"
                  data-copilot-effect="view"
                  onClick={goNext}
                >
                  Continue
                  <ArrowRight data-icon="inline-end" aria-hidden />
                </Button>
              ) : (
                <LoadingButton
                  className="w-full md:w-auto pointer-coarse:min-h-11"
                  pending={generationPhase === "working"}
                  pendingText="Generating…"
                  onClick={() => void generate()}
                  disabled={generationPhase === "working" || generationPhase === "backgrounded"}
                >
                  Generate agent
                </LoadingButton>
              )
            }
          />
        </div>

      {/* Screen-reader status for backgrounded generation outside the card. */}
      {running && backgrounded ? <span className="sr-only">Generation continuing in the background.</span> : null}
    </>
  );
}

/** Flatten a resolved patch back to the tool value shape the executor takes. */
function flattenResolved(
  field: WizardField,
  patch: Partial<WizardDraft>,
): string | string[] {
  if (field === "goals") return patch.goals ?? [];
  if (field === "tasks") return patch.tasks ?? [];
  if (field === "styleTraits") return patch.styleTraits ?? [];
  if (field === "agentName") return patch.agentName ?? "";
  if (field === "voice") return patch.voiceId ?? "";
  return (patch.conversationLanguage ?? "en") as string;
}

/**
 * Stable outer frame (Section 5): back link + New agent heading + wizard
 * frame paint without awaiting the URL. Only ?job= restoration reads the
 * search params, inside the suspended leaf. Wizard draft, review, and
 * confirmation behavior are unchanged.
 */
export default function NewAgentPage() {
  return (
    <div data-testid="agents-new-shell" className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <BackLink href="/agents" label="Agents" />
      <Suspense
        fallback={
          <div role="status" aria-label="Loading agent creator">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">New agent</h1>
              <p className="text-muted-foreground text-sm">
                Answer two quick steps and we&apos;ll generate a starting
                mission and rules, editable afterward.
              </p>
            </div>
          </div>
        }
      >
        <RestoreJobIdReader />
      </Suspense>
    </div>
  );
}

/** URL-dependent leaf: owns the useSearchParams call. */
function RestoreJobIdReader() {
  const searchParams = useSearchParams();
  return <NewAgentInner restoreJobId={searchParams.get("job")} />;
}

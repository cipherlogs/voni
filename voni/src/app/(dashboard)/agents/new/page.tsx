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
import {
  clearWizardDraftCache,
  isJobConsumed,
  markJobConsumed,
} from "@/components/agent-wizard/use-wizard-draft";
import {
  composeBrief,
  generationIdempotencyKey,
} from "@/components/agent-wizard/starters";
import { TimelineBar } from "@/components/agent-wizard/wizard-timeline";
import { WizardFooter } from "@/components/wizard/form-layout";
import type { TagFieldHandle } from "@/components/wizard/tag-field";
import { BackLink } from "@/components/back-link";
import { NewAgentSkeleton } from "@/components/page-skeletons";
import {
  GenerationStatus,
  PersonalityStep,
  PlanStep,
  type GenerationStatusPhase,
} from "@/components/agent-wizard/wizard-step-bodies";
import { WIZARD_STEPS } from "@/components/agent-wizard/use-wizard-draft";
import { DEFAULT_WIZARD_VOICE_ID } from "@/lib/agents/wizard";
import {
  createAgentAction,
  ensureGenerationPlaceholderAction,
  getGenerationPlaceholderAction,
  updateAgentAction,
} from "../actions";
import { AgentDeleteButton } from "../delete-agent-button";

/**
 * Guided agent creation: two steps build a structured draft (type it here,
 * or talk to the global voice copilot — it can propose every field through
 * the confirm gate), then the existing agent_generation job compiles it.
 * Generation, review, save, and restore semantics are unchanged from the
 * single-textarea page this replaces: the draft is never auto-saved, and a
 * ?job= link restores the watched result.
 */
function NewAgentInner({
  restoreJobId,
}: {
  restoreJobId: string | null;
}) {
  const router = useRouter();
  const wiz = useWizardDraft();
  const [draft, setDraft] = useState<AgentConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Keyed by field so a message can never leak into another field when the
  // user moves between steps. Each clears only on its own field's edits.
  const [fieldErrors, setFieldErrors] = useState<{ goals?: string; name?: string }>({});
  const [showGuidance, setShowGuidance] = useState(false);
  const generation = useOptimisticJob("agent_generation");
  const { markSeen } = useJobs();
  const [restoring, setRestoring] = useState(restoreJobId !== null);
  // ?job= visits wait for the placeholder snapshot before showing review so
  // the name field and voice/language (mount-once form state) are seeded.
  const [seeded, setSeeded] = useState(restoreJobId === null);
  // Placeholder row id for the review footer delete (never-provisioned draft).
  const [placeholderId, setPlaceholderId] = useState<string | null>(null);
  const [placeholderName, setPlaceholderName] = useState<string | null>(null);
  // Jobs the user walked away from via Start over: never re-seed from them,
  // even in the render window before the URL strip propagates.
  const [dismissedJobId, setDismissedJobId] = useState<string | null>(null);
  const goalsRef = useRef<TagFieldHandle>(null);
  const tasksRef = useRef<TagFieldHandle>(null);
  const styleRef = useRef<TagFieldHandle>(null);
  const running =
    restoring ||
    generation.phase === "starting" ||
    generation.phase === "waiting" ||
    generation.phase === "backgrounded";
  const backgrounded = generation.phase === "backgrounded";
  // Fresh submission in flight (not a ?job= restore visit): the form hides
  // behind the submitted panel until the job reaches a terminal state.
  const submitting =
    generation.phase === "starting" ||
    generation.phase === "waiting" ||
    generation.phase === "backgrounded";
  const generationPhase: GenerationStatusPhase = backgrounded
    ? "backgrounded"
    : submitting
      ? "working"
      : "idle";
  const briefError = error ?? generation.error;

  /** Untouched since mount: safe to seed from a restore without clobbering. */
  const isPristineDraft = (current: WizardDraft) =>
    current.agentName === "" &&
    current.voiceId === DEFAULT_WIZARD_VOICE_ID &&
    current.conversationLanguage === "en" &&
    current.goals.length === 0 &&
    current.tasks.length === 0 &&
    current.styleTraits.length === 0;

  const applyResult = useCallback(
    (job: JobJson) => {
      const result = job.result as {
        config?: AgentConfig;
        wizardDraft?: WizardDraft;
      } | null;
      if (job.status === "succeeded" && result?.config) {
        // Review saves as shown (PR4): the wizard's voice + language are
        // folded into the review state here, so save() persists verbatim
        // instead of silently overwriting. The echoed submit-time snapshot
        // wins (immune to post-submit edits); the live draft covers
        // brief-only jobs started before the echo existed.
        const echo = result.wizardDraft ?? null;
        const live = wiz.draftRef.current;
        const voiceId = echo?.voiceId ?? live.voiceId;
        const conversationLanguage =
          echo?.conversationLanguage ?? live.conversationLanguage;
        setDraft({
          ...result.config,
          voiceId,
          languageCodes: [conversationLanguage],
        });
        // Restore fallback: when the best-effort placeholder write failed,
        // the echoed snapshot still seeds the wizard (name, voice, goals).
        if (echo && isPristineDraft(wiz.draftRef.current)) {
          wiz.edit(
            {
              agentName: echo.agentName,
              voiceId: echo.voiceId,
              conversationLanguage: echo.conversationLanguage,
              goals: echo.goals,
              tasks: echo.tasks,
              styleTraits: echo.styleTraits,
            },
            "restore",
          );
        }
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
    },
    // wiz api object is stable; draftRef carries the live values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (!restoreJobId || draft || restoreJobId === dismissedJobId) return;
    // Browser Back after a save lands on the stale ?job= pointer with fresh
    // in-memory state (dismissedJobId is lost on remount). The placeholder is
    // already upgraded and its generationJobId cleared, so re-seeding here
    // would resurrect a review with no placeholder behind it — and saving that
    // review would twin the row via a plain insert. Saved job ids stay in a
    // tab-persistent consumed set (see markJobConsumed in save); strip the
    // stale pointer instead of restoring it.
    if (isJobConsumed(restoreJobId)) {
      // No setState here (react-hooks/set-state-in-effect): the replace
      // remounts with restoreJobId=null, which resets restoring/seeded via
      // their initializers. Navigation away is the guard.
      router.replace("/agents/new");
      return;
    }
    // Returning from the list (or a reload) wipes the in-memory wizard, but
    // the placeholder kept what was submitted: seed it back, but only over a
    // pristine draft so real edits are never clobbered.
    let cancelled = false;
    void getGenerationPlaceholderAction(restoreJobId)
      .then((ph) => {
        if (cancelled || !ph) return;
        setPlaceholderId(ph.id);
        setPlaceholderName(ph.name);
        if (isPristineDraft(wiz.draftRef.current)) {
          wiz.edit(
            {
              agentName: ph.name === "Untitled agent" ? "" : ph.name,
              voiceId: ph.voiceId,
              conversationLanguage: ph.conversationLanguage,
              goals: ph.goals,
              tasks: ph.tasks,
              styleTraits: ph.styleTraits,
            },
            "restore",
          );
        }
      })
      .finally(() => {
        // Unconditional: the job watcher routinely settles first (its first
        // poll already sees a terminal job), which runs effect cleanup and
        // would otherwise leave `seeded` false forever — hiding a ready
        // review behind the wizard. SetState after unmount is a safe no-op.
        setSeeded(true);
      });
    const stop = generation.trackExternal(
      restoreJobId,
      { title: "Generate agent draft", kind: "agent_generation" },
      (job) => {
        // A ?job= link means the user came to consume this result: applying
        // it marks the job seen so no "ready" pill sticks around afterward.
        if (applyResult(job)) {
          setRestoring(false);
          // Failed restores land on step 0 with the seeded form — jump to
          // step 1 so the error (which renders there) is actually seen.
          if (job.status === "failed" || job.status === "cancelled") {
            wiz.setStep(1);
          }
          void markSeen(job.id);
        }
      },
    );
    return () => {
      cancelled = true;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreJobId, draft, dismissedJobId]);

  const clearFieldError = (field: "goals" | "name") => {
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const generate = async () => {
    // No review step: validate everything here, jumping back on failure.
    if (goalsRef.current && !goalsRef.current.commitPending()) {
      wiz.setStep(0);
      return;
    }
    tasksRef.current?.commitPending();
    if (wiz.draft.goals.length === 0) {
      setFieldErrors((prev) => ({ ...prev, goals: "Add at least one goal first." }));
      wiz.setStep(0);
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>("#new-goals")?.focus();
      });
      return;
    }
    styleRef.current?.commitPending();
    if (!wiz.draft.agentName.trim()) {
      setFieldErrors((prev) => ({ ...prev, name: "Give the agent a name first." }));
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
      {
        brief,
        // Structured snapshot: echoed in the result so ?job= restores can
        // seed the wizard even when the placeholder write fails. Voice is
        // included for seeding only — it never reaches the LLM brief.
        wizardDraft: {
          goals: wiz.draft.goals,
          tasks: wiz.draft.tasks,
          agentName: wiz.draft.agentName.trim(),
          styleTraits: wiz.draft.styleTraits,
          conversationLanguage: wiz.draft.conversationLanguage,
          voiceId: wiz.draft.voiceId,
        },
      },
      {
        title: "Generate agent draft",
        // Same brief resubmitted (double-click, retry, reload + resubmit)
        // returns the existing job instead of starting duplicate work.
        idempotencyKey: generationIdempotencyKey(brief),
      },
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
    // Best-effort list row so /agents shows the draft while it generates.
    // Generation continues if this fails; saving still works (plain insert).
    try {
      const placeholder = await ensureGenerationPlaceholderAction({
        jobId: started.jobId,
        name: wiz.draft.agentName.trim() || "Untitled agent",
        voiceId: wiz.draft.voiceId,
        languageCode: wiz.draft.conversationLanguage,
        goals: wiz.draft.goals,
        tasks: wiz.draft.tasks,
        styleTraits: wiz.draft.styleTraits,
      });
      if (placeholder.ok) {
        setPlaceholderId(placeholder.id);
        // Mirror the server fallback so the delete dialog names the real row.
        setPlaceholderName(wiz.draft.agentName.trim() || "Untitled agent");
      }
    } catch {
      // Placeholder is a courtesy — never fail generation over it.
    }
    if (started.deduped) {
      toast.add({ title: "A matching generation is already running — showing that one." });
    }
    // Keep the job pointer: a reload re-attaches via the ?job= restore path
    // instead of orphaning the job (PR4).
    router.replace(`/agents/new?job=${started.jobId}`);
  };

  const useTemplate = () => {
    setError(null);
    setShowGuidance(false);
    setDraft(REAL_ESTATE_TEMPLATE);
  };

  const save = async (name: string, config: AgentConfig) => {
    // Review saves as shown (PR4): the wizard's voice + language were folded
    // into the review draft when the result landed, so this persists verbatim.
    // Twin-via-insert guard: createAgentAction always inserts (it ignores
    // generationJobId), so a placeholder save must upgrade in place via
    // updateAgentAction. Resolve the placeholder id from restoreJobId/jobId
    // through getGenerationPlaceholderAction (which returns the row id);
    // plain insert stays only for template drafts with no placeholder.
    const jobId = generation.jobId ?? restoreJobId ?? null;
    const placeholder =
      jobId !== null ? await getGenerationPlaceholderAction(jobId) : null;
    const result =
      placeholder !== null
        ? await updateAgentAction(placeholder.id, name, config, {
            generationJobId: jobId ?? undefined,
          })
        : await createAgentAction(name, config);
    if (!result.ok) {
      toast.add({ type: "error", title: result.message });
      return;
    }
    clearWizardDraftCache();
    // Record placeholder-upgrade saves so a browser Back to the stale ?job=
    // pointer strips it instead of re-seeding a review that would twin on
    // save. Template-draft plain inserts carry no jobId and skip this.
    if (placeholder !== null && jobId !== null) markJobConsumed(jobId);
    setDismissedJobId(jobId);
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
      setFieldErrors((prev) => ({ ...prev, goals: "Add at least one goal first." }));
      document.querySelector<HTMLElement>("#new-goals")?.focus();
      return;
    }
    setFieldErrors((prev) => {
      if (!prev.goals) return prev;
      const next = { ...prev };
      delete next.goals;
      return next;
    });
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

  if (draft && seeded) {
    return (
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Review agent
          </h1>
          <p className="text-muted-foreground text-sm">
            Everything here is editable. Nothing is saved until you say so.
          </p>
        </div>

        <AgentConfigForm
          initialName={wiz.draft.agentName || draft.identity.name}
          initialConfig={draft}
          submitLabel="Save agent"
          onSubmit={save}
          footerSecondary={
            <span className="flex flex-wrap items-center gap-2">
              {placeholderId ? (
                <AgentDeleteButton
                  id={placeholderId}
                  name={placeholderName || draft.identity.name}
                  layout="full"
                  redirectTo="/agents"
                  neverProvisioned
                />
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  clearWizardDraftCache();
                  // Dismiss first: the render window before the URL strip
                  // propagates would otherwise re-seed from the same job.
                  setDismissedJobId(generation.jobId ?? restoreJobId);
                  setDraft(null);
                  // Drop the job pointer too: otherwise the ?job= restore
                  // effect re-seeds the just-cleared review on next render.
                  // (PR4 keeps ?job= in the URL after submit, so this path is
                  // now the default, not just a restore-visit edge.) This is
                  // a local view-dismiss only — the placeholder row stays and
                  // is removed via the delete button above.
                  router.replace("/agents/new");
                }}
              >
                Back to editing
              </Button>
            </span>
          }
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
              error={fieldErrors.goals}
              onClearError={(field) => clearFieldError(field)}
            />
          ) : null}
          {wiz.step === 1 && !submitting ? (
            <PersonalityStep
              api={wiz}
              idPrefix="new"
              styleRef={styleRef}
              nameError={fieldErrors.name}
              onClearError={(field) => clearFieldError(field)}
            />
          ) : null}
          {wiz.step === 1 ? (
            <GenerationStatus
              phase={generationPhase}
              onOpenJobs={() => router.push("/jobs")}
              error={briefError}
              onUseTemplate={useTemplate}
            />
          ) : null}
          {showGuidance && wiz.step === 1 && !submitting ? <ManualLlmGuidance /> : null}

          <WizardFooter
            onBack={() => wiz.setStep(Math.max(0, wiz.step - 1))}
            backDisabled={wiz.step === 0 || submitting}
            primary={
              submitting ? null : wiz.step === 0 ? (
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
            <NewAgentSkeleton />
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

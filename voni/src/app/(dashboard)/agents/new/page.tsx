"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "@/components/ui/toast";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  resolveWizardValue,
  wizardFieldSchema,
  wizardKeyPhrases,
  type WizardField,
} from "@/lib/copilot/wizard-tools";
import { EMPTY_DRAFT, hasUnfinishedWizardDraft, useWizardDraft } from "@/components/agent-wizard/use-wizard-draft";
import type { WizardDraft } from "@/components/agent-wizard/use-wizard-draft";
import {
  clearWizardDraftCache,
  isJobConsumed,
  markJobConsumed,
  resetWizardForNewCreation,
  WIZARD_FRESH_STEP,
} from "@/components/agent-wizard/use-wizard-draft";
import { GenerationRetryCard } from "@/components/generation-retry-card";
import { jobErrorCopy } from "@/lib/jobs/ui-helpers";
import {
  composeBrief,
  generationIdempotencyKey,
} from "@/components/agent-wizard/starters";
import { TimelineBar } from "@/components/agent-wizard/wizard-timeline";
import {
  FormSectionSeparator,
  PageHeading,
  WizardFooter,
} from "@/components/wizard/form-layout";
import { Progress } from "@/components/ui/progress";
import type { TagFieldHandle } from "@/components/wizard/tag-field";
import { BackLink } from "@/components/back-link";
import { NewAgentSkeleton } from "@/components/page-skeletons";
import {
  GenerationStatus,
  PersonalityStep,
  PlanStep,
} from "@/components/agent-wizard/wizard-step-bodies";
import { GenerationStatusCard } from "@/components/agent-wizard/generation-notice";
import { WIZARD_STEPS } from "@/components/agent-wizard/use-wizard-draft";
import { DEFAULT_WIZARD_VOICE_ID } from "@/lib/agents/wizard";
import {
  createAgentAction,
  ensureGenerationPlaceholderAction,
  getGenerationPlaceholderAction,
  updateAgentAction,
} from "../actions";
import { inputLanguage, voiceLabel } from "@/lib/agents/voices";
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
  const { markSeen, cancelJob } = useJobs();
  // Terminal-failure snapshot for the retry card (Goal 6): applyResult keeps
  // the raw error string for inline display; this keeps the error CODE for
  // jobErrorCopy. Null until a failed/cancelled watch resolves.
  const [terminalErrorCode, setTerminalErrorCode] = useState<string | null>(null);
  // Terminal failure consumed for a fresh creation (Goal 8): once the error
  // has been shown/consumed, starting over resets to a clean step-1 wizard.
  const [terminalFailureSeen, setTerminalFailureSeen] = useState(false);
  // Fresh-key retry in flight (Goal 6).
  const [retrying, setRetrying] = useState(false);
  const [restoring, setRestoring] = useState(restoreJobId !== null);
  // ?job= visits wait for the placeholder snapshot before showing review so
  // the name field and voice/language (mount-once form state) are seeded.
  const [seeded, setSeeded] = useState(restoreJobId === null);
  // Explicit draft gate (no silent restore): entering /agents/new with NO
  // ?job= and a durable pre-submit cache renders Continue/Discard instead of
  // the wizard. Client-only-after-mount: first render matches the server
  // (gate closed); the mount effect below opens it when a cache exists, so
  // the localStorage read never diverges SSR from the first client render.
  const [draftGateOpen, setDraftGateOpen] = useState(false);
  useEffect(() => {
    if (restoreJobId !== null) return;
    // Client-only-after-mount localStorage read; first render matches SSR
    // with gate closed, so this intentional mount-effect setState is safe.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (hasUnfinishedWizardDraft()) setDraftGateOpen(true);
    // restoreJobId is fixed for this mount; the gate opens once, then owns
    // its open/close state via Continue/Discard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
  // Fresh submission in flight (not a ?job= restore visit): the minimal-wait
  // early return below owns this render, so the wizard below only needs the
  // flag as defense-in-depth. Terminal failure/retry states are phase "done".
  const submitting =
    generation.phase === "starting" ||
    generation.phase === "waiting" ||
    generation.phase === "backgrounded";
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
        setTerminalErrorCode(job.errorCode ?? null);
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
    await startGeneration(brief, generationIdempotencyKey(brief));
  };

  /**
   * Shared submit path (Goal 6): initial Generate and the terminal-failure
   * retry both land here. The initial submit passes the stable per-brief key
   * (same-brief resubmits dedupe); the retry passes a `generation:retry:`
   * fresh key so it is a new submission by construction. Start-failure stays
   * inline (unchanged): a null start sets the inline error, no retry card.
   */
  const startGeneration = async (brief: string, idempotencyKey: string) => {
    setError(null);
    setTerminalErrorCode(null);
    setTerminalFailureSeen(false);
    setShowGuidance(false);
    setRetrying(false);
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
        // Same brief resubmitted (double-click, reload + resubmit) returns
        // the existing job instead of starting duplicate work. Explicit
        // retries pass their own fresh key (see the retry card below).
        idempotencyKey,
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
      // Start-failure stays inline (Goal 6): no retry card — the card is for
      // terminal job outcomes, not for a submission that never left.
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

  const handleCancelGeneration = generation.jobId
    ? () => {
        const id = generation.jobId;
        if (id) void cancelJob(id);
      }
    : undefined;

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
      toast.add({
        type: "error",
        title: result.errorCode ? jobErrorCopy(result.errorCode) : result.message,
      });
      return;
    }
    // Goal 8: a reviewed save is a terminal outcome — reset the wizard for
    // the next creation (step 0 + consumed-job entries) on top of the draft
    // clear, so a fresh creation starts clean. The Back-guard still needs the
    // consumed id for THIS job, which resetWizardForNewCreation clears from
    // storage — so record it first, then reset durable state, then arm the
    // in-memory dismiss.
    if (placeholder !== null && jobId !== null) markJobConsumed(jobId);
    clearWizardDraftCache();
    resetWizardForNewCreation();
    wiz.setStep(WIZARD_FRESH_STEP);
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
    const nameValue = current.agentName.trim().slice(0, 40);
    return [
      `step ${wiz.step + 1} of 2 (${WIZARD_STEPS[wiz.step]})`,
      `${current.goals.length} goals${current.goals.length > 0 ? `: ${current.goals.slice(0, 3).join(", ")}` : ""}`,
      `${current.tasks.length} tasks`,
      nameValue ? `name "${nameValue}"` : "name empty — name field ref agentName is visible and empty",
      `${current.styleTraits.length} style tags`,
      `voice ${current.voiceId || "unset"}`,
      `language ${current.conversationLanguage}`,
      draftGateOpen
        ? "draft gate OPEN: Continue draft? (Continue draft / Discard and start fresh) is showing INSTEAD of the wizard — say Continue previous draft or start fresh, never 'what should we call it'"
        : "draft gate closed: wizard fields visible (agentName, goals, tasks, voice, language); Continue/Discard not showing",
    ].join("; ");
  }, [wiz.step, wiz.draft, draftGateOpen]);
  const wizardDialogState = useMemo(
    () => ({ wizardStep: WIZARD_STEPS[wiz.step], draftGateOpen }),
    [wiz.step, draftGateOpen],
  );
  useEffect(() => {
    registerRoute("/agents/new", {
      tools: wizardCopilotTools,
      targets: createWizardTargetReader(() => draftRef.current),
      brief: `Building a phone agent. Now on ${wizardBrief}.`,
      dialogState: wizardDialogState,
    });
    return () => unregisterRoute("/agents/new");
  }, [registerRoute, unregisterRoute, wizardCopilotTools, wizardBrief, wizardDialogState, draftRef]);

  // Minimal generation wait: while submitting/restoring/backgrounded, the
  // entire wizard hides — steps, timeline, progress, footer, status-card
  // actions beyond Cancel, template hatch, and retry card. Only a single
  // Alert + indeterminate Progress + Cancel-generation button renders. This
  // sits after every hook (rules-of-hooks) but before the success review
  // branch, so ?job= restore, copilot registration, and the seeded review
  // all keep working while the wait is visible.
  const minimalWait = running && !(draft && seeded);
  // Draft gate sits with the other early returns (after every hook): a
  // no-?job= entry with a durable cache shows Continue/Discard INSTEAD of the
  // silently-restored wizard. ?job= restores never reach here (restoring=true
  // owns that render via minimalWait above; review owns it below).
  if (draftGateOpen && restoreJobId === null && !draft && !submitting) {
    return (
      <>
        <PageHeading
          title="Continue draft?"
          description="You have an unfinished agent draft from a previous visit. Continue where you left off, or discard it and start fresh."
        />
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="w-full sm:w-auto"
            onClick={() => {
              clearWizardDraftCache();
              wiz.edit(
                {
                  goals: [],
                  tasks: [],
                  agentName: "",
                  styleTraits: [],
                  conversationLanguage: EMPTY_DRAFT.conversationLanguage,
                  voiceId: EMPTY_DRAFT.voiceId,
                },
                "discard",
              );
              wiz.setStep(WIZARD_FRESH_STEP);
              setDraftGateOpen(false);
            }}
          >
            Discard and start fresh
          </Button>
          <Button
            type="button"
            className="w-full sm:w-auto"
            onClick={() => setDraftGateOpen(false)}
          >
            Continue draft
            <ArrowRight data-icon="inline-end" aria-hidden />
          </Button>
        </div>
      </>
    );
  }
  if (minimalWait) {
    return (
      <>
        <PageHeading
          title="New agent"
          description="Answer two quick steps and we'll generate a starting mission and rules, editable afterward. Prefer talking? The Voice copilot button in the sidebar fills in every field with you."
        />
        <GenerationStatusCard
          phase={backgrounded ? "backgrounded" : "working"}
          onCancel={handleCancelGeneration}
        />
        {backgrounded ? <span className="sr-only">Generation continuing in the background.</span> : null}
      </>
    );
  }

  if (draft && seeded) {
    // Verifiable summary: mirrors the saved fields below (name, voice,
    // language) plus the brief that produced them, so "save as shown"
    // can be checked at a glance. Counts come from the live wizard
    // draft; voice/language were folded into the draft on landing.
    const summaryName = wiz.draft.agentName || draft.identity.name;
    const summaryVoice = voiceLabel(draft.voiceId);
    const summaryLanguage =
      draft.languageCodes.length === 0
        ? "Auto-detect"
        : (inputLanguage(draft.languageCodes[0] ?? "")?.label ??
          draft.languageCodes[0]);
    return (
      <div className="flex flex-col gap-6">
        <PageHeading
          title="Review agent"
          description="Everything here is editable. Nothing is saved until you say so."
        />
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-foreground text-sm font-medium">
              {summaryName}
            </span>
            <Badge variant="secondary">Ready to save</Badge>
          </div>
          <div className="text-muted-foreground flex flex-col gap-1 text-sm">
            <p>
              Voice {summaryVoice} · {summaryLanguage}
            </p>
            <p>
              Brief: {wiz.draft.goals.length} goals ·{" "}
              {wiz.draft.tasks.length} tasks
            </p>
          </div>
        </div>

        <AgentConfigForm
          initialName={wiz.draft.agentName || draft.identity.name}
          initialConfig={draft}
          submitLabel="Deploy agent"
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

  const stepLabel = WIZARD_STEPS[wiz.step] ?? "";
  const progressValue = ((wiz.step + 1) / WIZARD_STEPS.length) * 100;
  // Below this point `running` is always false: the minimal-wait early return
  // above owns every submitting/restoring/backgrounded render, so the wizard
  // here is the plain two-step flow (plus terminal retry/error states). The
  // `!submitting` guards are kept as defense-in-depth.
  return (
    <>
      <PageHeading
        title="New agent"
        description="Answer two quick steps and we'll generate a starting mission and rules, editable afterward. Prefer talking? The Voice copilot button in the sidebar fills in every field with you."
      />

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium">{stepLabel}</p>
            <p className="text-muted-foreground text-xs">
              Step {wiz.step + 1} of {WIZARD_STEPS.length}
            </p>
          </div>
          <p className="text-muted-foreground text-sm">
            {wiz.step === 0
              ? "Start with the big picture, then break it into directions."
              : "A name plus a vibe — type it, or tell the voice copilot."}
          </p>
          <Progress value={progressValue} aria-label="Creation progress" />
        </div>
        <TimelineBar current={wiz.step} completed={wiz.completed} onSelect={wiz.setStep} />
        <FormSectionSeparator />
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
          briefError && !submitting && (terminalErrorCode !== null || error !== null) ? (
            // Terminal-failure retry card (Goal 6): distinct per-mode copy via
            // jobErrorCopy(terminalErrorCode) — never generic — plus the retry
            // contract: a fresh attempt starts clean and a completed draft
            // appears here for review. Cancelled jobs get their cancelled
            // copy, not the failure copy. Start-failure (never submitted)
            // stays inline via GenerationStatus below — it never sets
            // terminalErrorCode, so it cannot land here.
            <div className="flex flex-col gap-3">
              <GenerationRetryCard
                title={terminalErrorCode === "cancelled" || briefError === "Generation was cancelled." ? "Generation was cancelled" : "Generation didn't finish"}
                description={`${terminalErrorCode ? jobErrorCopy(terminalErrorCode) : briefError} Retry to start a fresh attempt — a completed draft appears here for review.`}
                retrying={retrying}
                onRetry={() => {
                  // Fresh-key retry: a new submission with a random nonce
                  // suffix, never the stable per-brief key.
                  if (retrying) return;
                  setRetrying(true);
                  const brief = composeBrief(wiz.draft);
                  setTerminalFailureSeen(false);
                  void startGeneration(brief, `generation:retry:${crypto.randomUUID()}`).finally(() => {
                    setRetrying(false);
                  });
                }}
                onOpenJobs={() => router.push("/jobs")}
                retryTestId="generation-retry-new"
              />
              {showGuidance ? <ManualLlmGuidance /> : null}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  // Goal 8: terminal failure consumed for a fresh creation —
                  // drop durable state and reset to a clean step-1 wizard.
                  // The failed brief is gone; pre-submit reload restore still
                  // works for live drafts because nothing live was cleared
                  // beyond the finished creation's entries.
                  setTerminalFailureSeen(true);
                  setError(null);
                  setTerminalErrorCode(null);
                  setShowGuidance(false);
                  resetWizardForNewCreation();
                  wiz.setStep(WIZARD_FRESH_STEP);
                  router.replace("/agents/new");
                }}
              >
                Start over with a new brief
              </Button>
            </div>
          ) : (
            <>
              <GenerationStatus
                phase="idle"
                onCancel={handleCancelGeneration}
                error={briefError}
                onUseTemplate={useTemplate}
              />
              {terminalFailureSeen ? (
                <p className="text-muted-foreground text-sm">
                  Previous attempt cleared — describe the agent above and generate again.
                </p>
              ) : null}
            </>
          )
        ) : null}

        {/* Page footer: outside filled bodies. Unreachable while submitting —
            the minimal-wait early return above owns that render — so the
            primary is always a real action here. */}
        <div>
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
                <Button
                  type="button"
                  className="w-full md:w-auto pointer-coarse:min-h-11"
                  data-copilot-effect="view"
                  onClick={() => void generate()}
                >
                  Generate agent
                  <ArrowRight data-icon="inline-end" aria-hidden />
                </Button>
              )
            }
          />
        </div>
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

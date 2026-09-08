"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, FileText, Play, Sparkles, Square, TriangleAlert, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { LoadingButton } from "@/components/loading-button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { GenerationNotice } from "./generation-notice";
import { MascotAvatar, type MascotMood } from "./guide-mascot";
import { MAX_TASKS, MAX_TASK_LENGTH, STARTER_DEFS, addCustomTask } from "./starters";
import {
  ACCENT_LABEL,
  INPUT_LANGUAGES,
  voiceLabel,
  voicesByLanguage,
  type Voice,
} from "@/lib/agents/voices";
import { buildPreviewText } from "@/lib/voice/preview";
import type { FlashKey, WizardDraftApi } from "./use-wizard-draft";

export type DemoPhase = "idle" | "working" | "backgrounded" | "done";

export const PERSONALITY_CHIPS = [
  "Friendly property consultant",
  "Calm support agent",
  "Energetic sales closer",
];

export const TASK_CHIPS = [
  "Ask for budget and timeline",
  "Offer two viewing slots",
  "Answer common questions directly",
  "Confirm attendance or offer a new time",
  "Hand off to a human when stuck",
];

/** One greeting script for the merged headers: avatar + question + hint. */
export const STEP_MASCOTS: Record<number, StepMascot> = {
  0: {
    mood: "waving",
    title: "What should this agent accomplish?",
    message: "One sentence is enough — type it, or tell the voice copilot.",
  },
  1: {
    mood: "thinking",
    title: "Who should your agent be?",
    message: "A name plus a vibe — type it, or tell the voice copilot.",
  },
  2: {
    mood: "thinking",
    title: "What should it actually do?",
    message: "Tap tasks — or ask the voice copilot to set them.",
  },
  3: {
    mood: "celebrating",
    title: "Ready to generate?",
    message: "Review the summary — nothing saves until you say so.",
  },
};

function flashClass(flashed: FlashKey, key: Exclude<FlashKey, null>): string {
  return flashed === key ? "field-flash" : "";
}

export type StepMascot = {
  mood: MascotMood;
  title: string;
  message: string;
};

export type StepBodyProps = {
  api: WizardDraftApi;
  /** Merged greeting: the mascot lives in the step header, not its own card. */
  mascot: StepMascot;
  /** Unique prefix so label ids never collide across demo tabs. */
  idPrefix: string;
};

/** One card, one header: avatar + question + hint. Replaces mascot-card + step-card stacking. */
function StepHeader({ mascot }: { mascot: StepMascot }) {
  return (
    <CardHeader>
      <div className="flex items-center gap-2.5">
        <MascotAvatar mood={mascot.mood} size="sm" />
        <CardTitle className="text-base">{mascot.title}</CardTitle>
      </div>
      <CardDescription>{mascot.message}</CardDescription>
    </CardHeader>
  );
}

export function GoalStep({
  api,
  mascot,
  idPrefix,
}: StepBodyProps) {
  const id = `${idPrefix}-goal`;

  const applyStarter = (number: number) => {
    const starter = STARTER_DEFS.find((s) => s.number === number);
    if (!starter) return;
    const tasks = [...api.draft.tasks];
    for (const t of starter.suggestTasks) {
      if (!tasks.includes(t)) tasks.push(t);
    }
    // Same patch + history path as any other edit: one Undo reverts all.
    api.edit({ goal: starter.goal, tasks }, `starter ${starter.number}`);
  };

  return (
    <Card>
      <StepHeader mascot={mascot} />
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Goal starters">
          {STARTER_DEFS.map((starter) => {
            const applied = api.draft.goal === starter.goal;
            const descId = `${idPrefix}-starter-${starter.number}-outcome`;
            return (
              <Button
                key={starter.number}
                type="button"
                size="sm"
                variant={applied ? "secondary" : "outline"}
                className="cursor-pointer"
                title={starter.outcome}
                aria-describedby={descId}
                onClick={() => applyStarter(starter.number)}
                aria-pressed={applied}
              >
                {starter.title}
                {applied ? (
                  <Badge variant="default" className="gap-1">
                    <Check className="size-3" aria-hidden />
                    Applied
                  </Badge>
                ) : null}
                <span id={descId} className="sr-only">
                  {starter.outcome}
                </span>
              </Button>
            );
          })}
        </div>
        <Label htmlFor={id}>Or describe your own goal</Label>
        <Textarea
          id={id}
          rows={3}
          value={api.draft.goal}
          onChange={(e) => {
            api.edit({ goal: e.target.value }, "goal change");
          }}
          placeholder="e.g. Contact new property leads and book viewings."
          className={flashClass(api.flashed, "goal")}
        />
      </CardContent>
    </Card>
  );
}

export function PersonalityStep({
  api,
  mascot,
  idPrefix,
}: StepBodyProps) {
  // Per-voice preview state (never one shared boolean — each Play button
  // tracks its own pending/speaking state independently).
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewNeedsKey, setPreviewNeedsKey] = useState(false);
  const [retryIn, setRetryIn] = useState<number | null>(null);
  const playSeq = useRef(0);
  const lastVoice = useRef<Voice | null>(null);

  const stopPreview = () => {
    playSeq.current += 1;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setPlayingId(null);
    setLoadingId(null);
  };

  // Never leave speech running after the step unmounts.
  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  // 429 countdown — same copy shape as voice-call.tsx.
  useEffect(() => {
    if (retryIn === null || retryIn <= 0) return;
    const id = setTimeout(() => setRetryIn((s) => (s === null ? null : s - 1)), 1000);
    return () => clearTimeout(id);
  }, [retryIn]);

  const togglePreview = async (voice: Voice) => {
    // Second tap stops. Switching voices cancels the old one first.
    if (playingId === voice.id || loadingId === voice.id) {
      stopPreview();
      return;
    }
    stopPreview();
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setPreviewNeedsKey(false);
      setPreviewError("Voice preview isn't supported in this browser.");
      return;
    }
    lastVoice.current = voice;
    setLoadingId(voice.id);
    setPreviewError(null);
    setPreviewNeedsKey(false);
    setRetryIn(null);
    const seq = playSeq.current;
    let grant: { voiceId: string; text: string; locale: string };
    try {
      const res = await fetch("/api/voice-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voiceId: voice.id,
          text: buildPreviewText(api.draft.agentName),
        }),
      });
      if (!res.ok) {
        if (res.status === 503) {
          if (seq === playSeq.current) {
            setPreviewNeedsKey(true);
            setPreviewError("Voice preview needs an AssemblyAI key first.");
            setLoadingId(null);
          }
          return;
        }
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get("Retry-After"));
          if (seq === playSeq.current) {
            setRetryIn(
              Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60,
            );
            setPreviewError("Too many previews right now.");
            setLoadingId(null);
          }
          return;
        }
        throw new Error(`preview ${res.status}`);
      }
      grant = (await res.json()) as typeof grant;
    } catch {
      if (seq === playSeq.current) {
        setPreviewError("Couldn't load the preview. Try again.");
        setLoadingId(null);
      }
      return;
    }
    if (seq !== playSeq.current) return;
    // The grant carries the sanitized text; speech itself is the browser's
    // synthesis (AssemblyAI has no standalone TTS) — selected for the
    // voice's language/accent family, never auto-played, explicit tap only.
    const utter = new SpeechSynthesisUtterance(grant.text);
    const browserVoices = window.speechSynthesis.getVoices();
    utter.voice =
      browserVoices.find((v) => v.lang === grant.locale) ??
      browserVoices.find((v) => v.lang.startsWith(grant.locale.slice(0, 2))) ??
      null;
    utter.lang = grant.locale;
    utter.onend = () => {
      if (seq === playSeq.current) {
        setPlayingId(null);
        setLoadingId(null);
      }
    };
    utter.onerror = () => {
      if (seq === playSeq.current) {
        setPlayingId(null);
        setLoadingId(null);
      }
    };
    setLoadingId(null);
    setPlayingId(voice.id);
    window.speechSynthesis.speak(utter);
  };

  const selectVoice = (voice: Voice) => {
    // Selecting another voice stops the current sample — samples never overlap.
    if (playingId !== null || loadingId !== null) stopPreview();
    api.edit({ voiceId: voice.id }, "voice change");
  };

  const toggleLanguage = (code: string) => {
    const on = api.draft.languageCodes.includes(code);
    api.edit(
      {
        languageCodes: on
          ? api.draft.languageCodes.filter((c) => c !== code)
          : [...api.draft.languageCodes, code],
      },
      "language change",
    );
  };

  const showMismatch = api.draft.languageCodes.some(
    (c) => !INPUT_LANGUAGES.find((l) => l.code === c)?.canSpeak,
  );

  return (
    <Card>
      <StepHeader mascot={mascot} />
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${idPrefix}-name`}>Agent name</Label>
          <Input
            id={`${idPrefix}-name`}
            value={api.draft.agentName}
            onChange={(e) => {
              api.edit({ agentName: e.target.value }, "name change");
            }}
            placeholder="e.g. Sara"
            className={flashClass(api.flashed, "agentName")}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${idPrefix}-personality`}>Sounds like</Label>
          <Input
            id={`${idPrefix}-personality`}
            value={api.draft.personality}
            onChange={(e) => {
              api.edit({ personality: e.target.value }, "personality change");
            }}
            placeholder="e.g. Friendly property consultant"
            className={flashClass(api.flashed, "personality")}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {PERSONALITY_CHIPS.map((chip) => (
            <Button
              key={chip}
              type="button"
              size="sm"
              variant="outline"
              className="cursor-pointer"
              onClick={() => {
                api.edit({ personality: chip }, "personality change");
              }}
            >
              {chip}
            </Button>
          ))}
        </div>
        <div className={cn("flex flex-col gap-3", flashClass(api.flashed, "voice"))}>
          <div>
            <Label>Voice</Label>
            <p className="text-muted-foreground text-xs">
              Preview uses your browser&apos;s voice — the final voice renders
              on the call.
            </p>
          </div>
          {voicesByLanguage().map((group) => (
            <div key={group.language} className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-[11px] uppercase tracking-wide">
                {group.language}
              </span>
              <div className="flex flex-wrap gap-2">
                {group.voices.map((voice: Voice) => {
                  const selected = voice.id === api.draft.voiceId;
                  const playing = playingId === voice.id;
                  const loading = loadingId === voice.id;
                  return (
                    <span key={voice.id} className="inline-flex items-center gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant={selected ? "default" : "outline"}
                        className="cursor-pointer"
                        onClick={() => selectVoice(voice)}
                        aria-pressed={selected}
                      >
                        {voiceLabel(voice.id)}
                        <span className="opacity-60">
                          {ACCENT_LABEL[voice.accent]}
                        </span>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 cursor-pointer p-0"
                        onClick={() => {
                          void togglePreview(voice);
                        }}
                        disabled={loading}
                        aria-label={
                          loading
                            ? `Loading ${voiceLabel(voice.id)} preview`
                            : playing
                              ? `Stop ${voiceLabel(voice.id)} preview`
                              : `Preview ${voiceLabel(voice.id)}`
                        }
                      >
                        {playing ? (
                          <Square className="size-3" aria-hidden />
                        ) : (
                          <Play className="size-3" aria-hidden />
                        )}
                      </Button>
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
          <span aria-live="polite" className="sr-only">
            {loadingId
              ? `Loading ${voiceLabel(loadingId)} preview.`
              : playingId
                ? `Playing ${voiceLabel(playingId)} preview.`
                : null}
          </span>
          {retryIn !== null || previewError ? (
            <Alert variant={previewNeedsKey ? "default" : "destructive"}>
              <TriangleAlert className="h-4 w-4" aria-hidden />
              <AlertDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {retryIn !== null ? (
                  <span>
                    {retryIn > 0
                      ? `Too many previews right now — try again in ${retryIn}s.`
                      : "You can try again now."}
                  </span>
                ) : (
                  <span>{previewError}</span>
                )}
                {previewNeedsKey ? (
                  <Link
                    href="/settings"
                    className="cursor-pointer underline underline-offset-4"
                  >
                    Open Settings
                  </Link>
                ) : !previewNeedsKey && previewError && retryIn === null ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 cursor-pointer px-1.5 text-xs"
                    onClick={() => {
                      const voice = lastVoice.current;
                      if (voice) void togglePreview(voice);
                    }}
                  >
                    Retry
                  </Button>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
        <div className={cn("flex flex-col gap-2", flashClass(api.flashed, "languages"))}>
          <Label>Languages it listens for</Label>
          <p className="text-muted-foreground text-xs">
            Leave all off to detect automatically — that covers every
            supported language and handles callers switching mid-sentence.
            Pin languages only for a region-specific line.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            {INPUT_LANGUAGES.map((lang) => {
              const on = api.draft.languageCodes.includes(lang.code);
              return (
                <Button
                  key={lang.code}
                  type="button"
                  size="sm"
                  variant={on ? "default" : "outline"}
                  className="cursor-pointer"
                  onClick={() => toggleLanguage(lang.code)}
                  aria-pressed={on}
                >
                  <span aria-hidden>{lang.flag}</span>
                  {lang.label}
                  {!lang.canSpeak ? (
                    <span className="opacity-60">understands only</span>
                  ) : null}
                </Button>
              );
            })}
          </div>
          {showMismatch ? (
            <p className="text-muted-foreground flex items-start gap-2 text-xs">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              Some selected languages have no voice yet. Callers can speak
              them and the agent will understand, but it replies in{" "}
              {voiceLabel(api.draft.voiceId)}&apos;s language.
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function TasksStep({ api, mascot, idPrefix }: StepBodyProps) {
  const [customValue, setCustomValue] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  const customTasks = api.draft.tasks.filter((t) => !TASK_CHIPS.includes(t));
  const taskCount = api.draft.tasks.length;
  const atCap = taskCount >= MAX_TASKS;

  const submitCustom = () => {
    const result = addCustomTask(api.draft.tasks, customValue);
    if (!result.ok) {
      setCustomError(result.message);
      return;
    }
    setCustomValue("");
    setCustomError(null);
    // Same patch + history path as any other edit: one Undo reverts the add.
    api.edit({ tasks: result.tasks }, "custom task add");
  };

  const removeCustom = (task: string) => {
    // One Undo reverts the removal.
    api.edit(
      { tasks: api.draft.tasks.filter((t) => t !== task) },
      "custom task remove",
    );
  };

  return (
    <Card className={cn(flashClass(api.flashed, "tasks"), "rounded-lg")}>
      <StepHeader mascot={mascot} />
      <CardContent id={`${idPrefix}-tasks`} className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Task presets">
          {TASK_CHIPS.map((task) => {
            const on = api.draft.tasks.includes(task);
            return (
              <Button
                key={task}
                type="button"
                size="sm"
                variant={on ? "default" : "outline"}
                className="cursor-pointer"
                onClick={() => {
                  api.toggleTask(task);
                }}
              >
                {on ? <Check aria-hidden /> : null}
                {task}
              </Button>
            );
          })}
          {customTasks.map((task) => (
            <Badge
              key={task}
              variant="secondary"
              className="h-auto gap-1 py-1 pr-1 pl-2.5 whitespace-normal"
            >
              <span className="max-w-48 text-xs font-medium break-words">{task}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-5 w-5 cursor-pointer p-0"
                onClick={() => removeCustom(task)}
                aria-label={`Remove ${task}`}
              >
                <X className="size-3" aria-hidden />
              </Button>
            </Badge>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            id={`${idPrefix}-custom-task`}
            value={customValue}
            onChange={(e) => {
              setCustomValue(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitCustom();
              }
            }}
            placeholder="e.g. Ask for preferred language"
            maxLength={MAX_TASK_LENGTH}
            aria-describedby={`${idPrefix}-custom-task-hint`}
          />
          <Button
            type="button"
            size="sm"
            className="shrink-0 cursor-pointer"
            onClick={submitCustom}
            disabled={atCap || customValue.trim().length === 0}
          >
            Add
          </Button>
        </div>
        <div className="flex items-center justify-between gap-2">
          <p
            id={`${idPrefix}-custom-task-hint`}
            aria-live="polite"
            className="text-muted-foreground text-xs"
          >
            {customError ??
              (atCap
                ? `Task limit reached (${MAX_TASKS}/${MAX_TASKS}). Remove one to add another.`
                : "Custom tasks stay with this draft.")}
          </p>
          <span
            className="text-muted-foreground shrink-0 text-xs"
            aria-label={`${taskCount} of ${MAX_TASKS} tasks`}
          >
            {taskCount}/{MAX_TASKS}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

export type ReviewPhase = "idle" | "working" | "backgrounded";

export function ReviewStep({
  api,
  mascot,
  phase,
  canGenerate,
  onGenerate,
  onOpenJobs,
  error,
  onUseTemplate,
  flashed,
  canUndo,
  undoLabel,
  onUndo,
  onJump,
}: {
  api: WizardDraftApi;
  mascot: StepMascot;
  phase: ReviewPhase;
  /** False until a goal exists — empty briefs never reach the job queue. */
  canGenerate: boolean;
  onGenerate: () => void;
  onOpenJobs: () => void;
  error: string | null;
  /** Real-estate template escape hatch when generation fails. */
  onUseTemplate?: () => void;
  /** Field the voice copilot just touched — highlights the matching row. */
  flashed: FlashKey;
  canUndo: boolean;
  undoLabel: string | null;
  onUndo: () => void;
  onJump: (step: number) => void;
}) {
  const { draft } = api;
  const set = [
    draft.goal.trim().length > 0,
    draft.agentName.trim().length > 0 || draft.personality.trim().length > 0,
    draft.tasks.length > 0,
  ];
  const doneCount = set.filter(Boolean).length;
  const personaFlashed =
    flashed === "agentName" ||
    flashed === "personality" ||
    flashed === "voice" ||
    flashed === "languages";
  const personaText =
    [draft.agentName, draft.personality].filter(Boolean).join(" · ") || "—";
  return (
    <Card>
      <StepHeader mascot={mascot} />
      <CardContent className="flex flex-col gap-3">
        <dl className="flex flex-col gap-1 text-sm">
          <div
            className={cn(
              "flex items-start gap-2 rounded-md px-2 py-1.5",
              flashClass(flashed, "goal"),
            )}
          >
            <dt className="text-muted-foreground w-24 shrink-0 pt-1">Goal</dt>
            <dd className="min-w-0 flex-1 break-words">{draft.goal || "—"}</dd>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0 cursor-pointer"
              onClick={() => onJump(0)}
              aria-label="Edit goal"
            >
              Edit
            </Button>
          </div>
          <div
            className={cn(
              "flex items-start gap-2 rounded-md px-2 py-1.5",
              personaFlashed && "field-flash",
            )}
          >
            <dt className="text-muted-foreground w-24 shrink-0 pt-1">Persona</dt>
            <dd className="min-w-0 flex-1 break-words">
              {personaText} · {voiceLabel(draft.voiceId)}
            </dd>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0 cursor-pointer"
              onClick={() => onJump(1)}
              aria-label="Edit persona"
            >
              Edit
            </Button>
          </div>
          <div
            className={cn(
              "flex items-start gap-2 rounded-md px-2 py-1.5",
              flashClass(flashed, "tasks"),
            )}
          >
            <dt className="text-muted-foreground w-24 shrink-0 pt-1">Tasks</dt>
            <dd className="min-w-0 flex-1 break-words">
              {draft.tasks.length ? draft.tasks.join(" · ") : "—"}
            </dd>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0 cursor-pointer"
              onClick={() => onJump(2)}
              aria-label="Edit tasks"
            >
              Edit
            </Button>
          </div>
        </dl>
        <div className="px-2">
          <Progress
            value={Math.round((doneCount / 3) * 100)}
            aria-label={`${doneCount} of 3 sections set`}
          />
          <p className="text-muted-foreground mt-1 text-xs">{doneCount} of 3 set</p>
        </div>
        {canUndo && undoLabel ? (
          <span className="px-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 cursor-pointer px-1.5 text-xs"
              onClick={onUndo}
            >
              Undo {undoLabel}
            </Button>
          </span>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <LoadingButton
            pending={phase === "working"}
            pendingText="Generating…"
            icon={<Sparkles aria-hidden />}
            onClick={onGenerate}
            disabled={!canGenerate || phase === "working" || phase === "backgrounded"}
          >
            Generate agent
          </LoadingButton>
          {!canGenerate ? (
            <span className="text-muted-foreground text-xs">
              Pick a starter or write a goal first.
            </span>
          ) : null}
        </div>
        {phase === "backgrounded" ? (
          <GenerationNotice title="Still generating your draft…" onOpenJobs={onOpenJobs} />
        ) : null}
        {error ? (
          <div className="flex items-start gap-2 rounded-lg border p-3">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">Couldn&apos;t generate</p>
              <p className="text-muted-foreground text-xs whitespace-pre-wrap">{error}</p>
              <p className="text-muted-foreground text-xs">
                Retry — a fresh attempt starts clean — or use a complete,
                working template in the meantime.
              </p>
              {onUseTemplate ? (
                <span>
                  <Button type="button" size="sm" variant="outline" onClick={onUseTemplate}>
                    <FileText aria-hidden />
                    Use the real estate template
                  </Button>
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

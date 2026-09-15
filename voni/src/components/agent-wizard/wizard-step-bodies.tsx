"use client";

import { useEffect, useRef } from "react";
import { FileText, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { TagField, type TagFieldHandle } from "@/components/wizard/tag-field";
import { ConversationPicker } from "@/components/wizard/conversation-picker";
import { GenerationStatusCard } from "./generation-notice";
import { GOAL_SUGGESTIONS, TASK_SUGGESTIONS } from "./starters";
import {
  MAX_GOAL_LENGTH,
  MAX_GOALS,
  MAX_STYLE_LENGTH,
  MAX_STYLE_TRAITS,
  MAX_TASK_LENGTH,
  MAX_TASKS,
} from "@/lib/agents/wizard";
import { cn } from "@/lib/utils";
import type { FlashKey, WizardDraftApi } from "./use-wizard-draft";

export const STYLE_SUGGESTIONS = ["Friendly", "Energetic", "Calm", "Direct", "Patient"];

function flashClass(flashed: FlashKey, key: Exclude<FlashKey, null>): string {
  return flashed === key ? "ring-1 ring-primary/30 bg-primary/5" : "";
}

function StepHeading({ title, description }: { title: string; description: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className="flex flex-col gap-2">
      <h2
        ref={ref}
        id="wizard-step-heading"
        tabIndex={-1}
        className="text-base font-semibold outline-none"
      >
        {title}
      </h2>
      <p className="text-muted-foreground text-sm">{description}</p>
    </div>
  );
}

export type StepBodyProps = {
  api: WizardDraftApi;
  /** Unique prefix so label ids never collide across instances. */
  idPrefix: string;
};

export function PlanStep({
  api,
  idPrefix,
  goalsRef,
  tasksRef,
  error,
  onClearError,
}: StepBodyProps & {
  goalsRef?: React.Ref<TagFieldHandle>;
  tasksRef?: React.Ref<TagFieldHandle>;
  error?: string | null;
  onClearError?: (field: "goals" | "name") => void;
}) {
  return (
    <div className="flex flex-col gap-6">
        <StepHeading
          title="What should your agent do?"
          description="Start with the big picture, then break it into directions."
        />
        <div className={flashClass(api.flashed, "goals")}>
          <TagField
            ref={goalsRef}
            id={`${idPrefix}-goals`}
            label="1 · Goals"
            description="The big picture — the outcome that must happen by the end of the call."
            values={api.draft.goals}
            onChange={(goals) => {
              onClearError?.("goals");
              api.edit({ goals }, "goals change");
            }}
            suggestions={GOAL_SUGGESTIONS.map((value) => ({ value }))}
            maxCount={MAX_GOALS}
            maxLength={MAX_GOAL_LENGTH}
            placeholder="Add a goal"
            error={error}
          />
        </div>
        <Separator />
        <div className={flashClass(api.flashed, "tasks")}>
          <TagField
            ref={tasksRef}
            id={`${idPrefix}-tasks`}
            label="2 · Tasks"
            description="Short directions for how the agent gets there."
            values={api.draft.tasks}
            onChange={(tasks) => {
              api.edit({ tasks }, "tasks change");
            }}
            suggestions={TASK_SUGGESTIONS.map((value) => ({ value }))}
            maxCount={MAX_TASKS}
            maxLength={MAX_TASK_LENGTH}
            placeholder="Add a task"
            blockOnInvalidPending={false}
          />
        </div>
    </div>
  );
}

export function PersonalityStep({
  api,
  idPrefix,
  styleRef,
  nameError,
  onClearError,
}: StepBodyProps & {
  styleRef?: React.Ref<TagFieldHandle>;
  nameError?: string | null;
  onClearError?: (field: "goals" | "name") => void;
}) {
  return (
    <div className="flex flex-col gap-6">
        <StepHeading
          title="Who should your agent be?"
          description="A name plus a vibe — type it, or tell the voice copilot."
        />
        <div className="max-w-sm">
          <Field data-invalid={nameError ? true : undefined}>
            <FieldLabel htmlFor={`${idPrefix}-name`}>Agent name</FieldLabel>
            <Input
              id={`${idPrefix}-name`}
              value={api.draft.agentName}
              onChange={(e) => {
                onClearError?.("name");
                api.edit({ agentName: e.target.value }, "name change");
              }}
              placeholder="Name your agent"
              maxLength={120}
              autoComplete="off"
              aria-invalid={nameError ? true : undefined}
              className={flashClass(api.flashed, "agentName")}
            />
            <div className="min-h-5">
              {nameError ? <FieldError>{nameError}</FieldError> : null}
            </div>
          </Field>
        </div>
        <div className={flashClass(api.flashed, "styleTraits")}>
          <TagField
            ref={styleRef}
            id={`${idPrefix}-style`}
            label="Conversational style"
            description="Shapes how the agent responds. The selected voice determines how it sounds."
            values={api.draft.styleTraits}
            onChange={(styleTraits) => {
              api.edit({ styleTraits }, "style change");
            }}
            suggestions={STYLE_SUGGESTIONS.map((value) => ({ value }))}
            suggestionsLabel="Try one, combine a few, or write your own"
            maxCount={MAX_STYLE_TRAITS}
            maxLength={MAX_STYLE_LENGTH}
            placeholder="Add a style"
            blockOnInvalidPending={false}
          />
        </div>
        <div className={cn(flashClass(api.flashed, "voice"), flashClass(api.flashed, "conversationLanguage"))}>
          <ConversationPicker
            language={api.draft.conversationLanguage}
            voiceId={api.draft.voiceId}
            onChange={({ language, voiceId }) => {
              api.edit(
                { conversationLanguage: language, voiceId },
                "language change",
              );
            }}
          />
        </div>
    </div>
  );
}

export type GenerationStatusPhase = "idle" | "working" | "backgrounded";

/** Generation progress, errors, and the template fallback — shown in-flow. */
export function GenerationStatus({
  phase,
  onCancel,
  error,
  onUseTemplate,
}: {
  phase: GenerationStatusPhase;
  /** Cancels the in-flight generation job. */
  onCancel?: () => void;
  error: string | null;
  /** Real-estate template escape hatch when generation fails. */
  onUseTemplate?: () => void;
}) {
  return (
    <>
      {phase === "working" || phase === "backgrounded" ? (
        <GenerationStatusCard phase={phase} onCancel={onCancel} />
      ) : null}
      {error ? (
        <Alert>
          <TriangleAlert aria-hidden />
          <AlertTitle>Couldn&apos;t generate</AlertTitle>
          <AlertDescription>
            <span className="whitespace-pre-wrap">{error}</span>
            <span>
              Retry — a fresh attempt starts clean — or use a complete,
              working template in the meantime: a property-consultant
              agent that books viewings, with viewing tools,
              qualification questions, and call follow-up rules.
            </span>
            {onUseTemplate ? (
              <span>
                <Button type="button" size="sm" variant="outline" onClick={onUseTemplate}>
                  <FileText aria-hidden />
                  Use the real estate template
                </Button>
              </span>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

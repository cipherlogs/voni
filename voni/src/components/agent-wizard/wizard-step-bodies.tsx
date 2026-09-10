"use client";

import { useEffect, useRef } from "react";
import { FileText, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { TagField, type TagFieldHandle } from "@/components/wizard/tag-field";
import { ConversationPicker } from "@/components/wizard/conversation-picker";
import { FormCard, FormCardSections } from "@/components/wizard/form-layout";
import { GenerationNotice } from "./generation-notice";
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
  return flashed === key ? "field-flash" : "";
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
  onClearError?: () => void;
}) {
  return (
    <FormCard>
      <FormCardSections>
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
              onClearError?.();
              api.edit({ goals }, "goals change");
            }}
            suggestions={GOAL_SUGGESTIONS.map((value) => ({ value }))}
            maxCount={MAX_GOALS}
            maxLength={MAX_GOAL_LENGTH}
            placeholder="Add a goal…"
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
              onClearError?.();
              api.edit({ tasks }, "tasks change");
            }}
            suggestions={TASK_SUGGESTIONS.map((value) => ({ value }))}
            maxCount={MAX_TASKS}
            maxLength={MAX_TASK_LENGTH}
            placeholder="Add a task…"
            blockOnInvalidPending={false}
          />
        </div>
      </FormCardSections>
    </FormCard>
  );
}

export function PersonalityStep({
  api,
  idPrefix,
  styleRef,
  onClearError,
}: StepBodyProps & { styleRef?: React.Ref<TagFieldHandle>; onClearError?: () => void }) {
  return (
    <FormCard>
      <FormCardSections>
        <StepHeading
          title="Who should your agent be?"
          description="A name plus a vibe — type it, or tell the voice copilot."
        />
        <div className="max-w-sm">
          <Field>
            <FieldLabel htmlFor={`${idPrefix}-name`}>Agent name</FieldLabel>
            <Input
              id={`${idPrefix}-name`}
              value={api.draft.agentName}
              onChange={(e) => {
                onClearError?.();
                api.edit({ agentName: e.target.value }, "name change");
              }}
              placeholder="e.g. Sara"
              maxLength={120}
              autoComplete="off"
              className={flashClass(api.flashed, "agentName")}
            />
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
              onClearError?.();
              api.edit({ styleTraits }, "style change");
            }}
            suggestions={STYLE_SUGGESTIONS.map((value) => ({ value }))}
            suggestionsLabel="Try one, combine a few, or write your own"
            maxCount={MAX_STYLE_TRAITS}
            maxLength={MAX_STYLE_LENGTH}
            placeholder="Add a style…"
            blockOnInvalidPending={false}
          />
        </div>
        <div className={cn(flashClass(api.flashed, "voice"), flashClass(api.flashed, "conversationLanguage"))}>
          <ConversationPicker
            language={api.draft.conversationLanguage}
            voiceId={api.draft.voiceId}
            agentName={api.draft.agentName}
            onChange={({ language, voiceId }) => {
              onClearError?.();
              api.edit(
                { conversationLanguage: language, voiceId },
                "language change",
              );
            }}
          />
        </div>
      </FormCardSections>
    </FormCard>
  );
}

export type GenerationStatusPhase = "idle" | "working" | "backgrounded";

/** Generation progress, errors, and the template fallback — shown in-flow. */
export function GenerationStatus({
  phase,
  onOpenJobs,
  error,
  onUseTemplate,
}: {
  phase: GenerationStatusPhase;
  onOpenJobs: () => void;
  error: string | null;
  /** Real-estate template escape hatch when generation fails. */
  onUseTemplate?: () => void;
}) {
  return (
    <>
      {phase === "backgrounded" ? (
        <GenerationNotice title="Still generating your draft…" onOpenJobs={onOpenJobs} />
      ) : null}
      {error ? (
        <div className="flex items-start gap-2 rounded-lg border p-3">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
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
    </>
  );
}

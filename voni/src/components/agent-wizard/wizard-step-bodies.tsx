"use client";

import { useEffect, useRef } from "react";
import { FileText, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { TagField, type TagFieldHandle } from "@/components/wizard/tag-field";
import { ConversationPicker } from "@/components/wizard/conversation-picker";
import { FormCard, FormCardSections } from "@/components/wizard/form-layout";
import { GenerationNotice } from "./generation-notice";
import { OUTCOME_SUGGESTIONS } from "./starters";
import { INPUT_LANGUAGES, voiceLabel } from "@/lib/agents/voices";
import {
  MAX_OUTCOME_LENGTH,
  MAX_OUTCOMES,
  MAX_STYLE_LENGTH,
  MAX_STYLE_TRAITS,
} from "@/lib/agents/wizard";
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

export function OutcomesStep({
  api,
  idPrefix,
  tagRef,
  error,
  onClearError,
}: StepBodyProps & { tagRef?: React.Ref<TagFieldHandle>; error?: string | null; onClearError?: () => void }) {
  return (
    <FormCard>
      <FormCardSections>
        <StepHeading
          title="What should your agent accomplish?"
          description="Add one clear outcome per tag. Choose a suggestion or write your own."
        />
        <div className={flashClass(api.flashed, "outcomes")}>
          <TagField
            ref={tagRef}
            id={`${idPrefix}-outcomes`}
            label="Outcomes"
            values={api.draft.outcomes}
            onChange={(outcomes) => {
              onClearError?.();
              api.edit({ outcomes }, "outcomes change");
            }}
            suggestions={OUTCOME_SUGGESTIONS.map((value) => ({ value }))}
            maxCount={MAX_OUTCOMES}
            maxLength={MAX_OUTCOME_LENGTH}
            placeholder="e.g. Qualify property leads and book viewings"
            error={error}
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
            placeholder="e.g. Warm but to the point"
            blockOnInvalidPending={false}
          />
        </div>
        <div className={flashClass(api.flashed, "voice") || flashClass(api.flashed, "conversationLanguage")}>
          <ConversationPicker
            language={api.draft.conversationLanguage}
            voiceId={api.draft.voiceId}
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

export type ReviewPhase = "idle" | "working" | "backgrounded";

export function ReviewStep({
  api,
  phase,
  canGenerate,
  onOpenJobs,
  error,
  onUseTemplate,
  flashed,
  onJump,
}: {
  api: WizardDraftApi;
  phase: ReviewPhase;
  /** False until at least one outcome exists — empty briefs never queue. */
  canGenerate: boolean;
  onOpenJobs: () => void;
  error: string | null;
  /** Real-estate template escape hatch when generation fails. */
  onUseTemplate?: () => void;
  /** Field the voice copilot just touched — highlights the matching row. */
  flashed: FlashKey;
  onJump: (step: number) => void;
}) {
  const { draft } = api;
  const languageLabel =
    INPUT_LANGUAGES.find((l) => l.code === draft.conversationLanguage)?.label ??
    draft.conversationLanguage;
  const outcomesFlashed = flashed === "outcomes";
  const personaFlashed =
    flashed === "agentName" ||
    flashed === "styleTraits" ||
    flashed === "voice" ||
    flashed === "conversationLanguage";
  return (
    <FormCard>
      <FormCardSections>
        <StepHeading
          title="Ready to generate?"
          description="Review the summary — nothing saves until you say so."
        />
        <dl className="flex flex-col gap-1 text-sm">
          <div
            className={`flex items-start gap-2 rounded-md px-2 py-1.5 ${outcomesFlashed ? "field-flash" : ""}`}
          >
            <dt className="text-muted-foreground w-24 shrink-0 pt-1">Outcomes</dt>
            <dd className="min-w-0 flex-1 break-words">
              {draft.outcomes.length ? (
                <ul className="flex flex-col gap-1">
                  {draft.outcomes.map((outcome) => (
                    <li key={outcome}>{outcome}</li>
                  ))}
                </ul>
              ) : (
                "—"
              )}
            </dd>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0 cursor-pointer"
              onClick={() => onJump(0)}
              aria-label="Edit outcomes"
            >
              Edit
            </Button>
          </div>
          <div
            className={`flex items-start gap-2 rounded-md px-2 py-1.5 ${personaFlashed ? "field-flash" : ""}`}
          >
            <dt className="text-muted-foreground w-24 shrink-0 pt-1">Persona</dt>
            <dd className="min-w-0 flex-1 break-words">
              {[draft.agentName, draft.styleTraits.join(", ")]
                .filter(Boolean)
                .join(" · ") || "—"}
              {" · "}
              {languageLabel} · {voiceLabel(draft.voiceId)}
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
        </dl>
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-muted-foreground text-xs">
            {canGenerate
              ? "Generate in the footer below when ready."
              : "Add at least one outcome first."}
          </p>
        </div>
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
      </FormCardSections>
    </FormCard>
  );
}

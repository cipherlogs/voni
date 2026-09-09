"use client";

import { useRef, useState } from "react";
import { Pencil, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  applyTagAdd,
  applyTagRemove,
  applyTagUpdate,
  isTagAdded,
} from "./tag-helpers";

export type TagSuggestion = {
  /** Canonical value appended on tap. */
  value: string;
  /** Short label shown on the chip. Defaults to value. */
  label?: string;
};

export type TagFieldProps = {
  id: string;
  label: string;
  description?: string;
  values: string[];
  onChange: (next: string[]) => void;
  /** Tap-to-add chips rendered below the field. Never replace existing tags. */
  suggestions?: TagSuggestion[];
  suggestionsLabel?: string;
  maxCount: number;
  maxLength: number;
  placeholder?: string;
  addLabel?: string;
  addedLabel?: string;
  /** Server or step-level error shown under the field. */
  error?: string | null;
};

/**
 * Reusable tag field (Outcomes, Conversational style). Plain input + visible
 * Add button (shadcn Input Group composition), wrapping tag badges with
 * accessible Edit/Remove, suggestion chips below. Normal input controls only:
 * no rich-text editing, no serialized tag blobs, no comma splitting,
 * no Backspace deletion.
 */
export function TagField({
  id,
  label,
  description,
  values,
  onChange,
  suggestions = [],
  suggestionsLabel = "Suggestions",
  maxCount,
  maxLength,
  placeholder,
  addLabel = "Add",
  addedLabel = "Added",
  error,
}: TagFieldProps) {
  const [input, setInput] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editing = editingIndex !== null;
  const atCap = !editing && values.length >= maxCount;
  const message = error ?? localError;
  const hintId = `${id}-hint`;
  const countId = `${id}-count`;

  const commit = () => {
    const result =
      editing && editingIndex !== null
        ? applyTagUpdate(values, editingIndex, input, maxLength)
        : applyTagAdd(values, input, maxCount, maxLength);
    if (!result.ok) {
      setLocalError(result.message);
      return;
    }
    setInput("");
    setLocalError(null);
    setEditingIndex(null);
    onChange(result.values);
  };

  const cancelEditing = () => {
    setEditingIndex(null);
    setInput("");
    setLocalError(null);
  };

  const startEditing = (index: number) => {
    setEditingIndex(index);
    setInput(values[index]);
    setLocalError(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {values.length > 0 ? (
        <ul aria-label={`${label}: added`} className="flex flex-wrap gap-2">
          {values.map((tag, i) => (
            <li key={`${tag}-${i}`} className="min-w-0">
              <Badge
                variant="secondary"
                className="h-auto min-h-11 gap-1 py-1 pr-1 pl-2.5 whitespace-normal"
              >
                <span className="min-w-0 text-xs font-medium break-words">{tag}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-touch"
                  className="rounded-full"
                  onClick={() => startEditing(i)}
                  aria-label={`Edit ${tag}`}
                >
                  <Pencil className="size-3.5" aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-touch"
                  className="rounded-full"
                  onClick={() => onChange(applyTagRemove(values, i))}
                  aria-label={`Remove ${tag}`}
                >
                  <X className="size-3.5" aria-hidden />
                </Button>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      <InputGroup className="min-h-11">
        <InputGroupInput
          ref={inputRef}
          id={id}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              commit();
            }
            // Backspace in an empty input intentionally deletes nothing.
          }}
          placeholder={placeholder}
          maxLength={maxLength + 20}
          aria-describedby={`${hintId} ${countId}`}
          aria-invalid={message ? true : undefined}
        />
        <InputGroupAddon align="inline-end">
          {editing ? (
            <>
              <Button type="button" variant="ghost" size="sm" onClick={cancelEditing}>
                Cancel
              </Button>
              <Button type="button" size="touch" onClick={commit}>
                Update
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="touch"
              onClick={commit}
              disabled={atCap || input.trim().length === 0}
            >
              <Plus aria-hidden />
              {addLabel}
            </Button>
          )}
        </InputGroupAddon>
      </InputGroup>
      <div className="flex items-center justify-between gap-2">
        <p id={hintId} aria-live="polite" className="text-muted-foreground text-xs">
          {message ??
            (atCap
              ? `Limit reached (${maxCount}/${maxCount}). Remove one to add another.`
              : editing
                ? "Editing keeps its position. Update or Cancel."
                : "One clear outcome per tag.")}
        </p>
        <span id={countId} className="text-muted-foreground shrink-0 text-xs">
          {values.length}/{maxCount}
        </span>
      </div>
      {message ? <FieldError>{message}</FieldError> : null}
      {suggestions.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-muted-foreground text-xs" id={`${id}-suggestions`}>
            {suggestionsLabel}
          </span>
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-labelledby={`${id}-suggestions`}
          >
            {suggestions.map((s) => {
              const added = isTagAdded(values, s.value);
              return (
                <Button
                  key={s.value}
                  type="button"
                  size="touch"
                  variant={added ? "secondary" : "outline"}
                  className="whitespace-normal"
                  disabled={added || atCap}
                  onClick={() => {
                    const result = applyTagAdd(values, s.value, maxCount, maxLength);
                    if (!result.ok) {
                      setLocalError(result.message);
                      return;
                    }
                    setLocalError(null);
                    onChange(result.values);
                  }}
                  aria-pressed={added}
                  aria-label={added ? `${s.label ?? s.value} (${addedLabel})` : (s.label ?? s.value)}
                >
                  {s.label ?? s.value}
                  {added ? (
                    <Badge variant="default" className="gap-1">
                      {addedLabel}
                    </Badge>
                  ) : null}
                </Button>
              );
            })}
          </div>
        </div>
      ) : null}
    </Field>
  );
}

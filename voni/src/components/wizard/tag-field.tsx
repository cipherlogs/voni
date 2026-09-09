"use client";

import { useImperativeHandle, useRef, useState } from "react";
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
import { cn } from "@/lib/utils";
import {
  applyTagAdd,
  applyTagRemove,
  applyTagUpdate,
  isTagAdded,
} from "./tag-helpers";

export type TagSuggestion = {
  /** Canonical value moved up on tap. */
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
  /** Tap-to-move chips rendered below the field. Added ones leave the row. */
  suggestions?: TagSuggestion[];
  suggestionsLabel?: string;
  maxCount: number;
  maxLength: number;
  placeholder?: string;
  addedHint?: string;
  /** Server or step-level error shown under the field. */
  error?: string | null;
  /**
   * Imperative handle for step navigation: commits pending text before
   * Continue. When false, invalid pending text stays editable without
   * blocking (for optional fields).
   */
  blockOnInvalidPending?: boolean;
  ref?: React.Ref<TagFieldHandle>;
};

export type TagFieldHandle = {
  /** Commits pending text. Returns false when invalid text must block. */
  commitPending: () => boolean;
};

/**
 * Reusable tag field (Goals, Tasks, Conversational style). The composer is an
 * empty pill you type straight into — Enter commits it into a solid tag and a
 * fresh empty pill appears. Tapping a tag edits it inline (Enter commits, Esc
 * cancels, Remove shows only while editing). Suggestions move up on tap and
 * move back down on remove. Plain input controls throughout.
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
  addedHint,
  error,
  blockOnInvalidPending = true,
  ref,
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
  const available = suggestions.filter((s) => !isTagAdded(values, s.value));

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

  useImperativeHandle(
    ref,
    () => ({
      commitPending: () => {
        if (input.trim().length === 0 && !editing) return true;
        const result =
          editing && editingIndex !== null
            ? applyTagUpdate(values, editingIndex, input, maxLength)
            : applyTagAdd(values, input, maxCount, maxLength);
        if (!result.ok) {
          setLocalError(result.message);
          return !blockOnInvalidPending;
        }
        setInput("");
        setLocalError(null);
        setEditingIndex(null);
        onChange(result.values);
        return true;
      },
    }),
    [input, editing, editingIndex, values, maxCount, maxLength, blockOnInvalidPending, onChange],
  );

  const startEditing = (index: number) => {
    setEditingIndex(index);
    setInput(values[index]);
    setLocalError(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  };

  return (
    <Field data-invalid={message ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {values.length > 0 ? (
        <ul aria-label={`${label}: added`} className="flex flex-wrap gap-2">
          {values.map((tag, i) => (
            <li key={`${tag}-${i}`} className="min-w-0">
              <Badge
                variant="secondary"
                render={
                  <button
                    type="button"
                    onClick={() => startEditing(i)}
                    aria-label={`Edit ${tag}`}
                  />
                }
                className={cn(
                  "h-auto min-h-8 py-1 pr-2.5 pl-2.5 text-xs font-medium whitespace-normal pointer-coarse:min-h-11",
                  editingIndex === i && "border-primary",
                )}
              >
                <span className="min-w-0 break-words">{tag}</span>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      <InputGroup className="rounded-full">
        <InputGroupInput
          ref={inputRef}
          id={id}
          value={input}
          disabled={atCap}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              if (editing) cancelEditing();
              else setInput("");
            }
            // Backspace in an empty input intentionally deletes nothing.
          }}
          placeholder={placeholder}
          maxLength={maxLength + 20}
          aria-describedby={`${hintId} ${countId}`}
          aria-invalid={message ? true : undefined}
        />
        {editing ? (
          <InputGroupAddon align="inline-end">
            <Button type="button" variant="ghost" size="sm" onClick={cancelEditing}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                onChange(applyTagRemove(values, editingIndex as number));
                cancelEditing();
              }}
            >
              Remove
            </Button>
            <Button type="button" size="sm" onClick={commit}>
              Update
            </Button>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
      <div className="flex items-center justify-between gap-2">
        <p id={hintId} aria-live="polite" className="text-muted-foreground text-xs">
          {message ??
            (atCap
              ? `Limit reached (${maxCount}/${maxCount}). Remove one to add another.`
              : (addedHint ?? "Type and press Enter."))}
        </p>
        <span id={countId} className="text-muted-foreground shrink-0 text-xs">
          {values.length}/{maxCount}
        </span>
      </div>
      {message ? <FieldError>{message}</FieldError> : null}
      {available.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-muted-foreground text-xs" id={`${id}-suggestions`}>
            {suggestionsLabel}
          </span>
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-labelledby={`${id}-suggestions`}
          >
            {available.map((s) => (
              <Button
                key={s.value}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  const result = applyTagAdd(values, s.value, maxCount, maxLength);
                  if (!result.ok) {
                    setLocalError(result.message);
                    return;
                  }
                  setLocalError(null);
                  onChange(result.values);
                }}
                aria-label={s.label ?? s.value}
              >
                {s.label ?? s.value}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </Field>
  );
}

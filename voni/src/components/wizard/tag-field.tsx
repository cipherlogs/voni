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
import { X } from "lucide-react";
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
 * Token-box tag field. Selected pills live inside the box with an inline
 * composer at the end: Enter, Tab, or leaving commits; Esc cancels an edit.
 * Tapping pill text edits it inline; each pill has an × that only removes.
 * Suggestions move up on tap and back down on remove. How-to hints are
 * screen-reader-only; sighted users get the count, errors, and chips.
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

  const tryCommit = (opts?: { silent?: boolean }): boolean => {
    if (input.trim().length === 0 && !editing) return true;
    const result =
      editing && editingIndex !== null
        ? applyTagUpdate(values, editingIndex, input, maxLength)
        : applyTagAdd(values, input, maxCount, maxLength);
    if (!result.ok) {
      if (!opts?.silent) setLocalError(result.message);
      return !blockOnInvalidPending;
    }
    setInput("");
    setLocalError(null);
    setEditingIndex(null);
    onChange(result.values);
    return true;
  };

  const commit = () => {
    tryCommit();
  };

  const cancelEditing = () => {
    setEditingIndex(null);
    setInput("");
    setLocalError(null);
  };

  useImperativeHandle(
    ref,
    () => ({
      commitPending: () => tryCommit(),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // mousedown preventDefault keeps focus in the composer so blur-commit
  // doesn't fire (and reorder) before chip/remove/edit actions run.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  return (
    <Field data-invalid={message ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <div
        className={cn(
          "border-input flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border bg-transparent px-2 py-1.5 transition-colors outline-none focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
          atCap && "opacity-70",
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {values.map((tag, i) => (
          <Badge
            key={`${tag}-${i}`}
            variant="secondary"
            render={<span role="group" aria-label={tag} />}
            className={cn(
              "h-6 gap-0 py-0 pr-0.5 pl-2 text-xs font-medium",
              editingIndex === i && "border-primary",
            )}
          >
            <button
              type="button"
              onMouseDown={keepFocus}
              onClick={() => startEditing(i)}
              aria-label={`Edit ${tag}`}
              className="min-w-0 cursor-pointer break-words"
            >
              <span className="block max-w-48 truncate">{tag}</span>
            </button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onMouseDown={keepFocus}
              onClick={() => {
                if (editingIndex === i) cancelEditing();
                onChange(applyTagRemove(values, i));
              }}
              aria-label={`Remove ${tag}`}
              className="rounded-full"
            >
              <X data-icon="inline" aria-hidden />
            </Button>
          </Badge>
        ))}
        <input
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
          onBlur={() => {
            tryCommit({ silent: true });
          }}
          placeholder={values.length === 0 && !editing ? placeholder : undefined}
          maxLength={maxLength + 20}
          aria-describedby={`${hintId} ${countId}`}
          aria-invalid={message ? true : undefined}
          autoComplete="off"
          className="placeholder:text-muted-foreground min-w-24 flex-1 bg-transparent text-sm outline-none disabled:cursor-not-allowed"
        />
      </div>
      <p id={hintId} aria-live="polite" className="sr-only">
        {message ??
          (atCap
            ? `Limit reached (${maxCount}/${maxCount}). Remove one to add another.`
            : "Type and press Enter. Tap a tag to edit it.")}
      </p>
      <div className="flex items-center justify-between gap-2">
        <span id={countId} className="text-muted-foreground text-xs">
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
                onMouseDown={keepFocus}
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

import { normalizeTag } from "@/lib/agents/wizard";

/**
 * Pure tag-list operations behind TagField. Tested directly — the component
 * itself is a thin controlled wrapper, so these carry the behavior contract:
 * normalize, reject empties/duplicates/overlong/over-cap, never split on
 * commas, and preserve position on edit.
 */

export type TagRejection = "empty" | "duplicate" | "too-long" | "capped";

export type TagApplyResult =
  | { ok: true; values: string[] }
  | { ok: false; reason: TagRejection; message: string };

export function isTagAdded(values: string[], candidate: string): boolean {
  const key = normalizeTag(candidate).toLowerCase();
  if (!key) return false;
  return values.some((v) => v.toLowerCase() === key);
}

export function applyTagAdd(
  values: string[],
  raw: string,
  maxCount: number,
  maxLength: number,
): TagApplyResult {
  const value = normalizeTag(raw);
  if (!value) {
    return { ok: false, reason: "empty", message: "Type something first." };
  }
  if (value.length > maxLength) {
    return {
      ok: false,
      reason: "too-long",
      message: `Keep tags under ${maxLength} characters.`,
    };
  }
  if (values.some((v) => v.toLowerCase() === value.toLowerCase())) {
    return { ok: false, reason: "duplicate", message: "That is already added." };
  }
  if (values.length >= maxCount) {
    return {
      ok: false,
      reason: "capped",
      message: `Limit reached (${maxCount}/${maxCount}). Remove one to add another.`,
    };
  }
  return { ok: true, values: [...values, value] };
}

/**
 * Replace the tag at `index`, keeping its position. The tag being edited
 * never counts as its own duplicate, so saving unchanged always succeeds.
 */
export function applyTagUpdate(
  values: string[],
  index: number,
  raw: string,
  maxLength: number,
): TagApplyResult {
  const value = normalizeTag(raw);
  if (!value) {
    return { ok: false, reason: "empty", message: "Type something first." };
  }
  if (value.length > maxLength) {
    return {
      ok: false,
      reason: "too-long",
      message: `Keep tags under ${maxLength} characters.`,
    };
  }
  if (
    values.some((v, i) => i !== index && v.toLowerCase() === value.toLowerCase())
  ) {
    return { ok: false, reason: "duplicate", message: "That is already added." };
  }
  const next = [...values];
  next[index] = value;
  return { ok: true, values: next };
}

export function applyTagRemove(values: string[], index: number): string[] {
  return values.filter((_, i) => i !== index);
}

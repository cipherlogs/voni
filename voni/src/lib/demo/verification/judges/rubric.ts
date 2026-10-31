/**
 * The rubric a judge scores against, and its identity.
 *
 * A rubric hash is recorded with every calibration. A changed rubric — a new
 * axis, a reworded question, new anchors — moves the hash and invalidates the
 * prior calibration; it is never silently reused.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Judging".
 */

import { createHash } from "node:crypto";

import { JudgeError } from "./errors";
import type { Rubric, RubricAxis } from "./types";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Refuse a rubric with no id, no axes, a blank question or a duplicate axis. */
export function validateRubric(rubric: Rubric): void {
  if (text(rubric?.id) === "") {
    throw new JudgeError("invalid-rubric", "a rubric must name its id");
  }
  if (!Array.isArray(rubric.axes) || rubric.axes.length === 0) {
    throw new JudgeError("invalid-rubric", `rubric "${rubric.id}" declares no axes`);
  }
  const seen = new Set<string>();
  for (const axis of rubric.axes) {
    const id = text(axis?.id);
    if (id === "") {
      throw new JudgeError("invalid-rubric", `rubric "${rubric.id}" has an axis with no id`);
    }
    if (seen.has(id)) {
      throw new JudgeError(
        "invalid-rubric",
        `rubric "${rubric.id}" declares axis "${id}" twice; one axis has one id`,
      );
    }
    seen.add(id);
    if (text(axis.question) === "") {
      throw new JudgeError(
        "invalid-rubric",
        `rubric "${rubric.id}" axis "${id}" has no question`,
      );
    }
    if (axis.anchors !== undefined && !Array.isArray(axis.anchors)) {
      throw new JudgeError(
        "invalid-rubric",
        `rubric "${rubric.id}" axis "${id}" has anchors that are not a list`,
      );
    }
  }
}

function canonicalAxis(axis: RubricAxis): Record<string, unknown> {
  return {
    id: axis.id,
    question: axis.question,
    anchors: axis.anchors === undefined ? [] : [...axis.anchors],
  };
}

/**
 * The rubric's stable identity. Axis order is part of the rubric: the hash is
 * an integrity check, not a normalization.
 */
export function rubricHash(rubric: Rubric): string {
  validateRubric(rubric);
  const canonical = JSON.stringify({
    id: rubric.id,
    axes: rubric.axes.map(canonicalAxis),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

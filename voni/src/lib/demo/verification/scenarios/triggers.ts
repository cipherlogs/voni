/**
 * Trigger evaluation: the caller's script turned into call times.
 *
 * The evaluator is a pure function of the script and the agent timeline. No
 * clock, no jitter, no adapter event: the same timeline always yields the same
 * points, so two runs of one scenario are comparable.
 *
 * A script step whose event never arrived is reported as unresolved and the
 * caller fails the run by name. It is never defaulted to "speak immediately":
 * that would turn a missing turn into a measured pass.
 */

import { ScenarioError } from "./errors";
import {
  AGENT_EVENT_TYPES,
  type AgentEventType,
  type AgentTimelineEvent,
  type ScriptStep,
  type TriggerPlan,
  type TriggerPoint,
  type TriggerRule,
  type UnresolvedTrigger,
} from "./types";

function validateTimeline(timeline: readonly AgentTimelineEvent[]): AgentTimelineEvent[] {
  const events = timeline.map((event, index) => {
    const atMs = event?.atMs;
    if (typeof atMs !== "number" || !Number.isFinite(atMs) || atMs < 0) {
      throw new ScenarioError(
        "invalid-timeline",
        `agent timeline event ${index} has invalid atMs ${String(atMs)}; call time is a finite number of milliseconds`,
      );
    }
    const type = event?.type;
    if (typeof type !== "string" || !(AGENT_EVENT_TYPES as readonly string[]).includes(type)) {
      throw new ScenarioError(
        "invalid-timeline",
        `agent timeline event ${index} names unknown type "${String(type)}"; known types: ${AGENT_EVENT_TYPES.join(", ")}`,
      );
    }
    return { atMs, type: type as AgentEventType };
  });
  // Stable sort: equal times keep the adapter's order, so identical input is
  // identical output and a shuffled timeline is not a second plan.
  return events.sort((left, right) => left.atMs - right.atMs);
}

function delayed(atMs: number, delayMs: number | undefined): number {
  return atMs + (delayMs ?? 0);
}

/**
 * Resolve every script step against the timeline. Steps consume events in
 * script order, so the second `agent-turn-end` step answers the agent's second
 * turn, never its first again.
 */
export function evaluateTriggers(
  script: readonly ScriptStep[],
  timeline: readonly AgentTimelineEvent[],
): TriggerPlan {
  const events = validateTimeline(timeline);
  const points: TriggerPoint[] = [];
  const unresolved: UnresolvedTrigger[] = [];
  let cursor = -1;

  const findAfter = (type: AgentEventType): { index: number; event: AgentTimelineEvent } | null => {
    for (let index = cursor + 1; index < events.length; index += 1) {
      if (events[index].type === type) return { index, event: events[index] };
    }
    return null;
  };

  const callOpen = events.find((event) => event.type === "call-open");
  const afterCallOpen = (): number => {
    if (!callOpen) {
      throw new ScenarioError(
        "invalid-timeline",
        "agent timeline has no call-open event; no trigger can be placed on a call that never opened",
      );
    }
    return callOpen.atMs;
  };

  for (const [step, entry] of script.entries()) {
    const rule = entry.trigger;
    switch (rule.type) {
      case "call-open": {
        const found = findAfter("call-open");
        if (!found) {
          unresolved.push(unresolvedStep(step, entry, rule, "no call-open event"));
          break;
        }
        cursor = found.index;
        points.push(point(step, entry, rule, delayed(found.event.atMs, rule.delayMs)));
        break;
      }
      case "agent-speech-start":
      case "agent-turn-end": {
        const found = findAfter(rule.type);
        if (!found) {
          unresolved.push(unresolvedStep(step, entry, rule, `no ${rule.type} event`));
          break;
        }
        cursor = found.index;
        points.push(point(step, entry, rule, delayed(found.event.atMs, rule.delayMs)));
        break;
      }
      case "silence": {
        const found = findAfter("agent-speech-end");
        if (!found) {
          unresolved.push(unresolvedStep(step, entry, rule, "no agent-speech-end event to measure silence from"));
          break;
        }
        cursor = found.index;
        points.push(point(step, entry, rule, delayed(found.event.atMs + rule.silenceMs, rule.delayMs)));
        break;
      }
      case "at-offset": {
        points.push(point(step, entry, rule, afterCallOpen() + rule.atMs));
        break;
      }
      default: {
        const exhaustive: never = rule;
        throw new ScenarioError(
          "unknown-trigger",
          `script step ${step} names unknown trigger type "${String((exhaustive as TriggerRule).type)}"`,
        );
      }
    }
  }

  points.sort((left, right) => left.atMs - right.atMs || left.step - right.step);
  return { points, unresolved };
}

function point(
  step: number,
  entry: ScriptStep,
  rule: TriggerRule,
  atMs: number,
): TriggerPoint {
  return { step, take: entry.take, trigger: rule.type, atMs };
}

function unresolvedStep(
  step: number,
  entry: ScriptStep,
  rule: TriggerRule,
  reason: string,
): UnresolvedTrigger {
  return {
    step,
    take: entry.take,
    trigger: rule.type,
    reason: `${reason} before the call ended`,
  };
}

/**
 * A plan with any unresolved step is a refusal: the caller, adapter number and
 * take are named so the defect card can cite the one that never fired.
 */
export function assertTriggersResolved(plan: TriggerPlan): void {
  if (plan.unresolved.length === 0) return;
  const named = plan.unresolved
    .map((entry) => `step ${entry.step} take "${entry.take}" (${entry.trigger}): ${entry.reason}`)
    .join("; ");
  throw new ScenarioError(
    "invalid-trigger",
    `the caller script did not resolve: ${named}. A trigger that never fires is not a skip.`,
  );
}

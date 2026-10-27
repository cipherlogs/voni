/**
 * Light Copilot context: types, context object, and reader hooks.
 *
 * Ticket 05 splits the heavy Copilot engine (`copilot-provider`: AssemblyAI
 * session, judges, prompt builders, tool graphs) behind `next/dynamic`, so
 * every dashboard route was still pulling the engine into first paint
 * through this context. This module carries only the context shape — no
 * session, no bus, no store construction — so the sidebar voice row, route
 * briefs, the wizard page, and the shell read it without paying engine
 * cost. The provider implements this same context; reader behavior
 * (including the missing-provider error) is unchanged.
 */

"use client";

import { createContext, useContext, useEffect } from "react";
import type { BusContext, RegisteredTool } from "@/lib/copilot/bus";
import type { Proposal } from "@/lib/copilot/proposals";
import type { VoiceError } from "@/lib/voice/session";

export type CopilotStatus =
  | "idle"
  | "starting"
  | "live"
  | "reconnecting"
  | "error";

export type CaptionTurn = {
  id: string;
  role: "user" | "agent";
  text: string;
};

export type RouteToolConfig = {
  tools: RegisteredTool[];
  targets: Map<string, () => { value: unknown; version: number | string } | null>;
  brief: string;
  /**
   * Live dialog state the route owns (wizard step, draft gate). Merged into
   * the system prompt on every push — routes that have none omit it.
   */
  dialogState?: {
    wizardStep?: string;
    draftGateOpen?: boolean;
  };
};

export type ProposeChangeInput = {
  target: { kind: string; id: string };
  payload: unknown;
  executor: string;
  summary: string;
  keyPhrases: string[];
  inverse?: { summary: string; payload: unknown } | null;
};

export type CopilotContextValue = {
  status: CopilotStatus;
  error: VoiceError | null;
  /** True while the user muted their own mic — the call stays up, frames drop. */
  micMuted: boolean;
  /** True while the copilot's voice output is silenced (volume 0). */
  speakerMuted: boolean;
  live: boolean;
  captions: CaptionTurn[];
  userPartial: string | null;
  agentPartial: string | null;
  proposals: Proposal[];
  toolActive: boolean;
  sessionSeconds: number | null;
  /** AssemblyAI session id for support (docs: persist it, don't guess). */
  sessionId: string | null;
  start: () => void;
  stop: () => void;
  toggleMicMute: () => void;
  toggleSpeakerMute: () => void;
  applyTap: (id: string) => void;
  dismissTap: (id: string) => void;
  noteInteraction: () => void;
  registerRoute: (route: string, config: RouteToolConfig) => void;
  unregisterRoute: (route: string) => void;
  /** Tool-run helper: create a proposal from a registered propose tool. */
  proposeChange: (
    input: ProposeChangeInput,
    ctx: BusContext,
  ) => { proposal_id: string; summary: string };
  /** Tool-run helper: propose undoing the most recent applied change here. */
  proposeUndo: (ctx: BusContext) => {
    ok: boolean;
    proposal_id?: string;
    summary?: string;
    error?: string;
  };
};

export const CopilotContext = createContext<CopilotContextValue | null>(null);

export function useCopilot(): CopilotContextValue {
  const value = useContext(CopilotContext);
  if (!value) throw new Error("useCopilot must be used inside CopilotProvider.");
  return value;
}

/**
 * On-demand engine upgrade slot (shell review fix).
 *
 * The dashboard shell renders children immediately under idle defaults
 * (createIdleCopilotValue, below) while the heavy engine chunk loads. The
 * engine boot probe publishes the live value here once loaded, and the
 * shell swaps idle → live on the SAME provider boundary — re-render, never
 * remount — so sidebar and page state survive the upgrade. Module state, so
 * both the light shell and the heavy boot share one slot without the shell
 * importing the engine.
 */
let engineValue: CopilotContextValue | null = null;
const engineListeners = new Set<() => void>();

export function getEngineValue(): CopilotContextValue | null {
  return engineValue;
}

export function subscribeEngineValue(fn: () => void): () => void {
  engineListeners.add(fn);
  return () => {
    engineListeners.delete(fn);
  };
}

export function publishEngineValue(next: CopilotContextValue | null): void {
  if (engineValue === next) return;
  engineValue = next;
  engineListeners.forEach((fn) => fn());
}

/**
 * Idle first-paint defaults for the light context. Same shape as the live
 * engine value, inert until the upgrade lands: presses and registrations
 * only warm the engine chunk (onNeedEngine) instead of touching mic,
 * session, or store state. Post-upgrade the live value replaces this
 * object wholesale, so behavior after load is the engine's own.
 */
export function createIdleCopilotValue(onNeedEngine?: () => void): CopilotContextValue {
  const noop = () => {};
  const warm = () => {
    onNeedEngine?.();
  };
  return {
    status: "idle",
    error: null,
    micMuted: false,
    speakerMuted: false,
    live: false,
    captions: [],
    userPartial: null,
    agentPartial: null,
    proposals: [],
    toolActive: false,
    sessionSeconds: null,
    sessionId: null,
    start: warm,
    stop: noop,
    toggleMicMute: noop,
    toggleSpeakerMute: noop,
    applyTap: noop,
    dismissTap: noop,
    noteInteraction: noop,
    registerRoute: warm,
    unregisterRoute: noop,
    proposeChange: () => ({ proposal_id: "", summary: "" }),
    proposeUndo: () => ({ ok: false, error: "Voice copilot is still loading." }),
  };
}

/**
 * Page hook: publish this route's tools, target readers, and screen brief.
 * Tools merge into the session on register and on every navigation.
 */
export function useCopilotRoute(route: string, config: RouteToolConfig) {
  const { registerRoute, unregisterRoute } = useCopilot();
  useEffect(() => {
    // Pages should memoize `config` (e.g. keyed by a brief string) so this
    // only re-registers when something actually changed.
    registerRoute(route, config);
    return () => unregisterRoute(route);
  }, [route, config, registerRoute, unregisterRoute]);
}

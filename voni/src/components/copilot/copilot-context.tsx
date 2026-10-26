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

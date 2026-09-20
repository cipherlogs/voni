import { inputLanguage, voiceLabel } from "./agents/voices";
import type { CopilotVoicePrefs } from "./copilot/voice-prefs";
import type { TileValue } from "./settings-tiles";

/**
 * Live tile badges (ticket 04): truthful per-tile status derived from data
 * the landing already fetches in one batched round — never mock text, never
 * a per-tile fetch avalanche.
 *
 * Pure module (no "use client", no DB): the landing page fetches, this module
 * derives. Appearance is deliberately absent — the theme lives in
 * client-side storage (`next-themes`), so the server must not invent it; the
 * `AppearanceTile` client island owns that badge.
 */
export interface SettingsTileBadge {
  readonly text: string;
  readonly variant: "secondary" | "outline";
}

export interface SettingsBadgeData {
  readonly role: string;
  readonly voice: CopilotVoicePrefs;
  readonly connectedProviders: number;
  readonly servicesReady: number;
  readonly servicesTotal: number;
  readonly phoneTotal: number;
  readonly phoneUnassigned: number;
}

export type SettingsTileBadges = Record<TileValue, SettingsTileBadge | undefined>;

function voiceBadge(voice: CopilotVoicePrefs): SettingsTileBadge {
  const language = voice.language === "auto"
    ? "Auto"
    : (inputLanguage(voice.language)?.label ?? voice.language);
  return { text: `${voiceLabel(voice.voiceId)} · ${language}`, variant: "secondary" };
}

function numbersBadge(total: number, unassigned: number): SettingsTileBadge {
  if (total === 0) return { text: "No numbers", variant: "outline" };
  const unit = total === 1 ? "1 number" : `${total} numbers`;
  if (unassigned === 0) return { text: unit, variant: "secondary" };
  return { text: `${unit} · ${unassigned} unassigned`, variant: "outline" };
}

export function settingsTileBadges(data: SettingsBadgeData): SettingsTileBadges {
  return {
    // Google-only sign-in (auth.ts) — the account section shows the Google
    // profile, so the tile names the provider. No fetch needed.
    account: { text: "Google", variant: "secondary" },
    voice: voiceBadge(data.voice),
    // Owner-gating visible before edits (user story 5): non-owners read the
    // workspace form disabled, so the badge says so up front.
    workspace: data.role === "owner"
      ? { text: "Owner", variant: "secondary" }
      : { text: "Read-only", variant: "outline" },
    services: {
      text: `${data.connectedProviders} connected · ${data.servicesReady}/${data.servicesTotal} ready`,
      variant: data.servicesReady === data.servicesTotal ? "secondary" : "outline",
    },
    // Appearance owns its badge client-side (live theme) — never a server
    // mock here. The landing renders AppearanceTile instead of BentoTile.
    appearance: undefined,
    numbers: numbersBadge(data.phoneTotal, data.phoneUnassigned),
    // Visible only to platform admins (landing filters `adminOnly`) — the
    // badge names the gate rather than duplicating platform health.
    operator: { text: "Admin", variant: "secondary" },
  };
}

export interface ServiceReadinessInput {
  readonly assemblyaiConfigured: boolean;
  readonly telnyxConfigured: boolean;
  readonly telnyxConnectionId: string | null;
  readonly telnyxCallerNumber: string | null;
  readonly llmConfigured: boolean;
  readonly cartesiaConfigured: boolean;
  readonly cartesiaVoiceId: string | null;
}

export interface ServiceReadiness {
  readonly id: string;
  readonly label: string;
  readonly configured: boolean;
}

/**
 * Single source for the four platform readiness rows: the services section
 * and the landing badge count derive from this, so heading and badge can
 * never disagree on what "ready" means.
 */
export function buildServiceReadiness(input: ServiceReadinessInput): ServiceReadiness[] {
  return [
    { id: "voice", label: "Voice agents", configured: input.assemblyaiConfigured },
    {
      id: "phone",
      label: "Phone calls",
      configured:
        input.telnyxConfigured &&
        Boolean(input.telnyxConnectionId && input.telnyxCallerNumber),
    },
    { id: "llm", label: "AI generation", configured: input.llmConfigured },
    {
      id: "voice-note",
      label: "Voice notes",
      configured: input.cartesiaConfigured && Boolean(input.cartesiaVoiceId),
    },
  ];
}

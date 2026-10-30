/**
 * The harness subject (voice-parity ticket 72, spec W5; cascade axis ticket 131).
 *
 * A **subject** is what a measurement is about: `{agent, Locale, transport,
 * pipeline}`. The featured voice is one subject, not the owner of the axis — a
 * run can name a different demo voice, a tenant agent, or the phone transport,
 * and the artifact it writes carries that subject so no later reader has to
 * infer it from a filename. The `pipeline` axis is what keeps a managed run and
 * a cascade run of the same voice apart in the A/B.
 *
 * Doctrine this module enforces:
 * - **Voice binding.** A voice speaks exactly one Locale. A subject that pairs
 *   a voice with another Locale is refused by name, never measured as if the
 *   voice could speak it.
 * - **No voice without a binding.** A voice the catalogue offers but the vendor
 *   does not serve is not a cascade subject. Its Locale stays *open* — not
 *   beta, not dropped, not cut over — and the refusal names the voice, the
 *   Locale and the reason. The pre-re-cast German id (`juergen`) is a
 *   *historical* unbound row: it is no longer offered, but naming it still
 *   refuses by name with the vendor's 422 rather than falling through.
 * - **No silent default.** A tenant agent has no voice binding to derive its
 *   Locale from, so a tenant subject without a Locale fails by name instead of
 *   borrowing English (or the featured voice's).
 * - **Plain data.** A subject is strings and booleans only, so a gate, an
 *   artifact and the compact report all carry the same value unchanged.
 *
 * This module is pure: no audio, no file, no clock. The artifact build composes
 * it with the run's own evidence; ticket 73 derives a gate verdict per subject
 * from each subject's own artifact.
 */
import { CONVERSATION_LANGUAGES } from "@/lib/agents/wizard";
import { getVoice } from "@/lib/agents/voices";
import type { ArtifactPipeline } from "./scoreboard";
import { DEMO_VOICE_IDS } from "./voni-agent";

/** The channel a call reaches the agent on (spec W4: browser or phone). */
export const SUBJECT_TRANSPORTS = ["browser", "phone"] as const;
export type SubjectTransport = (typeof SUBJECT_TRANSPORTS)[number];

/** Where a subject record came from. */
export type SubjectSource =
  /** The featured default: the first demo voice, its Locale, the browser. */
  | "default"
  /** The run named its subject explicitly (`--gate-voice`, `--agent`, …). */
  | "flag"
  /** Derived from an artifact written before the axis existed. */
  | "legacy";

/**
 * The agent a subject measures. A demo agent is keyed by its voice (one stored
 * agent per voice); `agentId` is filled in when the served body is read. A
 * tenant agent is the stored agent a customer owns, addressed by id.
 */
export type SubjectAgent =
  | { readonly kind: "demo"; readonly voice: string; readonly agentId: string | null }
  | { readonly kind: "tenant"; readonly agentId: string };

/**
 * One subject, as recorded in an artifact and printed by the compact report.
 * `source` is provenance, not behaviour: the same demo voice is the same
 * subject whichever way the run named it.
 */
export type SubjectRecord = {
  readonly agent: SubjectAgent;
  /** The Locale the call is conducted in (a voice speaks exactly one). */
  readonly locale: string;
  readonly transport: SubjectTransport;
  readonly source: SubjectSource;
  /**
   * The engine the subject was measured on (spec: a subject is `{agent,
   * Locale, transport, pipeline}`). Absent means `managed` — the same precedent
   * as the artifact discriminator, so records written before the cascade keep
   * their meaning and the A/B cannot merge the two engines into one subject.
   */
  readonly pipeline?: ArtifactPipeline;
};

/** The subject flags as the orchestrator reads them. */
export type SubjectRequest = {
  /** `--gate-voice`/`--voice`: the voice the subject speaks. */
  voice?: string;
  /**
   * `--agent <id>`: a tenant agent replaces the demo voice. `undefined` means
   * the flag was absent; an empty string means it was present with no value.
   */
  agent?: string;
  /** `--subject-locale <code>`; required for a tenant, derived for a demo. */
  locale?: string;
  /** `--subject-transport browser|phone`; default browser. */
  transport?: string;
  /** Whether any subject flag was present, so the record says who chose it. */
  explicit?: boolean;
};

/** A subject the harness cannot measure, named by the field that was wrong. */
export class SubjectError extends Error {
  readonly field: "agent" | "locale" | "transport";
  readonly requested: string;

  constructor(field: "agent" | "locale" | "transport", requested: string, detail: string) {
    super(detail);
    this.name = "SubjectError";
    this.field = field;
    this.requested = requested;
  }
}

/** The demo voices are the voices with a stored demo agent (ticket 02). */
function isDemoVoice(voice: string): boolean {
  return (DEMO_VOICE_IDS as readonly string[]).includes(voice);
}

function isConversationLocale(locale: string): boolean {
  return (CONVERSATION_LANGUAGES as readonly string[]).includes(locale);
}

// ── Voice binding (M15, W1; the TS mirror of `cascade/voice_binding.py`) ─────

/** A voice and the one Locale it speaks, plus the vendor's language name. */
export type CascadeVoiceBinding = {
  readonly voiceId: string;
  readonly locale: string;
  /** The vendor's language name a synthesis request sends (`Spanish`, …). */
  readonly language: string;
};

/**
 * Voices with no binding, kept visible so they can never become a silent
 * fallback. `juergen` is the pre-re-cast German id: the vendor returned `422
 * voice_not_found`, German is now bound to `jorg` (ticket 130), and the old id
 * is marked `historical` — no longer offered, still refused by name.
 */
export const UNBOUND_VOICES: Readonly<
  Record<string, { readonly locale: string; readonly reason: string; readonly historical: boolean }>
> = Object.freeze({
  juergen: Object.freeze({
    locale: "de",
    reason:
      "vendor /v1/speech returned 422 voice_not_found; historical id, replaced by jorg (ticket 130)",
    historical: true,
  }),
});

/** A voice that cannot be a cascade subject; the refusal names it. */
export class VoiceBindingError extends Error {
  readonly voiceId: string;
  readonly locale: string | null;
  readonly reason: string;

  constructor(voiceId: string, locale: string | null, detail: string) {
    super(detail);
    this.name = "VoiceBindingError";
    this.voiceId = voiceId;
    this.locale = locale;
    this.reason = detail;
  }
}

/** The voice is not in the registry at all. */
export class UnknownVoiceError extends VoiceBindingError {
  constructor(voiceId: string) {
    super(voiceId, null, `unknown voice "${voiceId}": not in the voice binding table`);
    this.name = "UnknownVoiceError";
  }
}

/** The voice carries no binding, and the refusal names its Locale and reason. */
export class UnboundVoiceError extends VoiceBindingError {
  constructor(voiceId: string, locale: string, reason: string) {
    super(
      voiceId,
      locale,
      `voice "${voiceId}" is not bound to a Locale (${locale}): ${reason}`,
    );
    this.name = "UnboundVoiceError";
  }
}

/**
 * Return the voice's binding, or refuse by name. This is the gate a cascade
 * subject passes: a voice with no binding is not a cascade subject, and its
 * Locale stays open rather than being measured through another voice.
 */
export function bindCascadeVoice(voiceId: string): CascadeVoiceBinding {
  // The unbound row is checked before the catalogue: a historical id is no
  // longer offered, and naming it must still refuse by name with its Locale
  // and 422 reason rather than read as an unknown typo.
  const unbound = UNBOUND_VOICES[voiceId];
  if (unbound !== undefined) throw new UnboundVoiceError(voiceId, unbound.locale, unbound.reason);
  const known = getVoice(voiceId);
  if (!known) throw new UnknownVoiceError(voiceId);
  return { voiceId, locale: known.languageCode, language: known.language };
}

/** Whether the voice has a binding, i.e. may be a cascade subject at all. */
export function isCascadeSubjectVoice(voiceId: string): boolean {
  return getVoice(voiceId) !== undefined && UNBOUND_VOICES[voiceId] === undefined;
}

/**
 * A Locale's state in the cascade subject list. `bound` means a serving voice
 * is bound to it; `open` means no voice can be bound yet. There is deliberately
 * no `beta`, `dropped` or `cut-over` state: ADR 0009 removed all three.
 */
export const LOCALE_SUBJECT_STATUSES = ["bound", "open"] as const;
export type LocaleSubjectStatus = (typeof LOCALE_SUBJECT_STATUSES)[number];

/** One Locale's row: its status, the cascade voices bound to it, and why not. */
export type LocaleSubject = {
  readonly locale: string;
  readonly status: LocaleSubjectStatus;
  /** The demo voices bound to this Locale; empty while it is open. */
  readonly voices: readonly string[];
  /** Why the Locale has no cascade subject; `null` when it has one. */
  readonly openReason: string | null;
};

/**
 * The subject list, one row per offered Locale, each with its status spelled
 * out: the demo voice bound to it, or the named reason it is open. An open
 * Locale is listed, never omitted — a missing row would read as "done".
 */
export function cascadeSubjectList(): LocaleSubject[] {
  return CONVERSATION_LANGUAGES.map((locale) => {
    const demoVoices = DEMO_VOICE_IDS.filter(
      (voice) => getVoice(voice)?.languageCode === locale,
    );
    const voices = demoVoices.filter(isCascadeSubjectVoice);
    if (voices.length > 0) {
      return { locale, status: "bound" as const, voices: [...voices], openReason: null };
    }
    const reason = demoVoices
      .map((voice) => UNBOUND_VOICES[voice]?.reason)
      .find((value): value is string => value !== undefined);
    return {
      locale,
      status: "open" as const,
      voices: [],
      openReason: reason ?? `no demo voice is bound to "${locale}"`,
    };
  });
}

/** One Locale's row, or a named refusal for a Locale the product does not offer. */
export function localeSubjectStatus(locale: string): LocaleSubject {
  const row = cascadeSubjectList().find((entry) => entry.locale === locale);
  if (row === undefined) {
    throw new SubjectError(
      "locale",
      locale,
      `unknown Locale "${locale}": the subject list covers ${CONVERSATION_LANGUAGES.join(", ")}`,
    );
  }
  return row;
}

function resolveTransport(raw: string | undefined): SubjectTransport {
  if (raw === undefined || raw.trim() === "") return "browser";
  const transport = raw.trim();
  if ((SUBJECT_TRANSPORTS as readonly string[]).includes(transport)) {
    return transport as SubjectTransport;
  }
  throw new SubjectError(
    "transport",
    transport,
    `unknown transport "${transport}": a subject's transport is one of ${SUBJECT_TRANSPORTS.join(", ")}`,
  );
}

/**
 * A voice speaks exactly one Locale. For a demo subject the Locale is derived
 * from the voice; an explicit Locale must be that one. For a tenant subject the
 * bound voice, when named, must speak the subject's Locale too — a call in a
 * Locale the agent's voice cannot speak is not a subject worth measuring.
 */
function assertVoiceSpeaks(voice: string, locale: string): void {
  const known = getVoice(voice);
  if (!known) {
    throw new SubjectError(
      "agent",
      voice,
      `unknown voice "${voice}": pick a registered voice (src/lib/agents/voices.ts)`,
    );
  }
  if (known.languageCode !== locale) {
    throw new SubjectError(
      "locale",
      locale,
      `voice "${voice}" speaks ${known.languageCode}, not "${locale}" (voice binding: a voice speaks exactly one Locale)`,
    );
  }
}

/**
 * Resolve the subject a run asks to measure, or fail by name before any audio
 * is spent. This is the one resolver the orchestrator, the artifact build and
 * the tests use, so a flag typo cannot become a default subject.
 */
export function resolveSubject(request: SubjectRequest = {}): SubjectRecord {
  const transport = resolveTransport(request.transport);
  const source: SubjectSource = request.explicit === true ? "flag" : "default";

  if (request.agent !== undefined) {
    const agentId = request.agent.trim();
    if (agentId === "") {
      throw new SubjectError(
        "agent",
        request.agent,
        "a tenant subject needs an agent id (--agent <id>): an empty id would measure the default demo instead",
      );
    }
    if (isDemoVoice(agentId)) {
      throw new SubjectError(
        "agent",
        agentId,
        `--agent "${agentId}" names a demo voice, not a tenant agent; use --voice ${agentId} for the demo subject`,
      );
    }
    const locale = (request.locale ?? "").trim();
    if (locale === "") {
      throw new SubjectError(
        "locale",
        request.locale ?? "",
        "a tenant subject needs a Locale (--subject-locale <code>): a tenant agent has no demo voice to derive it from, and English is not assumed",
      );
    }
    if (!isConversationLocale(locale)) {
      throw new SubjectError(
        "locale",
        locale,
        `unknown Locale "${locale}": pick one of ${CONVERSATION_LANGUAGES.join(", ")}`,
      );
    }
    const voice = (request.voice ?? "").trim();
    if (voice === "") {
      throw new SubjectError(
        "agent",
        "",
        "a tenant subject needs --voice <id>: the voice the agent speaks pins its Locale and the caller's recognition, and the harness cannot invent it",
      );
    }
    assertVoiceSpeaks(voice, locale);
    return {
      agent: { kind: "tenant", agentId },
      locale,
      transport,
      source,
    };
  }

  const voice = (request.voice ?? "").trim() || DEMO_VOICE_IDS[0];
  if (!isDemoVoice(voice)) {
    throw new SubjectError(
      "agent",
      voice,
      `unknown gate voice "${voice}": a demo subject is one of ${DEMO_VOICE_IDS.join(", ")} (or pass --agent <id> for a tenant agent)`,
    );
  }
  const known = getVoice(voice);
  const requestedLocale = (request.locale ?? "").trim();
  if (requestedLocale !== "" && !isConversationLocale(requestedLocale)) {
    throw new SubjectError(
      "locale",
      requestedLocale,
      `unknown Locale "${requestedLocale}": pick one of ${CONVERSATION_LANGUAGES.join(", ")}`,
    );
  }
  const locale = requestedLocale === "" ? (known?.languageCode ?? "") : requestedLocale;
  assertVoiceSpeaks(voice, locale);
  return {
    agent: { kind: "demo", voice, agentId: null },
    locale,
    transport,
    source: request.explicit === true || voice !== DEMO_VOICE_IDS[0] ? "flag" : "default",
  };
}

/**
 * The cascade subject a run asks to measure: the same agent/Locale/transport
 * resolution, plus the binding gate (spec W1). A voice that cannot be bound to
 * one Locale is refused by name before any audio is spent — it is not a cascade
 * subject, and its Locale stays open rather than being measured anyway. The
 * pipeline axis is recorded so a managed run of the same voice cannot merge
 * with it in the A/B.
 */
export function resolveCascadeSubject(request: SubjectRequest = {}): SubjectRecord {
  const subject = resolveSubject(request);
  const voice = (request.voice ?? "").trim() || DEMO_VOICE_IDS[0];
  bindCascadeVoice(voice);
  return { ...subject, pipeline: "cascade" };
}

/**
 * The subject an artifact build synthesizes when the caller passed no subject:
 * the run's voice, its own Locale and the browser transport. A non-featured
 * voice is still an explicit subject (`flag`), so only the featured default is
 * ever recorded as `default`.
 */
export function subjectForRunVoice(voice: string): SubjectRecord {
  const subject = resolveSubject({ voice });
  return voice === DEMO_VOICE_IDS[0]
    ? { ...subject, source: "default" }
    : { ...subject, source: "flag" };
}

/** The featured default subject: the first demo voice, its Locale, the browser. */
export function defaultSubject(): SubjectRecord {
  return subjectForRunVoice(DEMO_VOICE_IDS[0]);
}

/**
 * A subject for an artifact that predates the axis (ticket 72): derive it from
 * the voice the artifact measured. Legacy artifacts came from the browser eval,
 * so the transport is browser; an unregistered voice is kept verbatim and its
 * Locale is `unknown`, never quietly replaced with English.
 */
export function subjectOrLegacy(input: {
  subject?: SubjectRecord;
  voice: string;
}): SubjectRecord {
  if (input.subject) return input.subject;
  const known = getVoice(input.voice);
  return {
    agent: { kind: "demo", voice: input.voice, agentId: null },
    locale: known?.languageCode ?? "unknown",
    transport: "browser",
    source: "legacy",
  };
}

/** One line naming a subject: `demo lola (es, browser)`, or `… , cascade)`. */
export function formatSubject(subject: SubjectRecord): string {
  const agent =
    subject.agent.kind === "demo"
      ? `demo ${subject.agent.voice}`
      : `tenant ${subject.agent.agentId}`;
  const pipeline = subject.pipeline === "cascade" ? ", cascade" : "";
  return `${agent} (${subject.locale}, ${subject.transport}${pipeline})`;
}

/**
 * Are two records the same subject? Provenance (`source`) is not part of the
 * identity: a legacy artifact derived from the featured voice and a new run of
 * that voice are the same subject. The `pipeline` axis is part of it (an absent
 * pipeline is `managed`), because a managed run and a cascade run of one voice
 * are the two sides of the A/B, not the same measurement.
 */
export function sameSubject(left: SubjectRecord, right: SubjectRecord): boolean {
  if ((left.pipeline ?? "managed") !== (right.pipeline ?? "managed")) return false;
  if (left.locale !== right.locale || left.transport !== right.transport) return false;
  if (left.agent.kind === "tenant" || right.agent.kind === "tenant") {
    return (
      left.agent.kind === "tenant" &&
      right.agent.kind === "tenant" &&
      left.agent.agentId === right.agent.agentId
    );
  }
  return left.agent.voice === right.agent.voice;
}

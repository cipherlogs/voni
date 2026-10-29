/**
 * The harness subject (voice-parity ticket 72, spec W5).
 *
 * A **subject** is what a measurement is about: `{agent, Locale, transport}`.
 * The featured voice is one subject, not the owner of the axis — a run can name
 * a different demo voice, a tenant agent, or the phone transport, and the
 * artifact it writes carries that subject so no later reader has to infer it
 * from a filename.
 *
 * Doctrine this module enforces:
 * - **Voice binding.** A voice speaks exactly one Locale. A subject that pairs
 *   a voice with another Locale is refused by name, never measured as if the
 *   voice could speak it.
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

/** Whether the registry has a voice with this exact id (no folding, no trim). */
function registryVoice(voice: string): ReturnType<typeof getVoice> {
  return getVoice(voice);
}

/** The demo voices are the voices with a stored demo agent (ticket 02). */
function isDemoVoice(voice: string): boolean {
  return (DEMO_VOICE_IDS as readonly string[]).includes(voice);
}

function isConversationLocale(locale: string): boolean {
  return (CONVERSATION_LANGUAGES as readonly string[]).includes(locale);
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
  const known = registryVoice(voice);
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
  const known = registryVoice(voice);
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
  const known = registryVoice(input.voice);
  return {
    agent: { kind: "demo", voice: input.voice, agentId: null },
    locale: known?.languageCode ?? "unknown",
    transport: "browser",
    source: "legacy",
  };
}

/** One line naming a subject: `demo lola (es, browser)`. */
export function formatSubject(subject: SubjectRecord): string {
  const agent =
    subject.agent.kind === "demo"
      ? `demo ${subject.agent.voice}`
      : `tenant ${subject.agent.agentId}`;
  return `${agent} (${subject.locale}, ${subject.transport})`;
}

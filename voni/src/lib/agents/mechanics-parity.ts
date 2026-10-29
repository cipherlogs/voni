import {
  stableJson,
  type StoredAgentBody,
  type StoredTurnDetection,
} from "./body";
import {
  QUALITY_FLOOR_IDS,
  assertPromptCarriesQualityFloor,
  qualityFloorFor,
  type QualityFloorId,
} from "./quality-floor";
import { getVoice } from "./voices";
import {
  callRecognition,
  callRecognitionLocale,
  resolveRecognition,
  type RecognitionLocale,
  type SceneSubject,
} from "@/lib/voice/recognition";

/**
 * Tenant/demo mechanics parity (voice-parity ticket 68, spec W4 "One product").
 *
 * ── Why a configuration assertion ─────────────────────────────────────────
 * One builder removed the *structural* drift: the demo and a tenant are now the
 * same function's output. It did not remove the *behavioural* promise — that a
 * tenant's Turn preset, transcription mode, quality floor and recognition
 * policy are the demo's too. Those four are the product's promises, not a
 * buyer's choices, so they are asserted here on the built bodies themselves:
 * a body that drifts fails a test instead of surprising a customer.
 *
 * ── What "equal" means, and what it does not ──────────────────────────────
 * - Turn preset: the same `turn_detection` value. The demo sends `null`
 *   (adaptive, meaning-based end-of-turn); an explicit object is drift.
 * - Transcription mode: the same `input.transcription_mode` string.
 * - Quality floor: each body carries its own Locale's five guarantees, once,
 *   as the first prompt section. The guarantee set is compared, never the
 *   wording across Locales — a Spanish floor is the same promise in Spanish.
 *   A Locale with no rendering yet (tickets 49/50) is a HOLE: it is reported
 *   as a failure with its Locale, never compared `null === null` and passed.
 * - Recognition policy: the recognition the body's own Locale resolves to —
 *   the Locale, its scene rendering and every word slot. Automatic detection
 *   is the one documented English-scaffolding exception, so an unpinned call
 *   and a pinned English call run the same policy and compare equal.
 *
 * Everything is read from `StoredAgentBody` fields — the body a caller
 * receives — never from an `AgentProfile`, a config, or the builders' inputs.
 */

/** The four session mechanics every agent shares. */
export const SESSION_MECHANICS = [
  "Turn preset",
  "transcription mode",
  "quality floor",
  "recognition policy",
] as const;

export type SessionMechanic = (typeof SESSION_MECHANICS)[number];

/**
 * `differs` is a mismatch between the two bodies; `hole` is a rendering the
 * product has not produced yet (a Locale with no floor, an incomplete
 * recognition set). A hole never compares equal to another hole.
 */
export type MechanicsDriftKind = "differs" | "hole";

/** One way a tenant body fails to match the demo, named by mechanic. */
export type MechanicsDrift = {
  readonly mechanic: SessionMechanic;
  readonly kind: MechanicsDriftKind;
  readonly detail: string;
};

export type QualityFloorMechanics = {
  /** The Locale the body's voice binds; null when the voice is unknown. */
  readonly locale: string | null;
  /** `hole`: the Locale has not rendered the floor (tickets 49/50). */
  readonly status: "rendered" | "hole";
  /** The guarantees a rendered floor must carry. */
  readonly guarantees: readonly QualityFloorId[];
  /** null when the prompt carries the floor; the refusal reason otherwise. */
  readonly violation: string | null;
};

export type RecognitionMechanics = {
  /** The pinned Locale, or null for automatic detection. */
  readonly pinned_locale: RecognitionLocale | null;
  /**
   * What the recogniser actually runs. Automatic detection is the documented
   * English-scaffolding exception, so it resolves to `en` rather than nothing.
   */
  readonly locale: RecognitionLocale;
  readonly status: "automatic" | "complete" | "incomplete" | "missing";
  /** Slots the Locale cannot render. Empty when complete or automatic. */
  readonly holes: readonly string[];
  /** The Locale's scene, rendered from a fixed neutral subject and compared as text. */
  readonly scene: string;
  /** Every word slot (vocabulary, digits, address, filler, commands, …), canonicalised. */
  readonly words: string;
};

/** A body's session mechanics, as the assertion compares them. */
export type BodyMechanics = {
  readonly turn_preset: StoredTurnDetection;
  readonly transcription_mode: string;
  readonly quality_floor: QualityFloorMechanics;
  readonly recognition_policy: RecognitionMechanics;
};

/**
 * A fixed, Locale-neutral subject for the scene rendering. Comparing the scene
 * text from the same subject isolates the Locale's rendering from the agent's
 * own mission and topics, which legitimately differ between demo and tenant.
 */
const SCENE_SAMPLE: SceneSubject = {
  agentName: "Agent",
  role: "assistant",
  mission: "Help the caller.",
  topics: ["budget"],
};

function qualityFloorMechanics(body: StoredAgentBody): QualityFloorMechanics {
  const locale = getVoice(body.voice.voice_id)?.languageCode ?? null;
  const rendering = locale === null ? null : qualityFloorFor(locale);
  if (!rendering) {
    return {
      locale,
      status: "hole",
      guarantees: [],
      violation: null,
    };
  }

  try {
    assertPromptCarriesQualityFloor(body.system_prompt, rendering);
  } catch (error) {
    return {
      locale,
      status: "rendered",
      guarantees: [...QUALITY_FLOOR_IDS],
      violation: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    locale,
    status: "rendered",
    guarantees: [...QUALITY_FLOOR_IDS],
    violation: null,
  };
}

function recognitionMechanics(body: StoredAgentBody): RecognitionMechanics {
  const source = { languageCodes: body.input.language_codes ?? [] };
  const pinned = callRecognitionLocale(source);
  const recognition = callRecognition(source);
  const resolution = pinned === null ? null : resolveRecognition(pinned);
  const { scene, ...words } = recognition;

  return {
    pinned_locale: pinned,
    locale: recognition.locale,
    status: pinned === null ? "automatic" : (resolution?.status ?? "missing"),
    holes: resolution?.status === "incomplete" ? [...resolution.missing] : [],
    scene: scene(SCENE_SAMPLE),
    words: stableJson(words),
  };
}

/** Read a built body's session mechanics. Pure: the body in, its mechanics out. */
export function mechanicsOf(body: StoredAgentBody): BodyMechanics {
  return {
    turn_preset: body.input.turn_detection,
    transcription_mode: body.input.transcription_mode,
    quality_floor: qualityFloorMechanics(body),
    recognition_policy: recognitionMechanics(body),
  };
}

/**
 * Every way a tenant body fails to match the demo's mechanics, in mechanic
 * order. Empty exactly when the two bodies agree, so a caller can either read
 * the report or use `assertMechanicsParity` to refuse the drift.
 */
export function mechanicsDrift(
  demo: StoredAgentBody,
  tenant: StoredAgentBody,
): MechanicsDrift[] {
  const a = mechanicsOf(demo);
  const b = mechanicsOf(tenant);
  const drifts: MechanicsDrift[] = [];

  if (stableJson(a.turn_preset) !== stableJson(b.turn_preset)) {
    drifts.push({
      mechanic: "Turn preset",
      kind: "differs",
      detail: `the demo sends turn_detection ${JSON.stringify(
        a.turn_preset,
      )}; the tenant sends ${JSON.stringify(
        b.turn_preset,
      )}. The Turn preset is null on every agent.`,
    });
  }

  if (a.transcription_mode !== b.transcription_mode) {
    drifts.push({
      mechanic: "transcription mode",
      kind: "differs",
      detail: `the demo transcribes in "${a.transcription_mode}"; the tenant transcribes in "${b.transcription_mode}".`,
    });
  }

  // The floor is a guarantee per body, not a text comparison across Locales.
  // A Locale without a rendering is a hole on that body, and two holes do not
  // compose an equal pair.
  for (const [who, mechanics] of [
    ["demo", a],
    ["tenant", b],
  ] as const) {
    const floor = mechanics.quality_floor;
    if (floor.status === "hole") {
      drifts.push({
        mechanic: "quality floor",
        kind: "hole",
        detail: `the ${who} body speaks Locale ${JSON.stringify(
          floor.locale,
        )} and has no floor rendering yet (tickets 49/50); the floor is omitted, never replaced with English.`,
      });
    } else if (floor.violation !== null) {
      drifts.push({
        mechanic: "quality floor",
        kind: "differs",
        detail: `the ${who} body's system prompt does not carry the floor: ${floor.violation}`,
      });
    }
  }

  for (const [who, mechanics] of [
    ["demo", a],
    ["tenant", b],
  ] as const) {
    const recognition = mechanics.recognition_policy;
    if (
      recognition.status === "incomplete" ||
      recognition.status === "missing"
    ) {
      drifts.push({
        mechanic: "recognition policy",
        kind: "hole",
        detail: `the ${who} body's recognition rendering for "${recognition.locale}" is ${recognition.status}${
          recognition.holes.length > 0
            ? ` (missing ${recognition.holes.join(", ")})`
            : ""
        }; a hole is not an English fallback.`,
      });
    }
  }

  const demoRecognition = a.recognition_policy;
  const tenantRecognition = b.recognition_policy;
  if (
    demoRecognition.locale !== tenantRecognition.locale ||
    demoRecognition.scene !== tenantRecognition.scene ||
    demoRecognition.words !== tenantRecognition.words
  ) {
    drifts.push({
      mechanic: "recognition policy",
      kind: "differs",
      detail: `the demo runs recognition in "${demoRecognition.locale}"; the tenant runs "${tenantRecognition.locale}" with a ${
        demoRecognition.scene === tenantRecognition.scene
          ? "matching"
          : "different"
      } scene and a ${
        demoRecognition.words === tenantRecognition.words
          ? "matching"
          : "different"
      } word repertoire.`,
    });
  }

  return drifts;
}

/**
 * Refuse a tenant body whose mechanics do not match the demo's, naming every
 * mechanic that drifted. This is the configuration assertion: the demo body is
 * the reference, the tenant body is the body a customer's call will run.
 *
 * A rendered Locale with no floor is a failure, not an accepted pair of holes:
 * tickets 49/50 close it by adding renderings, not by relaxing this.
 */
export function assertMechanicsParity(
  demo: StoredAgentBody,
  tenant: StoredAgentBody,
): void {
  const drifts = mechanicsDrift(demo, tenant);
  if (drifts.length === 0) return;

  throw new Error(
    [
      "Tenant agent mechanics drift from the demo's:",
      ...drifts.map(
        (drift) => `- ${drift.mechanic} (${drift.kind}): ${drift.detail}`,
      ),
    ].join("\n"),
  );
}

/**
 * Real-shaped priced rows for the usage ledger tests.
 *
 * These are the pipeline's own `cost.priced` rows, copied from calls the
 * cascade made on 2026-11-02. The measured row spent 35 STT seconds, nothing on
 * the LLM (it opened but made no request) and 89 TTS characters. The unmeasured
 * row lost its STT usage frame and its TTS Termination summary but still priced
 * its LLM tokens. The zero row is a call that refused before any vendor opened.
 */

export const RATE_TABLE_VERSION = "cascade-vendor-rates v1";

/** A fully measured call: stt 35 s, no LLM request, tts 89 chars. */
export const MEASURED_ROW = {
  schemaVersion: 1,
  pipeline: "cascade",
  callId: "e6ddc067-dcb6-4e13-8f51-1bf878cd59ce",
  type: "cost.priced",
  subject: "demo:audrey",
  turn: null,
  atMs: 1793616738834.2344,
  phase: "end",
  producer: "cascade.cost.cost_call",
  rateTableVersion: RATE_TABLE_VERSION,
  measured: true,
  totalUsd: 0.003085,
  legs: {
    stt: {
      unit: "audio_seconds",
      quantity: 35,
      measured: true,
      source: "priced from the vendor's reported units",
      amountUsd: 0.00175,
      units: { audio_seconds: 35 },
    },
    llm: {
      unit: "multiple",
      quantity: 0,
      measured: true,
      source: "opened, no request made this call",
      amountUsd: 0,
      units: {
        prompt_tokens: 0,
        completion_tokens: 0,
        cached_tokens: 0,
        reasoning_tokens: 0,
      },
    },
    tts: {
      unit: "multiple",
      quantity: null,
      measured: true,
      source: "priced from the vendor's reported units",
      amountUsd: 0.001335,
      units: { characters: 89, audio_seconds: 6.4, session_seconds: 33 },
    },
  },
} as const;

/**
 * A measured call with a real LLM turn: the llm leg's amount is the vendor's
 * own, and its token units are the same row the unmeasured fixture carries.
 */
export const MEASURED_LLM_ROW = {
  ...MEASURED_ROW,
  callId: "3e4d9e9b-1f21-4a0e-9f9a-2f6f0f3a1b7c",
  totalUsd: 0.00549885,
  legs: {
    ...MEASURED_ROW.legs,
    llm: {
      unit: "multiple",
      quantity: null,
      measured: true,
      source: "priced from the vendor's reported units",
      amountUsd: 0.00241385,
      units: {
        prompt_tokens: 4859,
        completion_tokens: 390,
        cached_tokens: 4834,
        reasoning_tokens: 342,
      },
    },
  },
} as const;

/**
 * The real unmeasured call: stt and tts never reported usage, llm did. The
 * total is null; a reader must never make it a partial sum.
 */
export const UNMEASURED_ROW = {
  schemaVersion: 1,
  pipeline: "cascade",
  callId: "7b190dc5-b228-4e16-8fe1-877b1e30a4cd",
  type: "cost.priced",
  subject: "demo:audrey",
  turn: null,
  atMs: 1793564427779.0127,
  phase: "end",
  producer: "cascade.cost.cost_call",
  rateTableVersion: RATE_TABLE_VERSION,
  measured: false,
  totalUsd: null,
  legs: {
    stt: {
      unit: "unknown",
      quantity: null,
      measured: false,
      source: "stt.audio_seconds is unmeasured: no speech usage frame was recorded",
      amountUsd: null,
      units: {},
    },
    llm: {
      unit: "multiple",
      quantity: null,
      measured: true,
      source: "priced from the vendor's reported units",
      amountUsd: 0.00241385,
      units: {
        prompt_tokens: 4859,
        completion_tokens: 390,
        cached_tokens: 4834,
        reasoning_tokens: 342,
      },
    },
    tts: {
      unit: "unknown",
      quantity: null,
      measured: false,
      source:
        "tts.characters is unmeasured: unterminated: no Termination summary was received; " +
        "tts.audio_seconds is unmeasured: the vendor did not report audio_seconds; " +
        "tts.session_seconds is unmeasured: the vendor did not report session_seconds",
      amountUsd: null,
      units: {},
    },
  },
  unmeasuredReason:
    "stt: stt.audio_seconds is unmeasured: no speech usage frame was recorded; " +
    "tts: tts.characters is unmeasured: unterminated: no Termination summary was received; " +
    "tts: tts.audio_seconds is unmeasured: the vendor did not report audio_seconds; " +
    "tts: tts.session_seconds is unmeasured: the vendor did not report session_seconds",
} as const;

/** A call that refused before any vendor opened: measured, zero, and sourced. */
export const MEASURED_ZERO_ROW = {
  schemaVersion: 1,
  pipeline: "cascade",
  callId: "0e6f0a1b-7c2d-4e3f-8a9b-0c1d2e3f4a5b",
  type: "cost.priced",
  subject: "demo:audrey",
  turn: null,
  atMs: 1793616800000,
  phase: "end",
  producer: "cascade.cost.cost_call",
  rateTableVersion: RATE_TABLE_VERSION,
  measured: true,
  totalUsd: 0,
  legs: {},
  source: "the call opened no session: the app refused before any vendor call",
} as const;

export const MEASURED = {
  callId: MEASURED_ROW.callId,
  scenario: "golden-flow-greeting-only",
  locale: "en",
  row: MEASURED_ROW,
};

export const MEASURED_LLM = {
  callId: MEASURED_LLM_ROW.callId,
  scenario: "golden-flow-booking",
  locale: "en",
  row: MEASURED_LLM_ROW,
};

export const UNMEASURED = {
  callId: UNMEASURED_ROW.callId,
  scenario: "golden-flow-booking",
  locale: "en",
  row: UNMEASURED_ROW,
};

export const ZERO = {
  callId: MEASURED_ZERO_ROW.callId,
  scenario: "ending-goodbye",
  locale: "en",
  row: MEASURED_ZERO_ROW,
};

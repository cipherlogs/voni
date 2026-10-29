/**
 * The resolved output audio format the server applied to a session.
 *
 * `session.ready` echoes the full resolved config, including
 * `output.format`. The client plays at the rate it was told; assuming 24 kHz
 * turns any other resolved rate into a silent speed change. 24 kHz is only
 * the fallback when the confirmation carries no rate at all.
 */

/**
 * Fallback for a confirmation that echoes no rate. The API's native output is
 * 24 kHz PCM16; this is a named default, not the contract — a resolved rate
 * always wins. See docs/agents/assemblyai.md.
 */
export const DEFAULT_OUTPUT_SAMPLE_RATE = 24_000;

/** The confirmation named an output format the client cannot play correctly. */
export class OutputFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputFormatError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Read `config.output.format.sample_rate` from a session confirmation.
 *
 * Absent means the server echoed no rate, so the named default applies. A
 * rate that is present but unplayable is an explicit refusal: guessing would
 * play the caller's audio at the wrong speed with no visible failure.
 */
export function resolveOutputSampleRate(config: unknown): number {
  const format = record(record(record(config)?.output)?.format);
  const rate = format?.sample_rate;
  if (rate === undefined || rate === null) return DEFAULT_OUTPUT_SAMPLE_RATE;
  if (typeof rate !== "number" || !Number.isInteger(rate) || rate <= 0) {
    throw new OutputFormatError(
      `The call's output sample rate (${String(rate)}) is unsupported. Start a new call.`,
    );
  }
  return rate;
}

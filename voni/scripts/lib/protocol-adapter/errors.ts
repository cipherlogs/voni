/**
 * The protocol adapter's named refusals.
 *
 * Every code is a startup or evidence refusal, never a skipped assertion: a
 * missing key, corpus, scenario, vendor build, soundscape or service trace
 * exits 2 and names the item. A call that the service refuses is a named
 * refusal too (RR-06), not a measured pass.
 */

/** `demo:verify` exit code for bad input or missing evidence. */
export const PROTOCOL_REFUSAL_EXIT_CODE = 2 as const;

export const PROTOCOL_ERROR_CODES = [
  "missing-key",
  "missing-corpus",
  "missing-scenario",
  "missing-vendor-build",
  "invalid-vendor-builds",
  "missing-soundscape",
  "missing-inbox",
  "inbox-unavailable",
  "missing-target",
  "target-mismatch",
  "target-invalid",
  "evidence-unreachable",
  "trace-missing",
  "trace-malformed",
  "call-refused",
  "call-closed",
  "call-timeout",
  "trigger-unresolved",
  "run-dir-invalid",
  "corpus-refused",
] as const;

export type ProtocolAdapterErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

export class ProtocolAdapterError extends Error {
  readonly code: ProtocolAdapterErrorCode;
  readonly exitCode = PROTOCOL_REFUSAL_EXIT_CODE;
  /** The startup items this refusal names, when it names several. */
  readonly missing: readonly { readonly item: string; readonly detail: string }[];

  constructor(
    code: ProtocolAdapterErrorCode,
    message: string,
    missing: readonly { readonly item: string; readonly detail: string }[] = [],
  ) {
    super(message);
    this.name = "ProtocolAdapterError";
    this.code = code;
    this.missing = missing;
  }
}

export function refusal(
  code: ProtocolAdapterErrorCode,
  message: string,
  missing: readonly { readonly item: string; readonly detail: string }[] = [],
): never {
  throw new ProtocolAdapterError(code, message, missing);
}

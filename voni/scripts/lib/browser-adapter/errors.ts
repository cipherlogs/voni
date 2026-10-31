/**
 * The browser adapter's named refusals.
 *
 * Every code is a startup or evidence refusal, never a skipped assertion: a
 * fake pipeline, a test build, a missing key, a missing corpus, scenario,
 * vendor build, soundscape, app, trace, end document, delivered capture or
 * marks artifact exits 2 and names the item. A browser call the harness cannot
 * complete is a named refusal too, never a measured pass.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Commands and exit codes" and
 * "Unexpected skips fail".
 */

/** `demo:verify` exit code for bad input or missing evidence. */
export const BROWSER_REFUSAL_EXIT_CODE = 2 as const;

export const BROWSER_ERROR_CODES = [
  "missing-key",
  "fake-pipeline",
  "test-build",
  "missing-corpus",
  "missing-scenario",
  "missing-vendor-build",
  "invalid-vendor-builds",
  "missing-soundscape",
  "missing-target",
  "target-mismatch",
  "target-invalid",
  "app-unreachable",
  "pipeline-unreachable",
  "evidence-unreachable",
  "capture-unavailable",
  "trace-missing",
  "trace-malformed",
  "end-missing",
  "marks-missing",
  "capture-missing",
  "capture-incomplete",
  "capture-malformed",
  "call-id-mismatch",
  "cost-missing",
  "call-refused",
  "call-timeout",
  "trigger-unresolved",
  "certificate-refused",
  "run-dir-invalid",
  "corpus-refused",
] as const;

export type BrowserAdapterErrorCode = (typeof BROWSER_ERROR_CODES)[number];

export class BrowserAdapterError extends Error {
  readonly code: BrowserAdapterErrorCode;
  readonly exitCode = BROWSER_REFUSAL_EXIT_CODE;
  /** The startup items this refusal names, when it names several. */
  readonly missing: readonly { readonly item: string; readonly detail: string }[];

  constructor(
    code: BrowserAdapterErrorCode,
    message: string,
    missing: readonly { readonly item: string; readonly detail: string }[] = [],
  ) {
    super(message);
    this.name = "BrowserAdapterError";
    this.code = code;
    this.missing = missing;
  }
}

export function refuse(
  code: BrowserAdapterErrorCode,
  message: string,
  missing: readonly { readonly item: string; readonly detail: string }[] = [],
): never {
  throw new BrowserAdapterError(code, message, missing);
}

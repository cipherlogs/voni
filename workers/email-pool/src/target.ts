/**
 * Target validation for the email-pool worker.
 *
 * The pool fetches whatever voni asks for, so the only thing worth checking is
 * that the string is a URL a fetch can actually make: absolute, http or https.
 * Host policy lives nowhere else — the operator decided every host is fair
 * game. This module is pure and has no I/O.
 */

export type ValidationResult =
  | { ok: true; url: URL }
  | { ok: false; reason: string; detail: string };

function fail(reason: string, detail: string): ValidationResult {
  return { ok: false, reason, detail };
}

/**
 * Validate a target URL. Checks are ordered so the message names the actual
 * problem: not a string, not parseable, wrong protocol, embedded credentials.
 */
export function validateTarget(rawUrl: unknown): ValidationResult {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    return fail("invalid_url", "url must be a non-empty string");
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return fail(
      "invalid_url",
      `url could not be parsed: ${rawUrl}; use an absolute http or https URL`,
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail(
      "unsupported_protocol",
      `protocol ${url.protocol} is not allowed; use http or https`,
    );
  }

  // Workers refuses a fetch whose URL carries credentials, so catch it here
  // where the caller gets a named reason instead of a transport failure.
  if (url.username !== "" || url.password !== "") {
    return fail("credentials", "url must not embed credentials");
  }

  return { ok: true, url };
}

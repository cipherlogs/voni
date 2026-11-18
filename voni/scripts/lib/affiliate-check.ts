/**
 * Pure pieces of the affiliate check's upload path, kept out of
 * `upload-affiliate-check.mts` so a test can exercise them without loading
 * `.env.local`, reaching Grafana, or spawning anything.
 *
 * The script's own text — the placeholder, the secret alphabet, the report row
 * and the landing-URL rule — lives in `src/lib/email/check-script.ts`, because
 * the panel's save action builds the same script and has to import it from the
 * app. This module only owns the upload-time guard and the read-back diff:
 *
 *   injectReportSecret  — swap the committed placeholder for the real value in
 *                         memory, and refuse a file that has no placeholder
 *                         (that file may already carry a secret) or a secret
 *                         that cannot survive a JavaScript string literal.
 *   changedCheckFields  — the field diff the upload prints and verifies with.
 */
import {
  REPORT_SECRET_PATTERN,
  REPORT_SECRET_PLACEHOLDER,
} from "../../src/lib/email/check-script";

export { REPORT_SECRET_PATTERN, REPORT_SECRET_PLACEHOLDER };

/** One carry of a file that must not be uploaded as-is. */
export class AffiliateCheckUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AffiliateCheckUploadError";
  }
}

export function countOccurrences(source: string, needle: string): number {
  if (needle === "") return 0;
  return source.split(needle).length - 1;
}

/**
 * Replace the placeholder in the declaration with the secret.
 *
 * The guard is the whole point of this function: a script with no placeholder
 * may already contain the real value, and uploading it would either overwrite
 * a working secret blindly or push a leaked one back to Grafana.
 *
 * Exactly one occurrence is replaced — the first, which the generated script
 * guarantees is the `const REPORT_SECRET = "..."` declaration. The generator
 * also compares `REPORT_SECRET` against the same literal to decide whether
 * reporting is on, and that comparison must keep the placeholder: after the
 * swap it is what turns reporting on, and rewriting it too would leave the
 * uploaded script reporting nothing.
 *
 * `replace` is called with a function so the inserted text is always taken
 * literally, whatever a future secret alphabet allows.
 */
export function injectReportSecret(source: string, secret: string): string {
  const placeholders = countOccurrences(source, REPORT_SECRET_PLACEHOLDER);
  if (placeholders === 0) {
    throw new AffiliateCheckUploadError(
      'refusing to upload: the script has no "__REPORT_SECRET__" placeholder. ' +
        "A script without it may already carry a real secret, and this command " +
        "refuses to guess. Regenerate with `npm run affiliate:check`; never " +
        "commit an injected script.",
    );
  }
  if (secret.trim() === "" || secret.includes(REPORT_SECRET_PLACEHOLDER)) {
    throw new AffiliateCheckUploadError(
      "refusing to upload: EMAIL_CLICK_REPORT_SECRET is empty or still the placeholder.",
    );
  }
  if (!REPORT_SECRET_PATTERN.test(secret)) {
    throw new AffiliateCheckUploadError(
      "refusing to upload: EMAIL_CLICK_REPORT_SECRET must be at least 8 characters from " +
        "[A-Za-z0-9._~+/=-]. The value is pasted into a JavaScript string literal in the " +
        'stored script, so a quote or a backslash would either break the script or change ' +
        "the value and turn every report into a 401. Generate one with " +
        "`openssl rand -base64 32 | tr -d '+/='` and set it on both sides.",
    );
  }
  // A string pattern replaces the first match only, which is the declaration.
  return source.replace(REPORT_SECRET_PLACEHOLDER, () => secret);
}

/**
 * Fields a script upload must leave untouched. `modified` and the script are
 * deliberately absent: Grafana stamps the first and we mean to change the second.
 */
export const UNCHANGED_CHECK_FIELDS = [
  "id",
  "job",
  "target",
  "enabled",
  "frequency",
  "timeout",
  "probes",
  "labels",
  "tenantId",
] as const;

/** Names of `fields` whose value differs between the two check bodies. */
export function changedCheckFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: readonly string[] = UNCHANGED_CHECK_FIELDS,
): string[] {
  return fields.filter(
    (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
  );
}

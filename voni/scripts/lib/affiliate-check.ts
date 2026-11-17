/**
 * Pure pieces of the affiliate check's upload path, kept out of
 * `upload-affiliate-check.mts` so a test can exercise them without loading
 * `.env.local`, reaching Grafana, or spawning anything.
 *
 * Three things live here:
 *
 *   injectReportSecret  — swap the committed placeholder for the real value in
 *                         memory, and refuse a file that has no placeholder
 *                         (that file may already carry a secret) or a secret
 *                         that cannot survive a JavaScript string literal.
 *   REPORT_BODY_SOURCE  — the one JSON row a click reports, as source. The
 *                         generator inlines this exact text into the k6 script,
 *                         and the test evaluates the same text and hands the
 *                         result to the real parser, so the wire shape has one
 *                         definition instead of two that can drift.
 *   REPORT_FINAL_URL_SOURCE — the landing-URL rule the same row uses, inlined
 *                         and tested the same way, so clipping happens where it
 *                         is defined instead of inside an untestable script.
 *   changedCheckFields  — the field diff the upload prints and verifies with.
 */

/**
 * What the committed generated script carries. `npm run affiliate:check`
 * writes it; `npm run affiliate:upload` replaces it in memory only.
 */
export const REPORT_SECRET_PLACEHOLDER = "__REPORT_SECRET__";

/**
 * What a secret may contain. The value is pasted into a JavaScript string
 * literal in the stored script, so a `"` ends the literal and a `\` starts an
 * escape: either one either breaks the script outright or changes the value,
 * which turns every report into a silent 401. The set is the URL-safe/base64
 * alphabet, which is what a generated secret already is.
 */
export const REPORT_SECRET_PATTERN = /^[A-Za-z0-9._~+/=-]{8,}$/;

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
 * The landing-URL rule, as source. Inlined by the generator and evaluated by
 * the test.
 *
 * `finalUrl` is null whenever it would be a lie or a rejection:
 *   - status 0 is a transport failure; k6's `response.url` then echoes the
 *     request URL as if something had answered;
 *   - an empty `response.url` means the same thing;
 *   - longer than the parser's 2048-char bound (`CLICK_REPORT_MAX_TARGET_CHARS`)
 *     is a URL the row cannot store, and sending it would 400 the whole report
 *     instead of recording the click.
 */
export const REPORT_FINAL_URL_SOURCE = `/** src/lib/email/click-report.ts CLICK_REPORT_MAX_TARGET_CHARS. */
const MAX_FINAL_URL_CHARS = 2048;

function reportFinalUrl(status, url) {
  if (status === 0 || !url || url.length > MAX_FINAL_URL_CHARS) return null;
  return url;
}`;

/**
 * The report body, as k6-compatible source.
 *
 * Every field is one the parser in `src/lib/email/click-report.ts` requires or
 * accepts, and every value already fits its bound by construction: target,
 * UA, browser and source come from the generated matrix and target list, and a
 * click slower than the parser's 120 s ceiling is outside what the check can
 * observe anyway. `status` is null on a transport failure, which is the
 * parser's "no response" case; `finalUrl` comes from `reportFinalUrl` above for
 * the same reason.
 */
export const REPORT_BODY_SOURCE = `function buildReportBody(record, ranAt) {
  return {
    target: record.target,
    source: record.source,
    finalUrl: record.finalUrl,
    status: record.status,
    ms: record.ms,
    userAgent: record.userAgent,
    device: record.device,
    browser: record.browser,
    ranAt: ranAt,
  };
}`;

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

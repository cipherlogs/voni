/**
 * Where a certificate lives: `voni/certificates/`, committed with the code.
 *
 * A certificate is the one verification artifact that is committed; audio,
 * event traces and delivered WAVs stay gitignored working files. The file name
 * is the run id, refused unless it is a safe single path component so a run id
 * can never escape the directory.
 */

import { CertificateError } from "./errors";

/** The committed certificate directory (beside `voni/src` and `voni/scripts`). */
export const CERTIFICATES_DIR = new URL("../../../../../evidence/certificates/", import.meta.url);

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The committed file name for a run id; a traversing id is refused by name. */
export function certificateFileName(runId: string): string {
  if (!SAFE_RUN_ID.test(runId)) {
    throw new CertificateError(
      "unsafe-run-id",
      `run id "${runId}" is not a safe certificate file name; use letters, digits, dot, dash or underscore`,
    );
  }
  return `${runId}.json`;
}

/** The URL a certificate for this run is committed at. */
export function certificateFile(runId: string): URL {
  return new URL(certificateFileName(runId), CERTIFICATES_DIR);
}

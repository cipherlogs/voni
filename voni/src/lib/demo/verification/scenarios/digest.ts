/**
 * The one byte digest the verification effort hashes takes with.
 *
 * Ticket 10's corpus loader verifies every committed take against the sha256
 * its scenario declares; ticket 23's Studio hashes a take the moment it lands.
 * Both must agree byte-for-byte, so both call this function: a second copy of
 * "sha256 of the file" is how two artifacts drift apart while each looks green.
 */

import { createHash } from "node:crypto";

/** Lowercase hex sha256 of the exact bytes. */
export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

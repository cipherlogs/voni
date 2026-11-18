/**
 * A Server Action id is hashed into the client bundle at build time. Deploy
 * while a tab is open and that tab keeps posting the id it was built with; the
 * new Worker has no such action and answers:
 *
 *   Server Action "6087ff…" was not found on the server.
 *
 * Nothing the operator typed was wrong, and no amount of retrying can find an
 * action that no longer exists in this build — only a reload does. Next words
 * this two ways depending on which side notices first.
 */
const STALE_ACTION_PATTERNS = [
  /Failed to find Server Action/i,
  /Server Action .* was not found on the server/i,
  /failed-to-find-server-action/i,
];

export function isStaleServerActionError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return STALE_ACTION_PATTERNS.some((pattern) => pattern.test(message));
}

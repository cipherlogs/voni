/**
 * Shared microphone ownership between voice interfaces.
 *
 * The copilot and the existing "test this agent" VoiceCall must never hold
 * the mic at the same time: two live sessions would hear each other and both
 * would bill. Ownership is cooperative — starting one side ends the other
 * first (UI layer), and this registry is the backstop that refuses a second
 * acquisition with a `busy-mic` error instead of opening a competing session.
 */

let owner: string | null = null;

/** Claim the mic for `id`. Returns false when another owner holds it. */
export function acquireMic(id: string): boolean {
  if (owner !== null && owner !== id) return false;
  owner = id;
  return true;
}

/** Release the mic. Only the current owner can release it. */
export function releaseMic(id: string): void {
  if (owner === id) owner = null;
}

/** Who holds the mic right now, if anyone. */
export function currentMicOwner(): string | null {
  return owner;
}

/** Test-only reset. Production code must pair acquire/release. */
export function resetMicOwnerForTests(): void {
  owner = null;
}

/**
 * Shared m:ss call timer — one formatter for the copilot header button, the
 * call card, and the list/detail duration cells, so every duration in the
 * product agrees to the second. Pure arithmetic, no locale, so SSR and
 * client render agree.
 */
export function formatCallStatus(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds)
    ? Math.max(0, Math.floor(totalSeconds))
    : 0;
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

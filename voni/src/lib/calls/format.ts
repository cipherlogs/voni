/**
 * Relative "2h ago" label for call timestamps. Server-side, locale-free
 * arithmetic only — no Date formatting, so SSR and client render agree and
 * hydration never mismatches on locale.
 */
export function relativeCallTime(from: Date | null): string {
  if (!from) return "Start time not recorded";
  const seconds = Math.max(0, Math.floor((Date.now() - from.getTime()) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/**
 * Call length from started/ended timestamps ("3:42"), or "—" when either
 * end is missing. Pure arithmetic — hydration-safe like relativeCallTime.
 */
export function callDuration(startedAt: Date | null, endedAt: Date | null): string {
  if (!startedAt || !endedAt) return "—";
  const seconds = Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

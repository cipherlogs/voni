import { formatCallStatus } from "@/lib/calls/call-status";

/**
 * Relative "2 hours ago" label for call timestamps. Server-side, locale-free
 * arithmetic only — no Date formatting, so SSR and client render agree and
 * hydration never mismatches on locale.
 */
export function relativeCallTime(from: Date | null): string {
  if (!from) return "Start time not recorded";
  const seconds = Math.max(0, Math.floor((Date.now() - from.getTime()) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days < 30)
    return days === 1 ? "1 day ago" : `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12)
    return months === 1 ? "1 month ago" : `${months} months ago`;
  const years = Math.floor(months / 12);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

/**
 * Call length from started/ended timestamps ("3:42"), or "—" when either
 * end is missing. Delegates to the shared call-status formatter so list
 * cells, detail cells, and live timers share one rounding rule. Pure
 * arithmetic — hydration-safe like relativeCallTime.
 */
export function callDuration(
  startedAt: Date | null,
  endedAt: Date | null,
): string {
  if (!startedAt || !endedAt) return "—";
  return formatCallStatus(
    Math.max(
      0,
      Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000),
    ),
  );
}

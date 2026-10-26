/**
 * Absolute "Started" timestamp for call rows ("4 Mar 2026, 15:30").
 *
 * The formatter lives at module scope so list renders pay one
 * construction per process instead of one per row per render (ticket 09
 * V3/J1). This module stays separate from `lib/calls/format.ts`: that
 * module must remain arithmetic-only so SSR and client render agree — an
 * Intl string rendered here comes from the server payload (or a client
 * render that already owns the locale), never recomputed across the
 * boundary.
 */
const ABSOLUTE_CALL_TIME_FORMAT = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatAbsoluteCallTime(value: Date | null): string {
  if (!value) return "—";
  return ABSOLUTE_CALL_TIME_FORMAT.format(value);
}

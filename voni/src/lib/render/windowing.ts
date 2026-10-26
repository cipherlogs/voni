/**
 * List windowing math (ticket 09 V1).
 *
 * Long call/lead lists used to render every row of DOM up front. These
 * pure helpers describe the rendered window instead: a bounded prefix
 * that grows one chunk per scroll sentinel, in list order, without ever
 * mutating the input rows. The `<WindowedRows>` island renders exactly
 * the slice described here.
 */

/** Rows per growth chunk: long lists paint at most this many up front. */
export const WINDOWED_PAGE_SIZE = 50;

/**
 * The `size` rows from `start`, clamped to the list. Never mutates or
 * reorders `rows` — the visible output is always a list-order prefix (or
 * sub-slice) of the input.
 */
export function windowedSlice<T>(
  rows: readonly T[],
  start: number,
  size: number,
): T[] {
  if (rows.length === 0 || size <= 0) return [];
  const from = Math.max(0, Math.min(start, rows.length));
  const to = Math.max(from, Math.min(from + Math.max(0, size), rows.length));
  return rows.slice(from, to);
}

/**
 * Clamped `{ start, end }` window around `anchor` with `overscan` rows of
 * headroom on each side. `end` is exclusive; both ends clamp to the list
 * so short lists window to themselves.
 */
export function computeWindowedRange(
  total: number,
  anchor: number,
  windowSize: number,
  overscan = 10,
): { start: number; end: number } {
  if (total <= 0 || windowSize <= 0) return { start: 0, end: 0 };
  const safeAnchor = Math.max(0, Math.min(anchor, total - 1));
  const start = Math.max(0, safeAnchor - overscan);
  const end = Math.min(total, safeAnchor + windowSize + overscan);
  return { start, end };
}

/**
 * Next rendered count after one sentinel trigger: one more bounded chunk,
 * capped at the total. Idempotent once the list is whole.
 */
export function nextWindowedCount(
  rendered: number,
  total: number,
  pageSize: number = WINDOWED_PAGE_SIZE,
): number {
  return Math.max(0, Math.min(total, rendered + Math.max(1, pageSize)));
}

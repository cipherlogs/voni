"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  WINDOWED_PAGE_SIZE,
  nextWindowedCount,
} from "@/lib/render/windowing";

/**
 * Bounded list window (ticket 09 V1).
 *
 * Renders the first `pageSize` rows up front and grows one chunk per
 * scroll sentinel — same row nodes, same order, no row rewrite. The
 * sentinel is table-valid (`<tr>`) inside a `<TableBody>` when
 * `tableColumns` is set, and list-valid (`<li>`) inside a `<ul>`/`<ol>`
 * otherwise, so the island never introduces the invalid-table-HTML
 * hydration errors the list pages document. It is `aria-hidden` and
 * borderless: a hairline placeholder row, never content.
 *
 * Server leaves pass their already-mapped row nodes in `rows`; this
 * island only decides how many mount. `rows.length` (not identity)
 * resets the window, so typing in the queue search restarts at the top
 * while re-renders of the same list keep the grown window.
 */
export function WindowedRows({
  rows,
  pageSize = WINDOWED_PAGE_SIZE,
  tableColumns,
}: {
  rows: ReactNode[];
  pageSize?: number;
  /** Set inside a `<TableBody>`: the sentinel renders as a row spanning these columns. */
  tableColumns?: number;
}) {
  // Derived during render (never set-state-in-effect): a new list length
  // restarts at the first window, while re-renders of the same list keep
  // the grown window. Same-commit adjustment, no cascading render.
  const [rendered, setRendered] = useState(() =>
    Math.min(pageSize, rows.length),
  );
  const [prevCount, setPrevCount] = useState(rows.length);
  if (prevCount !== rows.length) {
    setPrevCount(rows.length);
    setRendered(Math.min(pageSize, rows.length));
  }
  const sentinelRef = useRef<HTMLTableRowElement | HTMLLIElement | null>(null);

  // The sentinel subscription is the only effect: external-system
  // wiring (IntersectionObserver), with growth delivered in its callback.
  useEffect(() => {
    if (rendered >= rows.length) return;
    const target = sentinelRef.current;
    if (!target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setRendered((prev) => nextWindowedCount(prev, rows.length, pageSize));
        }
      },
      // Start the next chunk before the user reaches the end, so
      // scrolling never visibly stalls on a half-painted list.
      { rootMargin: "800px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [rendered, rows.length, pageSize]);

  // Explicit conditional: the sentinel mounts only while rows remain
  // culled; a complete list renders whole with no placeholder node.
  const sentinel =
    rendered < rows.length ? (
      tableColumns === undefined ? (
        <li
          ref={sentinelRef as React.Ref<HTMLLIElement>}
          aria-hidden="true"
          data-testid="windowed-sentinel"
          className="h-px list-none border-0 border-t-0 p-0"
        />
      ) : (
        <tr
          ref={sentinelRef as React.Ref<HTMLTableRowElement>}
          aria-hidden="true"
          data-testid="windowed-sentinel"
          className="border-0 hover:bg-transparent"
        >
          <td colSpan={tableColumns} className="h-px border-0 p-0" />
        </tr>
      )
    ) : null;

  return (
    <>
      {rows.slice(0, rendered)}
      {sentinel}
    </>
  );
}

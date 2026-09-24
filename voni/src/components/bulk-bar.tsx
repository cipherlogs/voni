/**
 * The one bulk-action toolbar for selected table rows: sticky to the bottom
 * of the viewport, "N selected" first, actions after. Mount-only arrival via
 * `status-enter`; unmount stays instant so a stale selection never lingers.
 */
export function BulkBar({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      className="bg-card status-enter sticky bottom-4 z-10 flex flex-wrap items-center gap-2 rounded-lg border p-3 shadow-lg"
    >
      <span className="text-sm font-medium" aria-live="polite">
        {count} selected
      </span>
      {children}
    </div>
  );
}

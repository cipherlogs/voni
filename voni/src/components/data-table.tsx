import { cn } from "@/lib/utils";

/**
 * The one list-table frame (blocks.so dashboard-01 customers table): a bordered
 * surface on the page background, an optional toolbar (search, Filter menu,
 * active-filter pills, bulk actions), the table, and an optional `border-t`
 * footer (count + pagination). Pages keep their own columns and queries; with
 * zero rows they pass an `Empty` as children instead of a header-only table.
 */
export function DataTable({
  toolbar,
  footer,
  children,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  toolbar?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className={cn("overflow-hidden rounded-lg border", className)} {...props}>
      {toolbar ? (
        <div className="flex flex-col gap-3 border-b p-3 sm:flex-row sm:flex-wrap sm:items-center">
          {toolbar}
        </div>
      ) : null}
      {children}
      {footer ? (
        <div className="text-muted-foreground flex flex-col gap-3 border-t px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

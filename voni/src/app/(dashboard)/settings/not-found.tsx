import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * Unknown settings section (ticket 02): unknown `[tab]` values reach here
 * via the explicit `notFound()` guards in the section layout and page.
 * Never a dead end — one link back to the landing.
 */
export default function SettingsNotFound() {
  return (
    <div data-testid="settings-not-found" className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Unknown settings section</h1>
        <p className="text-muted-foreground text-sm">
          That settings page does not exist. Pick a section from the landing instead.
        </p>
      </div>
      <Button
        nativeButton={false}
        render={<Link href="/settings" />}
        variant="outline"
        className="w-fit"
      >
        Back to Settings
      </Button>
    </div>
  );
}

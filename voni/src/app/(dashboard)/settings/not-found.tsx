import Link from "next/link";
import { PageHeading } from "@/components/wizard/form-layout";
import { Button } from "@/components/ui/button";

/**
 * Unknown settings section (ticket 02): unknown `[tab]` values reach here
 * via the explicit `notFound()` guards in the section layout and page.
 * Never a dead end — one link back to the landing.
 */
export default function SettingsNotFound() {
  return (
    <div data-testid="settings-not-found" className="flex flex-col gap-4">
      <PageHeading title="Unknown settings section" description="That settings page does not exist. Pick a section from the landing instead." />
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

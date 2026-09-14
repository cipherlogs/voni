"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "@/components/ui/toast";
import { LoadingButton } from "@/components/loading-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { TriangleAlert, Pause, Play } from "lucide-react";
import { setCampaignStatusAction } from "@/app/(dashboard)/campaigns/actions";

/**
 * Activate / pause, with the reason it cannot be activated shown next to the
 * control rather than delivered as a failed click.
 *
 * Activation only makes a campaign's leads eligible for dialing — it does not
 * place calls on its own. The runner previews by default, so it stays an
 * explicit, deliberate action — never a side effect of creating a campaign or
 * importing a list — and the live dial happens on the bridge host.
 */
export function CampaignControls({
  id,
  status,
  activationBlocker,
}: {
  id: string;
  status: "draft" | "active" | "paused" | "completed";
  /** Why activation would fail right now, or null if it would succeed. */
  activationBlocker: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const change = (next: "active" | "paused") =>
    startTransition(async () => {
      setError(null);
      const result = await setCampaignStatusAction(id, next);
      if (!result.ok) {
        setError(result.message);
      } else {
        toast.add({ type: "success", title: next === "active" ? "Campaign activated." : "Campaign paused." });
        router.refresh();
      }
    });

  const running = status === "active";

  // table-02 row-action idiom: the action sits at the row's end with its
  // precondition note inline, matching the list row's Open-button column.
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-3">
        {running ? (
          <LoadingButton variant="outline" size="sm" onClick={() => change("paused")} pending={pending} pendingText="Pausing…" icon={<Pause />}>
            Pause campaign
          </LoadingButton>
        ) : (
          <LoadingButton
            size="sm"
            onClick={() => change("active")}
            disabled={activationBlocker !== null}
            aria-describedby={
              !running && activationBlocker
                ? `campaign-blocker-${id}`
                : undefined
            }
            pending={pending}
            pendingText="Activating…"
            icon={<Play />}
          >
            Activate campaign
          </LoadingButton>
        )}
      </div>
      {!running && activationBlocker ? (
        <p
          id={`campaign-blocker-${id}`}
          role="note"
          className="text-muted-foreground text-right text-sm"
        >
          {activationBlocker}
        </p>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

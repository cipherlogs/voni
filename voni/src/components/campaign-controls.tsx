"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { LoadingButton } from "@/components/loading-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { TriangleAlert, Pause, Play } from "lucide-react";
import { setCampaignStatusAction } from "@/app/(dashboard)/campaigns/actions";

/**
 * Activate / pause, with the reason it cannot be activated shown next to the
 * control rather than delivered as a failed click.
 *
 * Activation is the moment a campaign starts producing real phone calls to real
 * people, so it stays an explicit, deliberate action — never a side effect of
 * creating a campaign or importing a list.
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
        toast.success(next === "active" ? "Campaign activated." : "Campaign paused.");
        router.refresh();
      }
    });

  const running = status === "active";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        {running ? (
          <LoadingButton variant="outline" onClick={() => change("paused")} pending={pending} pendingText="Pausing…" icon={<Pause />}>
            Pause campaign
          </LoadingButton>
        ) : (
          <LoadingButton
            onClick={() => change("active")}
            disabled={activationBlocker !== null}
            pending={pending}
            pendingText="Activating…"
            icon={<Play />}
          >
            Activate campaign
          </LoadingButton>
        )}
        {!running && activationBlocker ? (
          <p className="text-muted-foreground text-sm">{activationBlocker}</p>
        ) : null}
      </div>
      {error ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

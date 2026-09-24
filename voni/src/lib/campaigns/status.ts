import type { StatusTone } from "@/components/status-dot";

/** Campaign status as a StatusDot tone + human label (list and detail). */
export const CAMPAIGN_STATUS: Record<
  "active" | "draft" | "paused" | "completed",
  { tone: StatusTone; label: string }
> = {
  active: { tone: "success", label: "Active" },
  draft: { tone: "neutral", label: "Draft" },
  paused: { tone: "warning", label: "Paused" },
  completed: { tone: "info", label: "Completed" },
};

/** A lead's state inside one campaign queue (queue table + lead detail). */
export function queueStatus(status: string): { tone: StatusTone; label: string } {
  switch (status) {
    case "queued":
      return { tone: "neutral", label: "Queued" };
    case "dialing":
      return { tone: "info", label: "Dialing" };
    case "reached":
      return { tone: "success", label: "Reached" };
    case "exhausted":
      return { tone: "warning", label: "No answer" };
    case "skipped":
      return { tone: "neutral", label: "Skipped" };
    default:
      return { tone: "neutral", label: status };
  }
}

/** A lead's calling consent (leads list, queue, lead detail). */
export function consentStatus(status: string | null): { tone: StatusTone; label: string } {
  if (status === "granted") return { tone: "success", label: "Consented" };
  if (status === "revoked") return { tone: "danger", label: "Opted out" };
  return { tone: "neutral", label: "Unknown" };
}

/** Campaign goal status for a lead (lead + call detail). */
export function goalLabel(status: string | null | undefined): string {
  if (status === "success") return "Reached";
  if (status === "failed") return "Not reached";
  if (status === "active") return "In progress";
  return "Not recorded";
}

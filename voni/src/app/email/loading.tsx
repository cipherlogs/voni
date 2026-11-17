import { GateSkeleton } from "@/components/email-gate-skeleton";

/**
 * The route fallback for `/email`. It renders the gate's shape, not the panel's:
 * this file runs before the page can tell an unlocked visitor from a locked one,
 * and a locked visitor must never be shown panel chrome (`page.tsx`'s
 * `EmailGateScreen` documents the same rule). The panel fallback,
 * `PanelSkeleton`, lives inside `page.tsx`, behind the gate.
 */
export default function EmailControlLoading() {
  return <GateSkeleton />;
}

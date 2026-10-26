import { FlatFormSkeleton } from "@/components/page-skeletons";

export default function SettingsTabLoading() {
  return (
    <div role="status" aria-label="Loading settings section">
      {/* No params reach a loading boundary, so this is the dominant
          section shape (flat form); the BackLink + heading stay mounted in
          the section layout shell, and that shell keeps the per-tab
          skeleton for its own Suspense leaf. */}
      <FlatFormSkeleton />
    </div>
  );
}

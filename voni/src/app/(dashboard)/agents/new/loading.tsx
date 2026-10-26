import { NewAgentSkeleton } from "@/components/page-skeletons";

export default function NewAgentLoading() {
  return (
    <div role="status" aria-label="Loading agent creator">
      {/* Same skeleton the page streams inside its own Suspense leaf, so the
          loading boundary and the in-page fallback read as one shell. */}
      <NewAgentSkeleton />
    </div>
  );
}

import { Suspense } from "react";
import { PhoneNumbers } from "@/components/phone-numbers";
import { RouteBrief } from "@/components/copilot/route-brief";
import { Skeleton } from "@/components/ui/skeleton";
import { listPhoneNumbers } from "./actions";
import { listAgentOptions } from "../campaigns/actions";

/**
 * Numbers + agent options leaf: assignment controls resolve after the
 * management-structure shell.
 */
async function NumbersData() {
  const [numbers, agents] = await Promise.all([
    listPhoneNumbers(),
    listAgentOptions(),
  ]);
  return <PhoneNumbers numbers={numbers} agents={agents} />;
}

export default function NumbersPage() {
  return (
    <div data-testid="numbers-shell" className="flex flex-col gap-6">
      <RouteBrief
        route="/numbers"
        brief="Phone numbers mapped to agents for inbound calls. Voice reads here."
      />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Phone numbers</h1>
        <p className="text-muted-foreground text-sm">
          Which agent picks up when someone calls one of your numbers.
        </p>
      </div>
      <Suspense
        fallback={
          <div role="status" aria-label="Loading phone numbers" className="flex flex-col gap-6">
            <div className="max-w-xl">
              <div className="flex flex-col gap-2">
                <Skeleton className="h-5 w-36" />
                <Skeleton className="h-4 w-full max-w-xs" />
              </div>
              <div className="mt-4 flex flex-col gap-4">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-1/2" />
              </div>
            </div>
            <div className="rounded-lg border p-4">
              <div className="flex flex-col gap-4">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            </div>
          </div>
        }
      >
        <NumbersData />
      </Suspense>
    </div>
  );
}

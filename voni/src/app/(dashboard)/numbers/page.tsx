import { Suspense } from "react";
import { PageHeading } from "@/components/wizard/form-layout";
import { PhoneNumbers } from "@/components/phone-numbers";
import { RouteBrief } from "@/components/copilot/route-brief";
import {
  FlatFormSectionSkeleton,
  TableSkeleton,
} from "@/components/page-skeletons";
import { Separator } from "@/components/ui/separator";
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
      <PageHeading title="Phone numbers" description="Which agent picks up when someone calls one of your numbers." />
      <Suspense
        fallback={
          <div role="status" aria-label="Loading phone numbers" className="flex flex-col gap-6">
            <FlatFormSectionSkeleton rows={3} />
            <Separator />
            <TableSkeleton rows={4} columns={4} />
          </div>
        }
      >
        <NumbersData />
      </Suspense>
    </div>
  );
}

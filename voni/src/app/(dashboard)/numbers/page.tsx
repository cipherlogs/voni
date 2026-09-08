import { PhoneNumbers } from "@/components/phone-numbers";
import { RouteBrief } from "@/components/copilot/route-brief";
import { listPhoneNumbers } from "./actions";
import { listAgentOptions } from "../campaigns/actions";

export default async function NumbersPage() {
  const [numbers, agents] = await Promise.all([
    listPhoneNumbers(),
    listAgentOptions(),
  ]);

  return (
    <div className="flex flex-col gap-6">
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
      <PhoneNumbers numbers={numbers} agents={agents} />
    </div>
  );
}

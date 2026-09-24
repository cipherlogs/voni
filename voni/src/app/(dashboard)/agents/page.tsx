import { Suspense } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/data-table";
import { StatusDot } from "@/components/status-dot";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeading } from "@/components/wizard/form-layout";
import { Bot, Plus } from "lucide-react";
import { TableSkeleton } from "@/components/page-skeletons";
import { listAgentsWithGeneration } from "./actions";
import { LiveAgentsRefresh } from "./live-agents-refresh";
import { RecordRowActions } from "@/components/record-row-actions";
import type { AgentConfig } from "@/lib/agents/config";
import { RouteBrief } from "@/components/copilot/route-brief";

/**
 * Authorized list leaf: count-based brief and rows resolve after the shell.
 */
async function AgentsList() {
  const rows = await listAgentsWithGeneration();

  return (
    <>
      <RouteBrief
        route="/agents"
        brief={`Agent library: ${rows.length} saved agents. New agents are built on the creation screen.`}
      />
      {rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="feature">
              <Bot />
            </EmptyMedia>
            <EmptyTitle>No agents yet</EmptyTitle>
            <EmptyDescription>
              Describe what you want an agent to accomplish and we&apos;ll
              generate a starting configuration.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              nativeButton={false}
              render={<Link href="/agents/new" />}
              variant="outline"
            >
              Create your first agent
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <DataTable>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead className="hidden sm:table-cell">Status</TableHead>
                <TableHead className="hidden md:table-cell">Config</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((agent) => {
                const config = agent.config as AgentConfig;
                // The status derives from the live job, never a stored flag.
                // A placeholder whose job aged out reads as a plain draft.
                const gen =
                  agent.generationJobId && agent.generationStatus
                    ? {
                        jobId: agent.generationJobId,
                        running:
                          agent.generationStatus === "queued" ||
                          agent.generationStatus === "running",
                        ready: agent.generationStatus === "succeeded",
                      }
                    : null;
                // Ready to review opens the /agents/new?job= review; failed
                // rows open the detail page's review state, not the stub.
                const openHref = gen?.ready
                  ? `/agents/new?job=${gen.jobId}`
                  : `/agents/${agent.id}`;
                // Until an agent is registered with AssemblyAI it can't take
                // a call, so the list never implies everything is live.
                const status = gen
                  ? gen.running
                    ? { tone: "info" as const, label: "Generating…" }
                    : gen.ready
                      ? { tone: "info" as const, label: "Ready to review" }
                      : { tone: "danger" as const, label: "Generation failed" }
                  : agent.assemblyaiAgentId
                    ? { tone: "success" as const, label: "Deployed and ready" }
                    : { tone: "neutral" as const, label: "Draft — not yet deployed" };
                return (
                  <TableRow key={agent.id}>
                    <TableCell>
                      <div className="flex min-w-0 flex-col gap-1">
                        {/* A running generation owns the row: its stub config
                            would open a broken editor, so the name is plain
                            text (no link) until the job settles. */}
                        {gen?.running ? (
                          <span className="text-sm font-medium">{agent.name}</span>
                        ) : (
                          <Link
                            href={openHref}
                            className="w-fit text-sm font-medium underline-offset-4 hover:underline"
                          >
                            {agent.name}
                          </Link>
                        )}
                        <span className="text-muted-foreground max-w-56 truncate text-sm sm:max-w-xs">
                          {config.mission}
                        </span>
                        {/* Phones: status folds under the name so the row
                            never scrolls sideways. */}
                        <StatusDot tone={status.tone} className="sm:hidden">
                          {status.label}
                        </StatusDot>
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <StatusDot tone={status.tone}>{status.label}</StatusDot>
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden text-sm md:table-cell">
                      {gen && !gen.ready ? (
                        gen.running ? (
                          "Configuration generating…"
                        ) : (
                          "Open to review the error and retry."
                        )
                      ) : (
                        <span className="flex flex-wrap gap-2">
                          <span>{config.tools.length} tools</span>
                          <span>·</span>
                          <span>{config.detect.length} fields captured</span>
                          <span>·</span>
                          <span>{config.channels.join(", ")}</span>
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {/* The job owns the row only while active — terminal
                          placeholders and drafts can be opened and deleted. */}
                      {gen?.running ? null : (
                        <RecordRowActions
                          kind="agent"
                          id={agent.id}
                          name={agent.name}
                          openHref={openHref}
                          openLabel={gen ? "Review" : "Edit"}
                          // Keyed off assemblyaiAgentId presence, not
                          // deploymentStatus: queued/deploying/failed
                          // first-deploys have no remote agent yet, so they
                          // get the short copy too.
                          neverProvisioned={!agent.assemblyaiAgentId}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </DataTable>
      )}
    </>
  );
}

export default function AgentsPage() {
  return (
    <div data-testid="agents-shell" className="flex flex-col gap-6">
      <PageHeading
        title="Agents"
        description="Reusable AI workers with a mission, rules, tools, and channels."
        actions={
          <Button nativeButton={false} render={<Link href="/agents/new" />}>
            <Plus />
            New agent
          </Button>
        }
      />

      <Suspense
        fallback={
          <div role="status" aria-label="Loading agents">
            <TableSkeleton />
          </div>
        }
      >
        <AgentsList />
      </Suspense>
      {/* Refreshes the RSC rows when a generation/deployment settles. */}
      <LiveAgentsRefresh />
    </div>
  );
}

import { Suspense } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { AgentDeleteButton } from "./delete-agent-button";
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
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Config</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((agent) => {
                const config = agent.config as AgentConfig;
                // The badge derives from the live job, never a stored flag. A
                // placeholder whose job aged out reads as a plain draft.
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
                const openLabel = `${gen ? "Review" : "Edit"} ${agent.name}`;
                return (
                  <TableRow key={agent.id}>
                    <TableCell>
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="text-pretty text-sm font-medium">
                          {agent.name}
                        </span>
                        <span className="text-muted-foreground max-w-xs truncate text-sm">
                          {config.mission}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {gen ? (
                        <Badge
                          variant={
                            gen.ready
                              ? "default"
                              : agent.generationStatus === "failed" ||
                                  agent.generationStatus === "cancelled"
                                ? "destructive"
                                : "secondary"
                          }
                        >
                          {gen.running
                            ? "Generating…"
                            : gen.ready
                              ? "Ready to review"
                              : "Generation failed"}
                        </Badge>
                      ) : (
                        /* Until an agent is registered with AssemblyAI it can't
                           take a call, so surface that state rather than
                           letting the list imply everything is live. */
                        <Badge
                          variant={
                            agent.assemblyaiAgentId ? "secondary" : "outline"
                          }
                        >
                          {agent.assemblyaiAgentId
                            ? "Deployed and ready"
                            : "Draft — not yet deployed"}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
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
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {/* A running generation owns the row: its stub config
                            would open a broken editor, so Open stays disabled
                            (no link) until the job settles. Ready to review
                            opens the /agents/new?job= review; failed rows link
                            to the detail page's review state, not the stub. */}
                        {gen?.running ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled
                            aria-disabled="true"
                            aria-label={openLabel}
                          >
                            Open
                          </Button>
                        ) : (
                          <Button
                            nativeButton={false}
                            variant="outline"
                            size="sm"
                            render={
                              <Link
                                href={
                                  gen?.ready
                                    ? `/agents/new?job=${gen.jobId}`
                                    : `/agents/${agent.id}`
                                }
                                aria-label={openLabel}
                              />
                            }
                          >
                            Open
                          </Button>
                        )}
                        {/* The job owns the row only while active — terminal
                            placeholders and drafts can be deleted. Each row's
                            button owns its own pending state. */}
                        {gen?.running ? null : (
                          <AgentDeleteButton
                            id={agent.id}
                            name={agent.name}
                            // Keyed off assemblyaiAgentId presence, not
                            // deploymentStatus: queued/deploying/failed
                            // first-deploys have no remote agent yet, so they
                            // get the short copy too.
                            neverProvisioned={!agent.assemblyaiAgentId}
                          />
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
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

import { Suspense } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bot, Plus } from "lucide-react";
import { CardListSkeleton } from "@/components/page-skeletons";
import { listAgentsWithGeneration } from "./actions";
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
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <Bot className="text-muted-foreground size-10" />
            <div>
              <p className="font-medium">No agents yet</p>
              <p className="text-muted-foreground text-sm">
                Describe what you want an agent to accomplish and we&apos;ll
                generate a starting configuration.
              </p>
            </div>
            <Button
              nativeButton={false}
              render={<Link href="/agents/new" />}
              variant="outline"
            >
              Create your first agent
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((agent) => {
            const config = agent.config as AgentConfig;
            // Placeholder rows link to the detail page like real rows — the
            // detail handles the review state. The badge derives from the
            // live job, never a stored flag. A placeholder whose job aged
            // out reads as a plain draft.
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
            return (
              <Card key={agent.id} className="relative transition-colors hover:bg-muted/50">
                <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
                  <Link
                    href={`/agents/${agent.id}`}
                    aria-label={`${gen ? "Review" : "Edit"} ${agent.name}`}
                    className="before:absolute before:inset-0 min-w-0 flex-1"
                  >
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="flex items-center gap-2">
                        <span className="font-medium">{agent.name}</span>
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
                            agent.assemblyaiAgentId
                              ? "secondary"
                              : "outline"
                          }
                        >
                          {agent.assemblyaiAgentId
                            ? "Deployed and ready"
                            : "Draft — not yet deployed"}
                        </Badge>
                        )}
                      </span>
                      <span className="text-muted-foreground truncate text-sm">
                        {config.mission}
                      </span>
                      {gen && !gen.ready ? (
                        <span className="text-muted-foreground text-xs">
                          {gen.running
                            ? "Configuration generating…"
                            : "Open to review the error and retry."}
                        </span>
                      ) : (
                      <span className="text-muted-foreground flex flex-wrap gap-2 text-xs">
                        <span>{config.tools.length} tools</span>
                        <span>·</span>
                        <span>{config.detect.length} fields captured</span>
                        <span>·</span>
                        <span>{config.channels.join(", ")}</span>
                      </span>
                      )}
                    </span>
                  </Link>
                  {/* Sibling of the stretched link, stacked above its overlay
                      (relative z-10), so the button stays clickable while the
                      rest of the card navigates. The job owns the row only
                      while active — terminal placeholders and drafts can be
                      deleted. */}
                  {gen?.running ? null : (
                    <div className="relative z-10 flex shrink-0 items-center">
                      <AgentDeleteButton
                        id={agent.id}
                        name={agent.name}
                        // Keyed off assemblyaiAgentId presence, not
                        // deploymentStatus: queued/deploying/failed
                        // first-deploys have no remote agent yet, so they
                        // get the short copy too.
                        neverProvisioned={!agent.assemblyaiAgentId}
                      />
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}

export default function AgentsPage() {
  return (
    <div data-testid="agents-shell" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
          <p className="text-muted-foreground text-sm">
            Reusable AI workers with a mission, rules, tools, and channels.
          </p>
        </div>
        <Button nativeButton={false} render={<Link href="/agents/new" />}>
          <Plus />
          New agent
        </Button>
      </div>

      <Suspense
        fallback={
          <div role="status" aria-label="Loading agents">
            <CardListSkeleton />
          </div>
        }
      >
        <AgentsList />
      </Suspense>
    </div>
  );
}

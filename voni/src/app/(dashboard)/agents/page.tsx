import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bot, Plus } from "lucide-react";
import { listAgents } from "./actions";
import type { AgentConfig } from "@/lib/agents/config";
import { RouteBrief } from "@/components/copilot/route-brief";

export default async function AgentsPage() {
  const rows = await listAgents();

  return (
    <div className="flex flex-col gap-6">
      <RouteBrief
        route="/agents"
        brief={`Agent library: ${rows.length} saved agents. New agents are built on the creation screen.`}
      />
      <div className="flex items-center justify-between">
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

      {rows.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <Bot className="text-muted-foreground h-10 w-10" />
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
            return (
              <Card key={agent.id}>
                <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{agent.name}</span>
                      {/* Until an agent is registered with AssemblyAI it can't
                          take a call, so surface that state rather than
                          letting the list imply everything is live. */}
                      <Badge
                        variant={
                          agent.assemblyaiAgentId ? "default" : "secondary"
                        }
                      >
                        {agent.assemblyaiAgentId ? "Published" : "Draft"}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground truncate text-sm">
                      {config.mission}
                    </p>
                    <div className="text-muted-foreground flex flex-wrap gap-2 text-xs">
                      <span>{config.tools.length} tools</span>
                      <span>·</span>
                      <span>{config.detect.length} fields captured</span>
                      <span>·</span>
                      <span>{config.channels.join(", ")}</span>
                    </div>
                  </div>
                  <Button
                    nativeButton={false}
                    variant="outline"
                    size="sm"
                    render={<Link href={`/agents/${agent.id}`} />}
                  >
                    Edit
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

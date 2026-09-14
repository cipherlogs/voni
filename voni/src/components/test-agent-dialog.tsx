"use client";

import Link from "next/link";
import { useState } from "react";
import { Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  VoiceCall,
  type VoiceCallStatus,
} from "@/components/voice-call";
import { formatCallStatus } from "@/lib/calls/call-status";
import type { AgentConfig } from "@/lib/agents/config";

const IDLE_STATUS: VoiceCallStatus = {
  state: "idle",
  elapsed: 0,
  toolActive: false,
};

function callStatusLabel(status: VoiceCallStatus) {
  if (status.state === "idle") return "Ready to test";
  if (status.state === "connecting") return "Connecting";
  if (status.state === "ended") {
    return `Call ended · ${formatCallStatus(status.elapsed)}`;
  }
  if (status.toolActive) return "Looking that up";
  return `${formatCallStatus(status.elapsed)} · ${status.state}`;
}

export function TestAgentDialog({
  agentId,
  name,
  config,
  isDirty,
  canTest,
}: {
  agentId: string;
  name: string;
  config: AgentConfig;
  isDirty: boolean;
  canTest: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<VoiceCallStatus>(IDLE_STATUS);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setStatus(IDLE_STATUS);
      }}
    >
      <DialogTrigger
        render={
          <Button type="button" variant="outline" className="cursor-pointer" />
        }
      >
        <Mic aria-hidden="true" />
        Test agent
      </DialogTrigger>
      <DialogContent
        data-testid="test-agent-dialog"
        className="inset-0 top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 ring-0 sm:max-w-none"
      >
        <DialogHeader className="shrink-0 border-b px-4 py-4 pr-14 md:px-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <DialogTitle className="truncate text-lg">Test {name}</DialogTitle>
              <DialogDescription className="truncate">
                {config.identity.role || "Voice agent"}
              </DialogDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={isDirty ? "outline" : "secondary"}>
                {isDirty ? "Testing unsaved edits" : "Testing saved version"}
              </Badge>
              <Badge variant="secondary" aria-live="polite">
                {canTest ? callStatusLabel(status) : "Generation not ready"}
              </Badge>
            </div>
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 bg-muted/30 p-3 md:p-6">
          <div className="mx-auto size-full max-w-2xl">
            {canTest && open ? (
              <VoiceCall
                key={config.voiceId}
                mode={{ kind: "inline", config, agentId, isDirty }}
                presentation="dialog"
                onStatusChange={setStatus}
              />
            ) : (
              <Empty className="h-full rounded-xl border bg-card">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Mic />
                  </EmptyMedia>
                  <EmptyTitle>Test call not ready</EmptyTitle>
                  <EmptyDescription>
                    The generated voice and language are still placeholders.
                    Start a call after generation finishes.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button
                    nativeButton={false}
                    size="sm"
                    variant="outline"
                    render={<Link href="/jobs" />}
                  >
                    View progress in Jobs
                  </Button>
                </EmptyContent>
              </Empty>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

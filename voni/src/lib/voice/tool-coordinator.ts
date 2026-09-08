import type { ToolResponse } from "@/lib/tools/execute";

type ToolCall = {
  type: "tool.call";
  call_id: string;
  name: string;
  arguments: unknown;
};

type Pending = {
  callId: string;
  replyId: string | null;
  mode: "interactive" | "hold";
  result?: ToolResponse;
};

export type ToolCoordinatorOptions = {
  send: (message: Record<string, unknown>) => void;
  execute: (call: {
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<ToolResponse>;
  modeFor: (name: string) => "interactive" | "hold";
  /**
   * Fires when a tool call goes from none-in-flight to at-least-one, and back
   * to none — so the UI can show something ("Looking that up…") during a
   * `hold`-mode pause instead of looking frozen.
   */
  onActivityChange?: (active: boolean) => void;
};

function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  throw new Error("Tool arguments must be a JSON object.");
}

export class ToolCoordinator {
  private currentReplyId: string | null = null;
  private latestEvent: string | null = null;
  private pending = new Map<string, Pending>();
  private discarded = new Set<string>();
  private active = false;

  constructor(private options: ToolCoordinatorOptions) {}

  private notifyActivity() {
    const next = this.pending.size > 0;
    if (next === this.active) return;
    this.active = next;
    this.options.onActivityChange?.(next);
  }

  onReplyStarted(replyId: string | null) {
    this.currentReplyId = replyId;
    this.latestEvent = "reply.started";
  }

  onInputSpeechStarted() {
    this.latestEvent = "input.speech.started";
  }

  onReplyDone(replyId: string | null, interrupted: boolean) {
    this.latestEvent = "reply.done";
    if (interrupted) {
      for (const callId of this.pending.keys()) {
        this.pending.delete(callId);
        this.discarded.add(callId);
      }
      this.notifyActivity();
      return;
    }
    this.flushInteractive();
  }

  onToolCall(event: ToolCall) {
    const mode = this.options.modeFor(event.name);
    this.pending.set(event.call_id, {
      callId: event.call_id,
      replyId: this.currentReplyId,
      mode,
    });
    this.notifyActivity();

    void (async () => {
      let result: ToolResponse;
      try {
        const args = parseArguments(event.arguments);
        result = await this.options.execute({
          callId: event.call_id,
          name: event.name,
          arguments: args,
        });
      } catch (error) {
        result = {
          ok: false,
          error:
            error instanceof Error ? error.message : "The tool call failed.",
          retryable: false,
        };
      }
      if (this.discarded.delete(event.call_id)) return;
      const item = this.pending.get(event.call_id);
      if (!item) return;
      item.result = result;
      if (item.mode === "hold") {
        this.sendResult(item);
      } else {
        // The tool may finish after reply.done. Flush from the completion path
        // too, but only while reply.done is still the latest event.
        this.flushInteractive();
      }
    })();
  }

  clear() {
    this.pending.clear();
    this.discarded.clear();
    this.notifyActivity();
  }

  private flushInteractive() {
    if (this.latestEvent !== "reply.done") return;
    for (const item of [...this.pending.values()]) {
      if (
        item.mode === "interactive" &&
        item.result
      ) {
        this.sendResult(item);
      }
    }
  }

  private sendResult(item: Pending) {
    if (!item.result) return;
    this.options.send({
      type: "tool.result",
      call_id: item.callId,
      result: JSON.stringify(item.result),
      is_error: !item.result.ok,
    });
    this.pending.delete(item.callId);
    this.notifyActivity();
  }
}

import type { ToolResponse } from "@/lib/tools/execute";

type ToolCall = {
  type: "tool.call";
  call_id: string;
  name: string;
  arguments: unknown;
};

type Pending = { callId: string; name: string };

export type ToolCoordinatorOptions = {
  send: (message: Record<string, unknown>) => void;
  execute: (call: {
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<ToolResponse>;
  /**
   * Hold this tool's result until the current reply is done. For end_call:
   * a result sent mid-goodbye makes the platform cut the goodbye's audio
   * (measured ~0.7s of a ~6s line) and speak it again in a new reply.
   */
  holdUntilReplyDone?: (name: string) => boolean;
  /** A result was just held (the session watches for a platform that waits on it). */
  onHeld?: () => void;
  /**
   * Fires with every tool result as it is sent back to the agent — so the
   * session can react to call-control tools (end_call arms the hangup) as
   * well as show activity. Fires before the pending entry is dropped.
   */
  onResult?: (name: string, result: ToolResponse) => void;
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

/**
 * Runs the agent's tool calls and sends each result back the moment it is
 * ready, in both execution modes. The docs' client-tools page says to hold
 * interactive results until reply.done, but the server holds the calling
 * reply open until the result arrives, so holding deadlocks until the tool
 * times out (measured live, 2026-09-27; sess_c477d8f8 stalled 5s, then the
 * model invented the missing answer). An interrupted reply still drops its
 * pending results: the agent has moved on. The one exception is
 * `holdUntilReplyDone` (end_call), measured the other way round: held until
 * its reply is done, then sent whether or not that reply was cut.
 */
export class ToolCoordinator {
  private pending = new Map<string, Pending>();
  private discarded = new Set<string>();
  private held: { item: Pending; result: ToolResponse }[] = [];
  private active = false;

  constructor(private options: ToolCoordinatorOptions) {}

  private notifyActivity() {
    const next = this.pending.size > 0;
    if (next === this.active) return;
    this.active = next;
    this.options.onActivityChange?.(next);
  }

  onReplyDone(interrupted: boolean) {
    // Held results go out either way: the platform waits for them, and never
    // sending one stalled the next reply until the tool timed out. The
    // session decides what a result means once its reply was cut.
    const held = this.held;
    this.held = [];
    for (const { item, result } of held) this.sendResult(item, result);
    if (!interrupted) return;
    // Still-running calls are marked so their late results are dropped.
    for (const callId of this.pending.keys()) {
      this.pending.delete(callId);
      this.discarded.add(callId);
    }
    this.notifyActivity();
  }

  onToolCall(event: ToolCall) {
    this.pending.set(event.call_id, { callId: event.call_id, name: event.name });
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
      if (this.options.holdUntilReplyDone?.(item.name)) {
        this.held.push({ item, result });
        this.options.onHeld?.();
      } else this.sendResult(item, result);
    })();
  }

  /** Send held results now: the platform turned out to be waiting for them. */
  releaseHeld() {
    const held = this.held;
    this.held = [];
    for (const { item, result } of held) this.sendResult(item, result);
  }

  /** A call is running or its result is held: the platform's turn isn't over. */
  busy(): boolean {
    return this.pending.size > 0;
  }

  hasHeld(): boolean {
    return this.held.length > 0;
  }

  /** Whether a held result is this tool's (end_call keeps its own release timing). */
  holds(name: string): boolean {
    return this.held.some((h) => h.item.name === name);
  }

  clear() {
    this.held = [];
    this.pending.clear();
    this.discarded.clear();
    this.notifyActivity();
  }

  private sendResult(item: Pending, result: ToolResponse) {
    this.options.send({
      type: "tool.result",
      call_id: item.callId,
      result: JSON.stringify(result),
      is_error: !result.ok,
    });
    this.options.onResult?.(item.name, result);
    this.pending.delete(item.callId);
    this.notifyActivity();
  }
}

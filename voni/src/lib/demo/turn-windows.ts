/**
 * One formatter for a turn-window object, so the end-of-turn detail and the
 * inspect report can never drift. `full` names the wire keys
 * (`min_silence 400, …`); `short` is the compact report form (`min 400 / …`).
 */
import type { DemoTurnWindows } from "./stored-agents";

export type TurnWindowLabels = "full" | "short";

export function formatTurnWindows(
  windows: DemoTurnWindows | null,
  options: {
    labels?: TurnWindowLabels;
    separator?: string;
    /** Text for null or an object with no windows; the short form prints nothing. */
    empty?: string;
  } = {},
): string {
  const empty = options.empty ?? "no windows recorded";
  if (!windows) return empty;
  const labels =
    options.labels === "short"
      ? { min_silence: "min", max_silence: "max" }
      : { min_silence: "min_silence", max_silence: "max_silence" };
  const parts: string[] = [];
  if (windows.min_silence !== undefined) parts.push(`${labels.min_silence} ${windows.min_silence}`);
  if (windows.max_silence !== undefined) parts.push(`${labels.max_silence} ${windows.max_silence}`);
  if (windows.interruption_delay !== undefined) {
    parts.push(`interruption_delay ${windows.interruption_delay}`);
  }
  return parts.length > 0 ? parts.join(options.separator ?? ", ") : empty;
}

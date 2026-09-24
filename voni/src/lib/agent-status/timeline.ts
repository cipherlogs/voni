/** One row of an agent's deployment timeline (lib/agent-status/build-entries). */
export type TimelineState = "done" | "current" | "upcoming" | "error" | "neutral";

export interface TimelineEntry {
  id: string;
  state: TimelineState;
  title: string;
  description: string;
  /** Optional: omitted entries render no timestamp rather than an invented one. */
  time?: string;
}

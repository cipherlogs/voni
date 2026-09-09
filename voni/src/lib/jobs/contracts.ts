export type JobMessage = { jobId: string; kind: string };

export type DispatchResult = {
  state: "dispatched" | "recovery-pending" | "inline";
  channel: "queue" | "wait-until" | "cron" | "inline";
};

/** Provider-neutral wake-up boundary. Postgres remains the source of truth. */
export interface JobDispatcher {
  dispatch(message: JobMessage): Promise<DispatchResult>;
}

/** Provider-neutral execution boundary used by queues, cron, and operator DR. */
export interface JobExecutor {
  execute(jobId: string): Promise<void>;
}

/** Private, temporary blob storage used by CSV imports. */
export interface StagedBlobStore {
  put(key: string, value: ArrayBuffer | string): Promise<void>;
  read(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

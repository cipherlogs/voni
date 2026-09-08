/**
 * Voice bindings for durable jobs: schedule, status, retry, cancel.
 *
 * Scheduling is interactive + proposal-first and returns durable acceptance
 * (202 + job id) without waiting for completion. The schedule payload freezes
 * its idempotency key at propose time, so an uncertain submission reconciles
 * (lookup by key → adopt) or resubmits identically — never duplicates.
 *
 * P2 scope: agent generation + integration tests. CSV import scheduling waits
 * for a trusted user-selected upload registry (P3) — the model must never
 * invent file contents or storage keys.
 */

import { z } from "zod";
import { ExecutorFailure, type Executor } from "./bus";

export const scheduleKindSchema = z.enum(["agent_generation", "integration_test"]);

export const proposeScheduleArgs = z
  .object({
    kind: scheduleKindSchema,
    brief: z.string().trim().min(10).max(4000).optional(),
    service: z
      .enum(["groq", "cerebras", "gemini", "openrouter", "assemblyai", "telnyx", "cartesia"])
      .optional(),
  })
  .refine(
    (value) =>
      (value.kind === "agent_generation" && !!value.brief) ||
      (value.kind === "integration_test" && !!value.service),
    { message: "Generation needs a brief; connection tests need a service." },
  );

export type ProposeScheduleArgs = z.infer<typeof proposeScheduleArgs>;

export const schedulePayloadSchema = z.object({
  kind: scheduleKindSchema,
  title: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(8).max(120),
});

export type SchedulePayload = z.infer<typeof schedulePayloadSchema>;

export function buildScheduleProposal(args: ProposeScheduleArgs): {
  title: string;
  input: Record<string, unknown>;
  summary: string;
  keyPhrases: string[];
} {
  if (args.kind === "agent_generation") {
    const brief = args.brief as string;
    const title = "Generate agent draft";
    return {
      title,
      input: { brief },
      summary: `Start generating an agent draft in the background: ${brief.slice(0, 80)}`,
      keyPhrases: ["background", "generate agent draft"],
    };
  }
  const service = args.service as string;
  const title = `Test ${service} connection`;
  return {
    title,
    input: { service },
    summary: `Start testing the ${service} connection in the background`,
    keyPhrases: ["background", "test", service],
  };
}

type JobAccept = { jobId: string; targetUrl: string | null; created: boolean };

async function postJob(payload: SchedulePayload): Promise<JobAccept> {
  const res = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: payload.kind,
      input: payload.input,
      title: payload.title,
      idempotencyKey: payload.idempotencyKey,
    }),
  });
  if (res.status === 429) {
    throw new ExecutorFailure("Job scheduling is rate-limited right now.", true);
  }
  if (!res.ok) {
    const { error } = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ExecutorFailure(error ?? "That job was rejected.", false);
  }
  const body = (await res.json()) as {
    jobId: string;
    targetUrl?: string | null;
    created?: boolean;
  };
  return { jobId: body.jobId, targetUrl: body.targetUrl ?? null, created: body.created ?? true };
}

async function lookupByKey(key: string): Promise<JobAccept | null> {
  const res = await fetch(`/api/jobs/by-key?key=${encodeURIComponent(key)}`, {
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Lookup failed.");
  const { job } = (await res.json()) as {
    job: { id: string; targetUrl?: string | null };
  };
  return { jobId: job.id, targetUrl: job.targetUrl ?? null, created: false };
}

/**
 * Schedule executor with reconciliation: on transport failure, look the
 * frozen key up before doing anything else. Found → adopt (no duplicate).
 * Absent → resubmit the identical payload once. Lookup failure → unknown.
 */
export const executeScheduleJob: Executor = async (payload) => {
  let parsed: SchedulePayload;
  try {
    parsed = schedulePayloadSchema.parse(payload);
  } catch {
    throw new ExecutorFailure("That job request was malformed.", false);
  }
  try {
    const accepted = await postJob(parsed);
    return {
      result: {
        job_id: accepted.jobId,
        target_url: accepted.targetUrl,
        already_running: !accepted.created,
      },
    };
  } catch (error) {
    if (error instanceof ExecutorFailure) throw error;
    // Transport failure: reconcile before retrying.
    const found = await lookupByKey(parsed.idempotencyKey);
    if (found) {
      return {
        result: {
          job_id: found.jobId,
          target_url: found.targetUrl,
          already_running: true,
        },
      };
    }
    const accepted = await postJob(parsed);
    return {
      result: {
        job_id: accepted.jobId,
        target_url: accepted.targetUrl,
        already_running: !accepted.created,
      },
    };
  }
};

export const jobIdArgs = z.object({ job_id: z.string().min(1).max(120) });

type JobStatus = {
  id: string;
  kind: string;
  status: string;
  title: string;
  targetUrl: string | null;
  errorMessage: string | null;
  result?: unknown;
};

async function readJob(jobId: string): Promise<JobStatus> {
  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
    cache: "no-store",
  });
  if (res.status === 404) {
    throw new ExecutorFailure("No job with that id.", false);
  }
  if (!res.ok) {
    throw new Error("Could not read that job.");
  }
  const { job } = (await res.json()) as {
    job: {
      id: string;
      kind: string;
      status: string;
      title: string;
      targetUrl: string | null;
      errorMessage: string | null;
  result?: unknown;
    };
  };
  return job;
}

async function actOnJob(jobId: string, action: "retry" | "cancel"): Promise<JobStatus> {
  const current = await readJob(jobId);
  const terminal = ["succeeded", "failed", "cancelled"].includes(current.status);
  if (action === "retry" && current.status === "succeeded") {
    throw new ExecutorFailure(`"${current.title}" already succeeded — nothing to retry.`, false);
  }
  if (action === "cancel" && terminal) {
    throw new ExecutorFailure(`"${current.title}" already finished — nothing to cancel.`, false);
  }
  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (res.status === 404) {
    throw new ExecutorFailure("No job with that id.", false);
  }
  if (!res.ok) {
    const { error } = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ExecutorFailure(error ?? `Could not ${action} that job.`, false);
  }
  const { job } = (await res.json()) as { job: JobStatus };
  return job;
}

export const executeRetryJob: Executor = async (payload) => {
  const { job_id } = jobIdArgs.parse(payload);
  const job = await actOnJob(job_id, "retry");
  return { result: { job_id: job.id, status: job.status, title: job.title } };
};

export const executeCancelJob: Executor = async (payload) => {
  const { job_id } = jobIdArgs.parse(payload);
  const job = await actOnJob(job_id, "cancel");
  return { result: { job_id: job.id, status: job.status, title: job.title } };
};

export async function readJobStatus(jobId: string): Promise<{
  status: string;
  title: string;
  target_url: string | null;
  error_message: string | null;
  result?: unknown;
}> {
  const job = await readJob(jobId);
  return {
    status: job.status,
    title: job.title,
    target_url: job.targetUrl,
    error_message: job.errorMessage,
    ...(job.result !== undefined ? { result: job.result } : {}),
  };
}

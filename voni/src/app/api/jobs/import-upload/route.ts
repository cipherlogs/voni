import { NextResponse } from "next/server";
import { getCtx } from "@/lib/session";
import { stageCsv } from "@/lib/jobs/queue";
import { jobToJson } from "@/lib/jobs/serialize";
import { JobStartError, startJob } from "@/lib/jobs/start";

const MAX_BYTES = 2_000_000;

/**
 * Accept a lead CSV as multipart form data, enforce the 2 MB cap, stage the
 * bytes privately (R2 in production, inline in dev), and enqueue parsing.
 * Returns 202 Accepted as soon as the import is durable.
 */
export async function POST(request: Request) {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart file upload." }, { status: 400 });
  }
  const campaignId = form.get("campaignId");
  const file = form.get("file");
  const idempotencyKey = form.get("idempotencyKey");
  if (typeof campaignId !== "string" || !campaignId) {
    return NextResponse.json({ error: "Choose a campaign." }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Choose a CSV file." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "That file is larger than 2 MB. Split it and try again." },
      { status: 400 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "That file is empty." }, { status: 400 });
  }

  try {
    const bytes = await file.arrayBuffer();
    const staged = await stageCsv(ctx.organizationId, crypto.randomUUID(), file.name, bytes);
    const { job } = await startJob(
      ctx,
      "lead_csv_import",
      {
        campaignId,
        fileName: file.name,
        ...staged,
      },
      {
        // Double-submitted uploads (retry, reconnect) resume the same job
        // instead of parsing twice.
        idempotencyKey:
          typeof idempotencyKey === "string" && idempotencyKey
            ? idempotencyKey
            : crypto.randomUUID(),
      },
    );
    return NextResponse.json(
      { jobId: job.id, status: job.status, targetUrl: job.targetUrl, job: jobToJson(job) },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof JobStartError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

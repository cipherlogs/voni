import { NextResponse } from "next/server";
import { secret } from "@/lib/env";
import { isClickReportAuthorized } from "@/lib/email/click-report";
import {
  POOL_REPORT_PRODUCER,
  parsePoolReport,
  parsePoolReportRunnerOs,
} from "@/lib/email/pool-report";
import { persistPoolReport } from "./writer";

/**
 * Machine-to-machine intake for the exit-pool report a GitHub runner writes.
 *
 * The client that produces the report listens on that runner's own loopback, so
 * the `/email` card can never reach it after the job ends. This route is how the
 * last known pool reaches the app: the workflow POSTs the artifact and the app
 * keeps the newest report per runner OS.
 *
 * The security model is the click intake's, unchanged: one shared secret from
 * `EMAIL_CLICK_REPORT_SECRET`, compared in constant time, and a streamed body
 * cap that refuses 64 KiB before anything is parsed. A malformed report is a
 * short reason, never the body, and a failed write logs one fixed string.
 * There is no session, no cookie and no cross-origin read.
 *
 * Node runtime, database write only. No route segment config: this app sets
 * `cacheComponents: true`, where Next rejects it.
 */

const NO_STORE = { "Cache-Control": "no-store" } as const;

const SECRET_NAME = "EMAIL_CLICK_REPORT_SECRET";
const SECRET_HEADER = "x-voni-click-secret";
/** The runner names its OS here; the report file itself carries none. */
const RUNNER_OS_HEADER = "x-voni-runner-os";
/** A report is a handful of exits and counters, not an artifact log. */
const MAX_BODY_BYTES = 64 * 1024;
/** Fixed, like the response: a thrown message can quote the target. */
const NOT_STORED_LOG = "tuxler pool report not stored";

function fail(status: number, reason: string): NextResponse {
  return NextResponse.json(
    { ok: false, reason },
    { status, headers: NO_STORE },
  );
}

type BodyRead =
  | { ok: true; text: string }
  | { ok: false; reason: "too_large" | "bad_json" };

/**
 * The cap is a memory bound, so it is enforced while reading. A declared
 * `content-length` cannot be trusted — a chunked body carries none and a lying
 * header carries a small one — so the stream is read chunk by chunk with a
 * running byte count and cancelled the moment it exceeds the cap.
 */
async function readBodyWithinCap(request: Request, limit: number): Promise<BodyRead> {
  const stream = request.body;
  if (stream === null) return { ok: true, text: "" };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    // A broken or aborted stream is bad input, not a size verdict.
    return { ok: false, reason: "bad_json" };
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(joined) };
}

export async function POST(request: Request): Promise<NextResponse> {
  const expected = await secret(SECRET_NAME);
  if (!expected) {
    // No message: naming the variable would tell an anonymous caller the
    // deployment is misconfigured.
    return fail(503, "not_configured");
  }

  if (!isClickReportAuthorized(request.headers.get(SECRET_HEADER), expected)) {
    // One answer for missing and wrong: nothing here tells a caller which.
    return fail(401, "unauthorized");
  }

  const runnerOs = parsePoolReportRunnerOs(request.headers.get(RUNNER_OS_HEADER));
  if (runnerOs === null) {
    return fail(400, "bad_runner_os");
  }

  // A declared oversize body is refused before a single byte is read; the
  // streaming cap covers a chunked or lying header.
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      return fail(413, "too_large");
    }
  }

  const body = await readBodyWithinCap(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return body.reason === "too_large" ? fail(413, "too_large") : fail(400, "bad_json");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return fail(400, "bad_json");
  }

  const report = parsePoolReport(parsed);
  if (!report.ok) {
    return fail(400, report.reason);
  }

  try {
    await persistPoolReport({
      producer: POOL_REPORT_PRODUCER,
      runnerOs,
      report: report.value,
    });
  } catch {
    // A fixed string and nothing else: the payload must never reach the logs.
    console.error(NOT_STORED_LOG);
    return fail(502, "not_stored");
  }

  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}

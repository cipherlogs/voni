import { NextResponse } from "next/server";
import { secret } from "@/lib/env";
import {
  isClickReportAuthorized,
  parseClickReport,
} from "@/lib/email/click-report";
import { persistClickReport } from "./writer";

/**
 * Machine-to-machine intake for the Grafana k6 click check.
 *
 * Security model, stated plainly because this URL is reachable by anyone:
 * the only thing standing between the internet and a write is one shared
 * secret, and that secret lives inside a check script that operators can read
 * on the Grafana box. Treat it as low-privilege — it may append one click row
 * and nothing else, and it must be rotatable by setting a new value and
 * updating the script. The route never returns the secret, compares in
 * constant time, stops reading a body at 4 KiB (streamed, so a chunked or lying
 * `content-length` cannot make it buffer more), and stores only the narrow
 * shape `parseClickReport` accepts. It is not an authenticated user surface: no
 * session, no cookie, no cross-origin read.
 *
 * Node runtime, database write only. There is deliberately no
 * `export const runtime`/`dynamic`/`revalidate`: this app sets
 * `cacheComponents: true`, and Next rejects route segment config there.
 */

const NO_STORE = { "Cache-Control": "no-store" } as const;

const SECRET_NAME = "EMAIL_CLICK_REPORT_SECRET";
const SECRET_HEADER = "x-voni-click-secret";
const MAX_BODY_BYTES = 4096;
/** Fixed, like the response: a thrown message can quote the target. */
const NOT_STORED_LOG = "email click report not stored";

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
 * The cap is a memory bound, so it has to be enforced while reading rather than
 * after. A declared `content-length` cannot be trusted — a chunked body carries
 * none and a lying header carries a small one — so the stream is read chunk by
 * chunk with a running byte count and cancelled the moment it exceeds the cap.
 * Only the bytes actually buffered are decoded.
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

  // A declared oversize body is refused before a single byte is read. The
  // streaming cap in `readBodyWithinCap` is what covers a chunked or lying
  // header.
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

  const report = parseClickReport(parsed);
  if (!report.ok) {
    return fail(400, report.reason);
  }

  try {
    await persistClickReport(report.value);
  } catch {
    // A fixed string and nothing else: the payload must never reach the logs.
    console.error(NOT_STORED_LOG);
    return fail(502, "not_stored");
  }

  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}

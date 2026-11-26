/**
 * The one write the pool-report route performs, behind a seam its test can
 * swap. Mirrors the click intake's writer.
 */
import type { PoolReportInput } from "@/lib/email/pool-report";
import { storePoolReport } from "@/lib/email/pool-report";

export type PoolReportWriter = (input: PoolReportInput) => Promise<void>;

const DEFAULT_WRITER: PoolReportWriter = storePoolReport;

let writer: PoolReportWriter = DEFAULT_WRITER;

/** Test-only seam; passing nothing restores the real writer. */
export function setPoolReportWriter(next?: PoolReportWriter): void {
  writer = next ?? DEFAULT_WRITER;
}

export function persistPoolReport(input: PoolReportInput): Promise<void> {
  return writer(input);
}

/**
 * The one write the report route performs, behind a seam its test can swap.
 *
 * Next only allows a route module to export handlers, so an injectable writer
 * cannot live on `route.ts` itself. Production never calls the setter: the
 * default is the real database write.
 */
import type { ClickReportInput } from "@/lib/email/click-report";
import { recordAffiliateClick } from "@/lib/email/clicks";

export type ClickReportWriter = (input: ClickReportInput) => Promise<void>;

const DEFAULT_WRITER: ClickReportWriter = recordAffiliateClick;

let writer: ClickReportWriter = DEFAULT_WRITER;

/** Test-only seam; passing nothing restores the real writer. */
export function setClickReportWriter(next?: ClickReportWriter): void {
  writer = next ?? DEFAULT_WRITER;
}

export function persistClickReport(input: ClickReportInput): Promise<void> {
  return writer(input);
}

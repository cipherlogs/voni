/**
 * The call id the browser report must carry.
 *
 * The mark artifact is the delivery receipt, not the mint. The id is already
 * signed into the demo call token the mint returned, so a lost marks upload
 * still names the call it lost instead of leaving the report with `null`.
 * The marks artifact's own id is only a fallback for an older report.
 */
import { callIdFromDemoToken } from "@/lib/voice/call-marks";

export function reportCallId(input: {
  readonly mintedDemoCallToken?: string | null;
  readonly marksCallId?: string | null;
}): string | null {
  const minted =
    input.mintedDemoCallToken === undefined || input.mintedDemoCallToken === null
      ? null
      : callIdFromDemoToken(input.mintedDemoCallToken);
  return minted ?? input.marksCallId ?? null;
}

/**
 * Operator sentences for `campaign_leads.last_outcome`.
 *
 * The column stores dispatcher shorthand ("no_answer", "dial
 * cancelled", "requeued after stalled dial") that means nothing to
 * an operator, so it is mapped here at render time — the campaign
 * queue Outcome column and the lead detail "last" line. Storage is
 * untouched and unknown reasons pass through, so a new reason is
 * never blank. Pure, so client components can import it.
 *
 * Policy-verdict reasons (calling window, timezone, consent) are
 * enforced in SQL and normally never reach this column — but
 * `releaseDialClaim` stores an arbitrary reason string, so the map
 * covers those shapes too rather than trusting every future caller
 * to stay within the dial-outcome vocabulary.
 *
 * Dispatcher idle reasons (`nextDialTarget` in `dispatch.ts`) flow through
 * here too, via `dispatchIdleLabel` — the runner logs them to the operator,
 * so the raw shorthand ("no active campaigns", "a call is already in
 * progress") must read as operator sentences for the same reason the dial
 * outcomes do. Campaign-prefixed variants ("Acme: no leads due") map as
 * well: the prefix names the campaign, the suffix names the state.
 */
export function dialOutcomeLabel(
  outcome: string | null | undefined,
): string {
  const raw = (outcome ?? "").trim();
  switch (raw.toLowerCase()) {
    case "":
      return "—";
    case "answered":
      return "Answered — spoke with the lead";
    case "no_answer":
      return "No answer — will retry";
    case "busy":
      return "Line busy — will retry";
    case "failed":
      return "Call failed — will retry";
    case "cancelled":
    case "dial cancelled":
      return "Dial cancelled before the call went out";
    case "requeued after stalled dial":
      return "Recovered after a stalled dial — back in the queue";
    default:
      return policyVerdictLabel(raw) ?? raw;
  }
}

/**
 * Policy-verdict reasons from `policy.ts` (`evaluateCallingWindow`,
 * `evaluateConsent`) rendered as operator sentences.
 *
 * These are exact matches first, then shape matches on the dynamic
 * parts (day name, clock time, window range, timezone, consent
 * status) — the verdicts interpolate values, so a static map alone
 * would miss every one. Returns null when the string is not a
 * policy-verdict shape, so genuinely new reasons still pass through.
 */
/**
 * Dispatcher idle reasons from `dispatch.ts` (`nextDialTarget`) rendered as
 * operator sentences. The idle string is either one of the four bare states
 * or several `"<campaign>: <state>"` fragments joined with "; " — the
 * suffix of each fragment is itself a `policyVerdictLabel` shape (an idle
 * state or a calling-window verdict), so each fragment maps through that
 * one table and keeps its campaign name as the subject. Returns null when
 * no fragment maps, so genuinely new reasons still pass through.
 */
export function dispatchIdleLabel(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const direct = policyVerdictLabel(text);
  if (direct) return direct;
  // "Name: <state>; Name: <state>" — map each fragment's suffix through
  // the same table; an unmapped fragment keeps its raw text so a new
  // state is never blank. The campaign name is the text before the FIRST
  // colon: state shapes themselves contain colons ("08:00 in ...",
  // "consent is ..."), so a greedy split would eat the state.
  if (!text.includes(":")) return null;
  const fragments = text.split(";").map((part) => {
    const fragment = part.trim();
    const colon = fragment.indexOf(":");
    if (colon < 0) return fragment;
    const mapped = policyVerdictLabel(fragment.slice(colon + 1).trim());
    return mapped ? `${fragment.slice(0, colon).trim()} — ${mapped}` : fragment;
  });
  return fragments.some((fragment, index) =>
    fragment !== text.split(";")[index].trim(),
  )
    ? fragments.join("; ")
    : null;
}

function policyVerdictLabel(raw: string): string | null {
  const lower = raw.toLowerCase();
  // Dispatcher idle states (`dispatch.ts`): the same table maps the bare
  // states and, via `dispatchIdleLabel`, their campaign-qualified
  // "<campaign>: <state>" fragments.
  switch (lower) {
    case "no active campaigns":
      return "No active campaigns — activate a campaign to start dialling";
    case "a call is already in progress":
      return "A call is already in progress — the next lead dials when it ends";
    case "agent is not deployed":
      return "The agent is not deployed — publish it before dialling";
    case "no leads due":
      return "No leads due right now — the queue refills when backoff or the calling window opens";
  }
  if (/^calling window \d{2}:\d{2}-\d{2}:\d{2} is not a valid range$/.test(lower)) {
    return "Calling hours are misconfigured — fix the campaign's calling window";
  }
  const unknownZone = /^unknown timezone "(.+)"$/.exec(raw);
  if (unknownZone) {
    return `Unknown calling timezone (${unknownZone[1]}) — check the campaign's calling window`;
  }
  const outsideDay = /^(\w+) is outside the calling days$/.exec(raw);
  if (outsideDay) {
    return `No calling today (${outsideDay[1]}) — outside the campaign's calling days`;
  }
  const outsideHours =
    /^(\d{2}:\d{2}) in (.+) is outside (\d{2}:\d{2}-\d{2}:\d{2})$/.exec(raw);
  if (outsideHours) {
    return `Outside calling hours (${outsideHours[1]}, window ${outsideHours[3]}) — will retry when the window opens`;
  }
  if (lower === "consent revoked") {
    return "Consent withdrawn — do not call";
  }
  const consentShape = /^consent is "(.+)", not granted$/.exec(raw);
  if (consentShape) {
    return `No recorded consent (${consentShape[1]}) — consent needed before calling`;
  }
  return null;
}

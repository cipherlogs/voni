/**
 * What one click row says about the exit it used.
 *
 * Ticket 07 stores `exit_ip`, `exit_country`, `exit_asn`, `proxy_kind` and
 * `failure_reason`; rows written before that have none of them. The table must
 * read both honestly: a pooled row names the address, country and ASN the exit
 * reported, a manual override says so, a failed row names why in the same
 * operator words as the proxy card, and an older row says "No proxy" rather than
 * inventing an address or printing `undefined`.
 *
 * One function, so the click table and any future attribution surface cannot
 * grow two different answers for the same row.
 */
import type { ClickProxyKind } from "./click-report";
import { asnLabel, failureWords } from "./proxy-policy";

export interface ClickExitAttribution {
  /** The one closed set the intake stores. Absent is a row from before it. */
  proxyKind?: ClickProxyKind | null;
  exitIp?: string | null;
  exitCountry?: string | null;
  exitAsn?: string | null;
  /** Why no page was opened, when the click failed before a browser started. */
  failureReason?: string | null;
}

function present(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function describeClickExit(row: ClickExitAttribution): string {
  if (row.proxyKind === "manual") return "Manual proxy";

  const ip = present(row.exitIp);
  // An exit recorded without a kind is still an address the click left from;
  // showing it beats claiming "no proxy" about a row that names one.
  const pooled = row.proxyKind === "pool" || (row.proxyKind == null && ip !== null);
  if (!pooled) {
    // A click that failed before a browser opened has no exit, but it does have
    // a reason; "No proxy" alone would hide why the click never happened.
    const failure = present(row.failureReason);
    return failure === null ? "No proxy" : `No proxy · ${failureWords(failure)}`;
  }
  if (ip === null) {
    // A pooled mission that got no usable lease is still a failed Click: the
    // address is missing *and* the reason is known, so name both.
    const failure = present(row.failureReason);
    return failure === null
      ? "Pool exit (address not recorded)"
      : `Pool exit (address not recorded) · ${failureWords(failure)}`;
  }

  // US is the only country the pool serves, so a missing country is not unknown.
  const country = present(row.exitCountry) ?? "US";
  const asn = asnLabel(present(row.exitAsn));
  return asn === null ? `${ip} · ${country}` : `${ip} · ${country} · ${asn}`;
}

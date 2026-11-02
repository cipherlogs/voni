/**
 * Aggregate one run's priced rows into the vendor ledger.
 *
 * The amounts are the row's own: this module sums `amountUsd` per leg and
 * never multiplies a quantity by a rate. Quantities come from the row's
 * `units` map, so a leg whose unit is absent is unmeasured usage, not zero. A
 * measured row whose total disagrees with its legs, or that hides an unmeasured
 * leg under a measured total, is a torn row and is refused.
 */

import { RateBook } from "./rates";
import { sameUsd, shortRateVersion, sortRateVersions, sumMeasuredLegs, roundUsd } from "./sums";
import {
  LEG_VENDOR,
  UNIT_LINES,
  VENDOR_LABEL,
  VENDORS,
  refuse,
  type LegTotal,
  type ScenarioTotal,
  type UnmeasuredLeg,
  type UsageCall,
  type UsageLedger,
  type UsageLineTotal,
  type UsageRun,
  type VendorId,
  type VendorTotal,
} from "./types";
import type { PricedLeg } from "@/lib/demo/verification/economics";

export type LedgerOptions = {
  /** Rate tables already loaded, or a loader; default reads the committed dir. */
  readonly rates?: RateBook | { get(id: string): ReturnType<RateBook["get"]> };
};

function addTo<K>(map: Map<K, number>, key: K, amount: number): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function addUnique<K>(map: Map<K, Set<string>>, key: K, id: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(id);
  map.set(key, set);
}

/** A measured row must be internally consistent before it can be totalled. */
function assertConsistent(call: UsageCall, legSum: number): void {
  const { priced } = call;
  if (!priced.measured) return;
  if (priced.legs.some((leg) => !leg.measured)) {
    refuse(
      "torn-row",
      `call ${call.callId}: the row claims a measured total but leaves ` +
        `${priced.legs
          .filter((leg) => !leg.measured)
          .map((leg) => `"${leg.leg}"`)
          .join(", ")} unmeasured; a total with an unmeasured leg is a partial sum`,
    );
  }
  if (priced.totalUsd === null) {
    refuse("torn-row", `call ${call.callId}: a measured row carries no total`);
  }
  if (!sameUsd(priced.totalUsd, legSum)) {
    refuse(
      "torn-row",
      `call ${call.callId}: the row's total $${priced.totalUsd.toFixed(6)} does not equal the ` +
        `sum of its legs $${legSum.toFixed(6)}; one of the two is wrong`,
    );
  }
}

function vendorOf(leg: PricedLeg, callId: string): VendorId {
  const vendor = LEG_VENDOR[leg.leg];
  if (vendor === undefined) {
    refuse(
      "unknown-vendor",
      `call ${callId}: leg "${leg.leg}" has no vendor mapping; the ledger will not guess which ` +
        "dashboard bills it",
    );
  }
  return vendor;
}

function unmeasuredPrice(call: UsageCall, leg: PricedLeg, vendor: VendorId): UnmeasuredLeg {
  const reason =
    leg.reasons[0] ??
    call.priced.unmeasuredReason ??
    "the row does not say why this leg is unmeasured";
  const lines = UNIT_LINES.filter((line) => line.leg === leg.leg);
  return {
    callId: call.callId,
    scenario: call.scenario,
    leg: leg.leg,
    vendor,
    lineId: lines.length === 1 ? (lines[0] as (typeof UNIT_LINES)[number]).id : null,
    kind: "price",
    reason,
  };
}

function unmeasuredUsage(call: UsageCall, lineId: string, leg: string, vendor: VendorId, unit: string): UnmeasuredLeg {
  return {
    callId: call.callId,
    scenario: call.scenario,
    leg,
    vendor,
    lineId,
    kind: "usage",
    reason: `the ${leg} leg was priced but units.${unit} is absent from the row`,
  };
}

export function buildLedger(run: UsageRun, options: LedgerOptions = {}): UsageLedger {
  if (run.calls.length === 0) {
    refuse("missing-evidence", `run ${run.runId} carries no calls; there is no usage to total`);
  }
  const rates = options.rates ?? new RateBook();
  const tables = new Map<string, ReturnType<RateBook["get"]>>();
  const tableFor = (version: string) => {
    const cached = tables.get(version);
    if (cached !== undefined) return cached;
    const table = rates.get(version);
    tables.set(version, table);
    return table;
  };

  const legUsd = new Map<string, number>();
  const legPricedCalls = new Map<string, number>();
  const legUnmeasuredCalls = new Map<string, Set<string>>();
  const legVersions = new Map<string, Set<string>>();
  const lineQuantity = new Map<string, number>();
  const lineMeasuredCalls = new Map<string, number>();
  const lineMissingCalls = new Map<string, number>();
  const lineUnmeasuredCalls = new Map<string, number>();
  const lineVersions = new Map<string, Set<string>>();
  const rateVersions = new Set<string>();

  const unmeasured: UnmeasuredLeg[] = [];
  const callComplete = new Map<string, boolean>();
  let zeroCalls = 0;
  let totalUsd = 0;

  for (const call of run.calls) {
    const legSum = sumMeasuredLegs(call.priced.legs);
    assertConsistent(call, legSum);
    totalUsd += legSum;

    const version = call.priced.rateTableVersion;
    if (version !== null) {
      tableFor(version);
      rateVersions.add(version);
    }
    const isZero = call.priced.measured && call.priced.legs.length === 0;
    if (isZero) zeroCalls += 1;

    const presentLegs = new Map(call.priced.legs.map((leg) => [leg.leg, leg]));
    let complete = true;

    for (const leg of call.priced.legs) {
      const vendor = vendorOf(leg, call.callId);
      if (!leg.measured) {
        unmeasured.push(unmeasuredPrice(call, leg, vendor));
        addUnique(legUnmeasuredCalls, leg.leg, call.callId);
        complete = false;
        continue;
      }
      addTo(legUsd, leg.leg, leg.amountUsd ?? 0);
      addTo(legPricedCalls, leg.leg, 1);
      if (version !== null) addUnique(legVersions, leg.leg, version);
    }

    // Every billable line, for every leg the row carries. A missing leg in a
    // measured row is unmeasured, never assumed to have cost zero.
    for (const line of UNIT_LINES) {
      const leg = presentLegs.get(line.leg);
      if (leg === undefined) {
        if (isZero) continue;
        const reason = call.priced.measured
          ? `the measured row records no ${line.leg} leg`
          : `the unmeasured row records no ${line.leg} leg`;
        unmeasured.push({
          callId: call.callId,
          scenario: call.scenario,
          leg: line.leg,
          vendor: line.vendor,
          lineId: line.id,
          kind: "usage",
          reason,
        });
        addTo(lineMissingCalls, line.id, 1);
        addUnique(legUnmeasuredCalls, line.leg, call.callId);
        complete = false;
        continue;
      }
      if (!leg.measured) {
        addTo(lineUnmeasuredCalls, line.id, 1);
        continue; // the price row already names this leg
      }
      const quantity = call.units[line.leg]?.[line.unit];
      if (quantity === undefined) {
        unmeasured.push(unmeasuredUsage(call, line.id, line.leg, line.vendor, line.unit));
        addTo(lineMissingCalls, line.id, 1);
        addUnique(legUnmeasuredCalls, line.leg, call.callId);
        complete = false;
        continue;
      }
      addTo(lineQuantity, line.id, quantity);
      addTo(lineMeasuredCalls, line.id, 1);
      if (version !== null) addUnique(lineVersions, line.id, version);
    }

    callComplete.set(call.callId, complete);
  }

  const lines: UsageLineTotal[] = UNIT_LINES.map((line) => {
    const tableVersions = sortRateVersions(lineVersions.get(line.id) ?? []);
    for (const version of tableVersions) {
      const table = tableFor(version);
      if (!table.rates.has(line.id)) {
        refuse(
          "missing-rate-table",
          `rate table ${table.id} has no line "${line.id}"; the ledger cannot show its unit rate`,
        );
      }
    }
    const single = tableVersions.length === 1 ? tableFor(tableVersions[0] as string) : null;
    const rate = single?.rates.get(line.id);
    const measured = lineMeasuredCalls.get(line.id) ?? 0;
    return {
      id: line.id,
      leg: line.leg,
      vendor: line.vendor,
      unit: line.unit,
      label: line.label,
      note: line.note,
      rateApplies: line.rateApplies,
      quantity: measured === 0 ? null : roundQuantity(lineQuantity.get(line.id) ?? 0),
      measuredCalls: measured,
      missingCalls: lineMissingCalls.get(line.id) ?? 0,
      unmeasuredCalls: lineUnmeasuredCalls.get(line.id) ?? 0,
      // A quantity summed across rate versions cannot carry one version's rate.
      rateUsdPerUnit: rate?.usdPerUnit ?? null,
      rateVersions: tableVersions,
    };
  });

  const legs: LegTotal[] = Object.keys(LEG_VENDOR).map((leg) => {
    const vendor = LEG_VENDOR[leg] as VendorId;
    return {
      leg,
      vendor,
      usd: roundUsd(legUsd.get(leg) ?? 0, 8),
      pricedCalls: legPricedCalls.get(leg) ?? 0,
      unmeasuredCalls: legUnmeasuredCalls.get(leg)?.size ?? 0,
      rateVersions: sortRateVersions(legVersions.get(leg) ?? []),
    };
  });

  const vendors: VendorTotal[] = VENDORS.map((vendor) => {
    const vendorLegs = legs.filter((leg) => leg.vendor === vendor);
    const unmeasuredCalls = new Set<string>();
    for (const leg of vendorLegs) {
      for (const callId of legUnmeasuredCalls.get(leg.leg) ?? []) unmeasuredCalls.add(callId);
    }
    return {
      vendor,
      usd: roundUsd(vendorLegs.reduce((sum, leg) => sum + leg.usd, 0), 8),
      legs: vendorLegs,
      pricedCalls: vendorLegs.reduce((sum, leg) => sum + leg.pricedCalls, 0),
      unmeasuredCalls: unmeasuredCalls.size,
      complete: unmeasuredCalls.size === 0,
    };
  });

  const scenarioKeys = new Map<string, { scenario: string; locale: string | null }>();
  for (const call of run.calls) {
    const key = `${call.scenario}\u0000${call.locale ?? ""}`;
    if (!scenarioKeys.has(key)) scenarioKeys.set(key, { scenario: call.scenario, locale: call.locale });
  }
  const scenarios: ScenarioTotal[] = [...scenarioKeys.values()]
    .map(({ scenario, locale }) => {
      const calls = run.calls.filter(
        (call) => call.scenario === scenario && call.locale === locale,
      );
      let metaUsd = 0;
      let assemblyUsd = 0;
      let unmeasuredCalls = 0;
      const vendorGaps = new Set<string>();
      for (const entry of unmeasured) {
        if (calls.some((call) => call.callId === entry.callId) && entry.vendor !== null) {
          vendorGaps.add(`${entry.callId}\u0000${entry.vendor}`);
        }
      }
      for (const call of calls) {
        metaUsd += sumMeasuredLegs(
          call.priced.legs.filter((leg) => LEG_VENDOR[leg.leg] === "meta"),
        );
        assemblyUsd += sumMeasuredLegs(
          call.priced.legs.filter((leg) => LEG_VENDOR[leg.leg] === "assemblyai"),
        );
        if (callComplete.get(call.callId) === false) unmeasuredCalls += 1;
      }
      const metaComplete = !calls.some((call) => vendorGaps.has(`${call.callId}\u0000meta`));
      const assemblyaiComplete = !calls.some((call) =>
        vendorGaps.has(`${call.callId}\u0000assemblyai`),
      );
      return {
        scenario,
        locale,
        calls: calls.length,
        usd: roundUsd(metaUsd + assemblyUsd, 8),
        metaUsd: roundUsd(metaUsd, 8),
        assemblyaiUsd: roundUsd(assemblyUsd, 8),
        unmeasuredCalls,
        metaComplete,
        assemblyaiComplete,
      };
    })
    .sort((a, b) => a.scenario.localeCompare(b.scenario));

  const expectedCalls = run.expectedCalls;
  if (expectedCalls !== null && run.calls.length > expectedCalls) {
    refuse(
      "torn-row",
      `run ${run.runId} measured ${run.calls.length} calls but plans ${expectedCalls}; ` +
        "a run cannot measure more calls than it planned",
    );
  }
  const planGap =
    expectedCalls !== null && run.calls.length < expectedCalls
      ? `${run.calls.length} of ${expectedCalls} planned calls were measured; ` +
        `${expectedCalls - run.calls.length} have no priced row`
      : null;
  const complete = unmeasured.length === 0 && planGap === null;
  return {
    runId: run.runId,
    source: run.source,
    calls: run.calls,
    vendors,
    legs,
    lines,
    scenarios,
    unmeasured,
    complete,
    totalUsd: roundUsd(totalUsd, 8),
    expectedCalls,
    planGap,
    rateVersions: sortRateVersions(rateVersions),
    zeroCalls,
  };
}

function roundQuantity(quantity: number): number {
  return Math.round((quantity + Number.EPSILON) * 1000) / 1000;
}

function fmtUsd(amount: number): string {
  // The pipeline prices to eight decimals; print them all when they carry a
  // value, but never hide a half-cent behind a six-decimal convenience.
  const fixed = amount.toFixed(8);
  return `$${fixed.endsWith("00") ? fixed.slice(0, -2) : fixed}`;
}

function fmtRate(rate: number | null): string {
  if (rate === null) return "";
  if (rate === 0) return "$0 (sourced zero)";
  const fixed = rate.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  return `$${fixed}/unit`;
}

function fmtQuantity(quantity: number | null): string {
  if (quantity === null) return "unmeasured";
  if (Number.isInteger(quantity)) return quantity.toLocaleString("en-US");
  return Number(quantity.toFixed(3)).toLocaleString("en-US");
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

function legLine(line: UsageLineTotal, indent: string, zeroAll: boolean): string {
  const label = `${line.id}`;
  const zero = zeroAll && line.quantity === null && line.missingCalls === 0;
  const notes: string[] = [];
  if (line.note !== null) notes.push(line.note);
  if (line.missingCalls > 0) {
    notes.push(`${line.missingCalls} call${line.missingCalls === 1 ? "" : "s"} missing this unit`);
  }
  if (line.unmeasuredCalls > 0) {
    notes.push(`${line.unmeasuredCalls} call${line.unmeasuredCalls === 1 ? "" : "s"} unmeasured`);
  }
  const suffix = notes.length === 0 ? "" : ` (${notes.join("; ")})`;
  const quantity =
    line.quantity === null
      ? zero
        ? `0 ${line.label} (measured zero)`
        : "unmeasured"
      : `${fmtQuantity(line.quantity)} ${line.label}${suffix}`;
  const rate =
    line.quantity === null || !line.rateApplies
      ? ""
      : line.rateVersions.length > 1
        ? `mixed ${line.rateVersions.map(shortRateVersion).join("/")}`
        : fmtRate(line.rateUsdPerUnit);
  return `${indent}${pad(label, 24)}${padLeft(quantity, 58)}${padLeft(rate, 24)}`;
}

function legTotal(ledger: UsageLedger, leg: LegTotal, indent: string): string {
  const hasUnmeasured = leg.unmeasuredCalls > 0;
  const amount =
    leg.pricedCalls === 0 && hasUnmeasured
      ? "unmeasured"
      : hasUnmeasured
        ? `${fmtUsd(leg.usd)} partial`
        : leg.pricedCalls === 0 && ledger.zeroCalls > 0
          ? fmtUsd(0)
          : fmtUsd(leg.usd);
  const versions =
    leg.rateVersions.length > 1
      ? `mixed ${leg.rateVersions.map(shortRateVersion).join("/")}`
      : leg.rateVersions.join(", ");
  return `${indent}${pad(`${leg.leg} leg`, 24)}${padLeft(amount, 40)}${versions === "" ? "" : `  ${versions}`}`;
}

function vendorSection(ledger: UsageLedger, vendor: VendorTotal): string[] {
  const lines: string[] = [VENDOR_LABEL[vendor.vendor]];
  const zeroAll = ledger.zeroCalls === ledger.calls.length;
  for (const leg of vendor.legs) {
    const linesForLeg = UNIT_LINES.filter((line) => line.leg === leg.leg).map((line) =>
      legLine(
        ledger.lines.find((entry) => entry.id === line.id) as UsageLineTotal,
        "  ",
        zeroAll,
      ),
    );
    lines.push(...linesForLeg);
    lines.push(legTotal(ledger, leg, "  "));
  }
  const amount =
    vendor.pricedCalls === 0 && vendor.unmeasuredCalls > 0
      ? "unmeasured"
      : vendor.complete
        ? fmtUsd(vendor.usd)
        : `${fmtUsd(vendor.usd)} partial`;
  lines.push(
    `${pad("  vendor total", 26)}${padLeft(amount, 38)}` +
      (vendor.complete ? "" : `  (${vendor.unmeasuredCalls} unmeasured call${vendor.unmeasuredCalls === 1 ? "" : "s"})`),
  );
  return lines;
}

/** One run's ledger as the owner reads it before opening a vendor page. */
export function formatLedger(ledger: UsageLedger): string {
  const lines: string[] = [];
  lines.push(`demo:usage · run ${ledger.runId}`);
  lines.push(`source: ${ledger.source}`);
  lines.push(
    `calls: ${ledger.calls.length} measured · ` +
      `${ledger.expectedCalls === null ? "plan not recorded" : `${ledger.expectedCalls} planned`}` +
      (ledger.zeroCalls > 0 ? ` (${ledger.zeroCalls} measured zero)` : "") +
      (ledger.rateVersions.length === 0 ? "" : ` · rate table${ledger.rateVersions.length === 1 ? "" : "s"} ${ledger.rateVersions.join(", ")}`),
  );
  if (ledger.planGap !== null) lines.push(`plan: ${ledger.planGap}`);
  lines.push("");
  lines.push("VENDORS");
  for (const vendor of ledger.vendors) {
    lines.push(...vendorSection(ledger, vendor));
  }

  lines.push("");
  lines.push("PER SCENARIO");
  lines.push(
    pad("scenario", 34) + padLeft("calls", 7) + padLeft("Meta USD", 14) + padLeft("AssemblyAI USD", 18) + padLeft("total USD", 18),
  );
  for (const scenario of ledger.scenarios) {
    const vendorCell = (usd: number, complete: boolean): string =>
      complete ? fmtUsd(usd) : usd === 0 ? "unmeasured" : `${fmtUsd(usd)}*`;
    lines.push(
      pad(scenario.scenario, 34) +
        padLeft(String(scenario.calls), 7) +
        padLeft(vendorCell(scenario.metaUsd, scenario.metaComplete), 14) +
        padLeft(vendorCell(scenario.assemblyaiUsd, scenario.assemblyaiComplete), 18) +
        padLeft(
          scenario.unmeasuredCalls > 0
            ? scenario.unmeasuredCalls === scenario.calls && scenario.usd === 0
              ? "unmeasured"
              : `${fmtUsd(scenario.usd)}*`
            : fmtUsd(scenario.usd),
          18,
        ),
    );
  }

  lines.push("");
  lines.push("PER CALL");
  lines.push(
    pad("call", 38) +
      pad("scenario", 32) +
      padLeft("stt s", 11) +
      padLeft("llm tok (p/c)", 15) +
      padLeft("tts chars", 12) +
      padLeft("Meta $", 15) +
      padLeft("AAI $", 15) +
      padLeft("total $", 15) +
      "  rates",
  );
  for (const call of ledger.calls) {
    const pricedLegs = new Map(call.priced.legs.map((leg) => [leg.leg, leg]));
    const stt = pricedLegs.get("stt");
    const tts = pricedLegs.get("tts");
    const llm = pricedLegs.get("llm");
    const meta = sumMeasuredLegs(call.priced.legs.filter((leg) => LEG_VENDOR[leg.leg] === "meta"));
    const assembly = sumMeasuredLegs(
      call.priced.legs.filter((leg) => LEG_VENDOR[leg.leg] === "assemblyai"),
    );
    const complete = !ledger.unmeasured.some((entry) => entry.callId === call.callId);
    const sttQuantity = call.units.stt?.audio_seconds;
    const ttsQuantity = call.units.tts?.characters;
    const prompt = call.units.llm?.prompt_tokens;
    const completion = call.units.llm?.completion_tokens;
    const flags = complete ? "" : "*";
    const vendorCell = (vendor: VendorId): string => {
      const legs = call.priced.legs.filter((leg) => LEG_VENDOR[leg.leg] === vendor);
      const measured = legs.filter((leg) => leg.measured);
      if (measured.length === 0) return legs.length === 0 ? "zero" : "unmeasured";
      const sum = sumMeasuredLegs(measured);
      if (sum === 0 && measured.length < legs.length) return "unmeasured";
      return `${fmtUsd(roundUsd(sum, 8))}${flags}`;
    };
    lines.push(
      pad(call.callId, 38) +
        pad(call.scenario, 32) +
        padLeft(sttQuantity === undefined ? (stt === undefined ? "zero" : "unmeasured") : fmtQuantity(sttQuantity), 11) +
        padLeft(
          prompt === undefined || completion === undefined
            ? llm === undefined
              ? "zero"
              : "unmeasured"
            : `${fmtQuantity(prompt)}/${fmtQuantity(completion)}`,
          15,
        ) +
        padLeft(ttsQuantity === undefined ? (tts === undefined ? "zero" : "unmeasured") : fmtQuantity(ttsQuantity), 12) +
        padLeft(vendorCell("meta"), 15) +
        padLeft(vendorCell("assemblyai"), 15) +
        padLeft(
          complete
            ? fmtUsd(roundUsd(meta + assembly, 8))
            : call.priced.measured
              ? `${fmtUsd(roundUsd(meta + assembly, 8))}*`
              : "unmeasured",
          15,
        ) +
        `  ${call.priced.rateTableVersion ?? "—"}`,
    );
  }

  lines.push("");
  if (ledger.unmeasured.length === 0 && ledger.planGap === null) {
    lines.push("UNMEASURED");
    lines.push("  none — every leg is priced and every unit is present");
  } else {
    lines.push(
      ledger.unmeasured.length === 0
        ? "UNMEASURED"
        : `UNMEASURED (${ledger.unmeasured.length} leg${ledger.unmeasured.length === 1 ? "" : "s"})`,
    );
    if (ledger.unmeasured.length === 0) {
      lines.push("  none — every priced leg and unit is present");
    }
    for (const entry of ledger.unmeasured) {
      lines.push(
        `  call ${entry.callId} · ${entry.scenario} · ${entry.lineId ?? entry.leg} — ` +
          `${entry.kind} unmeasured: ${entry.reason}`,
      );
    }
    if (ledger.planGap !== null) lines.push(`  plan — ${ledger.planGap}`);
  }

  lines.push("");
  lines.push(totalLine(ledger));
  return `${lines.join("\n")}\n`;
}

function totalLine(ledger: UsageLedger): string {
  const calls = `${ledger.calls.length} call${ledger.calls.length === 1 ? "" : "s"}`;
  const reasons: string[] = [];
  if (ledger.unmeasured.length > 0) {
    reasons.push(
      `${ledger.unmeasured.length} unmeasured leg${ledger.unmeasured.length === 1 ? "" : "s"}`,
    );
  }
  if (ledger.planGap !== null) reasons.push(ledger.planGap);
  if (reasons.length > 0) {
    if (ledger.totalUsd === 0 && ledger.unmeasured.length > 0) {
      return `TOTAL unmeasured — ${reasons.join("; ")}; no priced total exists (see UNMEASURED)`;
    }
    return (
      `TOTAL (measured subset) ${fmtUsd(ledger.totalUsd)} across ${calls} · ` +
      `NOT RECONCILABLE: ${reasons.join("; ")}`
    );
  }
  const table =
    ledger.rateVersions.length === 0
      ? "no rate table cited"
      : `rate table${ledger.rateVersions.length === 1 ? "" : "s"} ${ledger.rateVersions.join(", ")}`;
  const zero =
    ledger.zeroCalls === ledger.calls.length
      ? ` · measured zero: ${
          ledger.calls.find((call) => call.priced.measured && call.priced.legs.length === 0)
            ?.priced.source ?? "every call opened no session"
        }`
      : "";
  return `TOTAL ${fmtUsd(ledger.totalUsd)} across ${calls} · ${table}${zero}`;
}

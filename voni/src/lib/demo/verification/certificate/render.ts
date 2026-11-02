/**
 * The compact certificate render: what a human reads before trusting the JSON.
 *
 * It is a summary, not the claim — every gap row, citation and coverage row
 * lives in the certificate itself. The first line states the verdict and
 * whether it is a pass, so a screenshot cannot quietly turn `not-demo-ready`
 * into green. Failures, run-level failures, ineligibility reasons and the first
 * gaps are printed by name.
 */

import { outOfScopeLocales } from "./scope";
import type { Certificate } from "./types";

const GAP_ROWS_SHOWN = 6;

function n(value: number): string {
  return String(value);
}

function money(usd: number): string {
  return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
}

function verdictLine(certificate: Certificate): string {
  const mark = certificate.pass ? "PASS" : "NOT A PASS";
  return `CERTIFICATE ${certificate.verdict.toUpperCase()} (${mark})`;
}

/**
 * A bound is never rendered as an exact price. A complete cost says so; an
 * incomplete one says "at least" and names every unpriced leg with the row's
 * own reason, so a screenshot cannot soften the gap.
 */
function costLine(certificate: Certificate): string {
  const { cost } = certificate;
  if (cost.complete) {
    return `calls ${n(cost.callCount)}  cost ${money(cost.usdMeasured)} (complete)`;
  }
  const legs = cost.unpriced
    .slice(0, 4)
    .map((leg) => `${leg.callId} ${leg.leg}`)
    .join(", ");
  const more = cost.unpriced.length > 4 ? ` +${cost.unpriced.length - 4} more` : "";
  return (
    `calls ${n(cost.callCount)}  cost at least ${money(cost.usdMeasured)} — not exact; ` +
    `${cost.unpriced.length} unpriced leg(s) (cut before the vendor reported: ${legs}${more})`
  );
}

function coverageLine(certificate: Certificate): string {
  const { coverage } = certificate;
  const measured = coverage.rows.filter((row) => row.status === "measured").length;
  const locales = coverage.byLocale
    .map((locale) =>
      locale.status === "out-of-scope"
        ? `${locale.locale} OUT-OF-SCOPE`
        : `${locale.locale} ${locale.measuredScenarios}/${locale.expectedScenarios}`,
    )
    .join(" ");
  return (
    `coverage ${measured}/${coverage.expectedScenarios} scenarios measured, ` +
    `${coverage.gapRows} gap rows; ${locales}`
  );
}

/** The claim's Locale set and the owner decision behind it, never implicit. */
function scopeLine(certificate: Certificate): string {
  const { scope } = certificate;
  if (scope === null) {
    return "scope undeclared (pre-v3: every demo Locale required)";
  }
  const excluded = outOfScopeLocales(scope.locales);
  return (
    `scope ${scope.locales.join(", ")} (${scope.decidedBy} ${scope.decidedOn}: ` +
    `${scope.reason})` +
    (excluded.length === 0 ? "" : `  OUT OF SCOPE ${excluded.join(", ")}`)
  );
}

function panelLine(certificate: Certificate): string {
  if (certificate.panel === null) {
    return "panel UNSIGNED — pending human";
  }
  return (
    `panel ${certificate.panel.sessionId} reviewer ${certificate.panel.reviewer} ` +
    `signed ${certificate.panel.signedAt}`
  );
}

export function renderCertificate(certificate: Certificate): string {
  const passed = certificate.properties.filter((property) => property.status === "PASS").length;
  const failed = certificate.properties.filter((property) => property.status === "FAIL");
  const gapRows = certificate.coverage.rows.filter((row) => row.status === "gap");
  const lines: string[] = [
    verdictLine(certificate),
    `run ${certificate.runId}  target ${certificate.target}  plan ${certificate.plan.mode} × ` +
      `${certificate.plan.repetitions}`,
    scopeLine(certificate),
    `code ${certificate.code.fingerprint.head}` +
      `${certificate.code.fingerprint.dirty ? "+dirty" : ""}  app ${certificate.code.appBuild}  ` +
      `pipeline ${certificate.code.pipelineImage}`,
    `corpus v${certificate.corpus.version} ${certificate.corpus.sha256}`,
    `properties ${passed}/${certificate.properties.length} pass, ${failed.length} fail  ` +
      costLine(certificate),
    coverageLine(certificate),
    panelLine(certificate),
    `risks ${certificate.residualRiskIds.join(" ")}`,
  ];

  if (certificate.resume !== null) {
    lines.push(
      `RESUMED ${certificate.resume.journalRunId} at ${certificate.resume.resumedAt} ` +
        `(started ${certificate.resume.originalStartedAt}): ` +
        `${certificate.resume.reusedCalls.length} reused, ` +
        `${certificate.resume.madeCalls.length} made`,
    );
  }

  if (!certificate.eligibility.eligible) {
    lines.push(
      ...certificate.eligibility.reasons.map((reason) => `INELIGIBLE ${reason}`),
    );
  }
  lines.push(
    ...certificate.runFailures.map((failure) => `RUN FAILURE ${failure}`),
  );
  if (failed.length === 0) {
    lines.push("no property failures");
  } else {
    lines.push(
      ...failed.map(
        (property) =>
          `FAIL ${property.propertyId} ${property.reason} n=${n(property.sampleCount)} — ` +
          `${property.citations[0] ?? "no citation"}` +
          // The named reason a failure is unmeasured belongs on the compact
          // view too: H2's 40-judgment floor is not a footnote in the JSON.
          (property.gaps[0] === undefined ? "" : ` (${property.gaps[0]})`),
      ),
    );
  }
  if (gapRows.length === 0) {
    lines.push("no coverage gaps");
  } else {
    lines.push(
      ...gapRows
        .slice(0, GAP_ROWS_SHOWN)
        .map((row) => `GAP ${row.locale} ${row.scenario}: ${row.gap ?? "unmeasured"}`),
    );
    if (gapRows.length > GAP_ROWS_SHOWN) {
      lines.push(`GAP +${gapRows.length - GAP_ROWS_SHOWN} more rows (see certificate JSON)`);
    }
  }
  return `${lines.join("\n")}\n`;
}

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
      `calls ${n(certificate.cost.callCount)}  cost ${money(certificate.cost.usd)}`,
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
          `${property.citations[0] ?? "no citation"}`,
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

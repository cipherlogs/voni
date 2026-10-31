/**
 * The compact card a human reads in a run report.
 *
 * Markdown, one section per card, every field the spec lists. Paths stay
 * repo-relative where they were given repo-relative, so the render is a pointer
 * and not a machine-specific transcript.
 */

import type { AudioExcerpt, DefectCard } from "./types";

function excerptLine(label: string, excerpt: AudioExcerpt): string {
  return `- ${label}: \`${excerpt.file}\` [${excerpt.startMs}-${excerpt.endMs} ms]`;
}

/** Render one card; the replay command is printed verbatim. */
export function renderDefectCard(card: DefectCard): string {
  const lines: string[] = [];
  lines.push(`### ${card.id} — ${card.propertyId} ${card.property} [${card.severity}]`);
  lines.push(
    `- Scenario: ${card.scenario} · Locale: ${card.locale} · Target: ${card.target}`,
  );
  lines.push(
    `- Expected bar: ${card.expectedBar.text}` +
      (card.expectedBar.thresholds.length === 0
        ? ""
        : ` (${card.expectedBar.thresholds
            .map((threshold) => `${threshold.key}=${threshold.value}${threshold.unit}`)
            .join(", ")})`),
  );
  lines.push(
    `- Observed: ${card.observed.value === null ? "no numeric value" : `${card.observed.value}${card.observed.unit}`}` +
      (card.observed.statistic === null ? "" : ` (${card.observed.statistic})`) +
      ` — ${card.observed.detail}`,
  );
  lines.push(
    card.citation.turn === null
      ? `- Turn: none (${card.citation.turnAbsence ?? "call-level property"})`
      : `- Turn: session ${card.citation.session} / turn ${card.citation.turn}`,
  );
  for (const excerpt of card.citation.audioExcerpts) {
    lines.push(
      excerptLine(
        excerpt.media === "caller-take" ? "Caller take" : "Delivered WAV",
        excerpt,
      ),
    );
  }
  lines.push(`- Evidence: ${card.citation.evidenceFiles.map((file) => `\`${file}\``).join("; ")}`);
  lines.push(`- Modules: ${card.modules.map((module) => `\`${module}\``).join("; ")}`);
  lines.push(`- Replay: \`${card.replayCommand}\``);
  lines.push(`- Verdict: ${card.verdictReason} — ${card.detail}`);
  if (card.gaps.length > 0) {
    lines.push(`- Gaps: ${card.gaps.join("; ")}`);
  }
  return lines.join("\n");
}

/** Render every card in verdict order, separated by a blank line. */
export function renderDefectCards(cards: readonly DefectCard[]): string {
  return cards.map(renderDefectCard).join("\n\n");
}

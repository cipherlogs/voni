/**
 * The committed level evidence (`evidence/voice-levels/levels.json`), and the
 * one-voice amendment rule.
 *
 * ── Why this is separate from the measurement script ─────────────────────
 * `npm run voice:levels -- --voice <id>` runs one vendor call per take for one
 * voice. That is an amendment to a record of sixteen measurements, not a fresh
 * record: the other voices' rows, their takes and **their own measured dates**
 * must survive the run untouched. If the merge wrote one record-wide
 * `measuredOn`, a German-only run would claim fifteen English voices were
 * measured again on the German voice's date.
 *
 * The merge is pure so the rule is testable without a vendor call. The script
 * reads and writes the file; this module decides what the merged document is.
 */

/** One voice's row. `measuredOn` is the row's own take date, never the file's. */
export type VoiceLevelEvidenceRow = {
  voice: string;
  locale?: string;
  measuredOn?: string | null;
  [key: string]: unknown;
};

export type VoiceLevelEvidenceDocument = {
  schemaVersion: number;
  /** The latest row date, not a claim that every row was measured that day. */
  latestMeasuredOn: string;
  method: string;
  measuredWith: string;
  reference: Record<string, unknown>;
  decision: string;
  voices: VoiceLevelEvidenceRow[];
  unmeasured: VoiceLevelEvidenceRow[];
};

function datesOf(document: VoiceLevelEvidenceDocument): string[] {
  return [...document.voices, ...document.unmeasured]
    .map((row) => row.measuredOn)
    .filter((date): date is string => typeof date === "string");
}

/** The record's latest measurement date, derived from the rows themselves. */
export function latestMeasuredOn(document: VoiceLevelEvidenceDocument): string {
  return datesOf(document).sort().at(-1) ?? document.latestMeasuredOn;
}

/**
 * A `--voice` run re-measures one catalogue voice. Keep every other catalogue
 * voice's committed row (with its own date) and prune rows for ids the
 * catalogue no longer offers (a retired voice), so a single-voice run cannot
 * silently delete or re-date fifteen measured references.
 */
export function mergeOneVoice(
  previous: VoiceLevelEvidenceDocument,
  only: string,
  record: VoiceLevelEvidenceDocument,
  catalogue: readonly string[],
): VoiceLevelEvidenceDocument {
  const order = new Map(catalogue.map((voice, index) => [voice, index]));
  const keep = (rows: VoiceLevelEvidenceRow[] | undefined) =>
    (Array.isArray(rows) ? rows : []).filter(
      (row) => row.voice !== only && order.has(row.voice),
    );
  const byCatalogueOrder = (row: VoiceLevelEvidenceRow) =>
    order.get(row.voice) ?? catalogue.length;

  const merged: VoiceLevelEvidenceDocument = {
    ...record,
    latestMeasuredOn: record.latestMeasuredOn,
    voices: [...keep(previous.voices), ...record.voices].sort(
      (left, right) => byCatalogueOrder(left) - byCatalogueOrder(right),
    ),
    unmeasured: [...keep(previous.unmeasured), ...record.unmeasured].sort(
      (left, right) => byCatalogueOrder(left) - byCatalogueOrder(right),
    ),
  };
  return { ...merged, latestMeasuredOn: latestMeasuredOn(merged) };
}

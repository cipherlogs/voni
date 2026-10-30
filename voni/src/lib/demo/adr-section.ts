/**
 * One writer for a decision record's owned section.
 *
 * A gate owns one section of a decision record and replaces only that section.
 * Both re-audition recorders (the managed W2 gate and the cascade owner
 * verdict) regenerate their section on every write, so the replace-or-append
 * walk lives here once instead of in each recorder.
 */
export function replaceAdrSection(markdown: string, marker: string, section: string): string {
  const markerAt = headingIndex(markdown, marker);
  let withoutSection = markdown;
  if (markerAt >= 0) {
    const after = markdown.slice(markerAt + marker.length);
    const nextSection = after.search(/^## /m);
    withoutSection = `${markdown.slice(0, markerAt)}${nextSection >= 0 ? after.slice(nextSection) : ""}`;
  }

  const trimmed = withoutSection.trimEnd();
  return trimmed === "" ? section : `${trimmed}\n\n${section}`;
}

/** The marker only counts at the start of a line, never inside prose. */
function headingIndex(markdown: string, marker: string): number {
  let from = 0;
  for (;;) {
    const at = markdown.indexOf(marker, from);
    if (at < 0) return -1;
    if (at === 0 || markdown[at - 1] === "\n") return at;
    from = at + 1;
  }
}

/**
 * One writer for a decision record's owned section.
 *
 * A gate owns one section of a decision record and replaces only that section.
 * Both re-audition recorders (the managed W2 gate and the cascade owner
 * verdict) regenerate their section on every write, so the replace-or-append
 * walk lives here once instead of in each recorder.
 */
export function replaceAdrSection(markdown: string, marker: string, section: string): string {
  const markerAt = markdown.indexOf(marker);
  let withoutSection = markdown;
  if (markerAt >= 0) {
    const after = markdown.slice(markerAt + marker.length);
    const nextSection = after.search(/^## /m);
    withoutSection = `${markdown.slice(0, markerAt)}${nextSection >= 0 ? after.slice(nextSection) : ""}`;
  }

  const trimmed = withoutSection.trimEnd();
  return trimmed === "" ? section : `${trimmed}\n\n${section}`;
}

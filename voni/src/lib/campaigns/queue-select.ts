/**
 * Single-pass queue helpers (ticket 09 J1).
 *
 * The campaign queue used to traverse its rows once per question —
 * `.every` for select-all, `.some` for the indeterminate state, and a
 * `.filter().map()` for the bulk ids. Each helper below answers its
 * question in one loop with `Set.has` membership (the `queueBulkAction`
 * model) and never mutates its input.
 */

export function countQueuedMembers(
  members: ReadonlyArray<{ status: string }>,
): number {
  let queued = 0;
  for (const member of members) {
    if (member.status === "queued") queued += 1;
  }
  return queued;
}

export function summarizeQueueSelection(
  visible: ReadonlyArray<{ id: string }>,
  selected: ReadonlySet<string>,
): { allSelected: boolean; someSelected: boolean } {
  if (visible.length === 0) return { allSelected: false, someSelected: false };
  let allSelected = true;
  let someSelected = false;
  for (const member of visible) {
    if (selected.has(member.id)) {
      someSelected = true;
    } else {
      allSelected = false;
    }
    if (allSelected === false && someSelected) break;
  }
  return { allSelected, someSelected };
}

export function selectActionableIds(
  visible: ReadonlyArray<{ id: string }>,
  selected: ReadonlySet<string>,
): string[] {
  const ids: string[] = [];
  for (const member of visible) {
    if (selected.has(member.id)) ids.push(member.id);
  }
  return ids;
}

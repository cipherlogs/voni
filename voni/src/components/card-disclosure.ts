"use client";

import { useCallback, useEffect, useState } from "react";
import { parseVersioned, wrapVersioned } from "@/lib/storage/versioned";

/**
 * The console cards' remembered fold state.
 *
 * Every `/email` card starts collapsed, and an operator who opens one keeps it
 * open across reloads and visits. The choice is per card, in `localStorage`,
 * keyed by the card's stable `data-testid` — the identifier the rest of the
 * console and its tests already agree on, so a card cannot be remembered under
 * a name that changes with its copy.
 *
 * The key scheme is `voni:email-card-open:<cardId>` and the value is the house
 * versioned envelope around a boolean. A card that was never opened has no
 * stored value and reads as collapsed, which is the default.
 */

/** The slice of `Storage` this module needs, so a test can pass a fake. */
export type CardDisclosureStorage = Pick<Storage, "getItem" | "setItem">;

export function cardDisclosureKey(cardId: string): string {
  return `voni:email-card-open:${cardId}`;
}

function browserStorage(): CardDisclosureStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Private mode can refuse the getter; a card with no storage still opens
    // and closes for this visit, it just is not remembered.
    return null;
  }
}

/** Has this card been opened before? Absent, corrupt or unreadable is closed. */
export function readCardOpen(
  cardId: string,
  storage: CardDisclosureStorage | null = browserStorage(),
): boolean {
  if (storage === null) return false;
  try {
    const raw = storage.getItem(cardDisclosureKey(cardId));
    return (
      parseVersioned<boolean>(raw, {
        validate: (data) => typeof data === "boolean",
      }) ?? false
    );
  } catch {
    return false;
  }
}

/** Remember one card's choice. Best-effort: a refused write never breaks it. */
export function writeCardOpen(
  cardId: string,
  open: boolean,
  storage: CardDisclosureStorage | null = browserStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(cardDisclosureKey(cardId), wrapVersioned(open));
  } catch {
    // Ignore quota/private-mode failures; this render's state is authoritative.
  }
}

export type CardDisclosure = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Controlled `Collapsible` state for one card.
 *
 * The initial state is always collapsed, and storage is read in an effect
 * after mount. The server HTML and the first client render therefore agree;
 * restoring the stored choice afterwards updates the client only. Reading
 * `localStorage` in a `useState` initializer would make the first client render
 * disagree with the server and is exactly the hydration mismatch this avoids.
 */
export function useCardDisclosure(cardId: string): CardDisclosure {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!readCardOpen(cardId)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- post-hydration restore, same house pattern as the wizard draft
    setOpen(true);
  }, [cardId]);

  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      writeCardOpen(cardId, next);
    },
    [cardId],
  );

  return { open, onOpenChange };
}

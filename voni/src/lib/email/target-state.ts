/**
 * Shape shared by the target card, the page that renders it and the server
 * actions that change it.
 *
 * It lives here for the same reason `src/lib/burst/state.ts` does: the card can
 * be reviewed and tested before `actions.ts` grows the matching exports, and a
 * server action returning a different shape is then a compile error, not a
 * silently empty list.
 */
export type TargetState = {
  ok: boolean;
  /** A refusal the operator must read; rendered as a destructive Alert. */
  error?: string | null;
  /** A confirmation, e.g. that the check was rebuilt with the new list. */
  message?: string | null;
};

/** One row of the card's list. The URL is the row's identity in the UI only. */
export type TargetView = {
  id: string;
  url: string;
  enabled: boolean;
};

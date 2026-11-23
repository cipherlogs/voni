"use client";

import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "@/components/ui/toast";

/**
 * The one place a server-action result becomes something an operator can see.
 *
 * On `/email` there is exactly one surface for an outcome — the floating toast.
 * The inline Alert that used to ride beside every card said the same thing a
 * second time, so it is gone; a card supplies only its own words: the error
 * title, the success title, and, where the outcome has an artifact, the action
 * that reaches it (a run link, or a copy of the manual command).
 */

/** The shape every action result shares; richer states are assignable. */
export type ActionFeedbackState = {
  error?: string | null;
  message?: string | null;
};

/**
 * Deterministic grouping, so the server and client render the same digits.
 * One formatter for the whole console — a second one is how two cards start
 * disagreeing about the same number.
 */
const COUNT_FORMAT = new Intl.NumberFormat("en-US");

export function formatCount(value: number): string {
  return COUNT_FORMAT.format(value);
}

/** What a toast's action button does: visit a run, or copy a command. */
export type ActionToastAction = {
  label: string;
  /** Opens in a new tab when the toast is clicked. */
  href?: string;
  onClick?: () => void;
};

export type ActionToastOptions = {
  /** The success title; "Done" when the card has nothing more specific. */
  successTitle?: string;
  /** The artifact control: a "View run" link or a "Copy" button. */
  action?: ActionToastAction;
  /** Longer for command toasts, so an operator can read the line. */
  timeout?: number;
  /** Replaces the success message; a React node, so a command can be `<code>`. */
  description?: ReactNode;
};

/** The button props Base UI's toast action reads off the toast object. */
function actionPropsFor(action: ActionToastAction | undefined) {
  if (!action) return undefined;
  const onClick =
    action.onClick ??
    (action.href
      ? () => {
          window.open(action.href, "_blank", "noopener,noreferrer");
        }
      : undefined);
  // The label is the visible text; the extra sentence tells a screen reader
  // that the click leaves the page, which a button alone cannot say.
  const ariaLabel = action.href
    ? `${action.label} (opens in a new tab)`
    : undefined;
  return { children: action.label, onClick, "aria-label": ariaLabel };
}

/**
 * One toast per action result. An error is announced urgently (`priority:
 * "high"`); a success may carry an artifact action and a longer timeout when
 * the description is something the operator has to read or copy.
 */
export function useActionToast(
  state: ActionFeedbackState,
  errorTitle = "Could not complete",
  options: ActionToastOptions = {},
) {
  // Options are usually inline literals, so they are read through a ref: the
  // effect must fire on a new submission, not on every render that rebuilt an
  // action object or a description node.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    const {
      successTitle = "Done",
      action,
      timeout,
      description,
    } = optionsRef.current;

    if (state.error) {
      toast.add({
        title: errorTitle,
        description: state.error,
        type: "error",
        priority: "high",
      });
      return;
    }
    if (state.message) {
      toast.add({
        title: successTitle,
        description: description ?? state.message,
        type: "success",
        timeout,
        actionProps: actionPropsFor(action),
      });
    }
    // `state` is a fresh object per submission, so a repeat message still shows.
  }, [state, errorTitle]);
}

/**
 * `useActionState` for a form whose result wording depends on what was
 * submitted.
 *
 * Revalidation replaces a card's props before the toast effect reads them, so a
 * title derived from the new prop names the opposite of the click that caused
 * it. The intent is captured from the submitted `FormData` as the action
 * starts — before the server answers — and handed back with the state, so a
 * card can say "disabled" because that is what was asked for.
 */
export function useIntentActionState<State, Intent>(
  action: (
    previous: Awaited<State>,
    formData: FormData,
  ) => State | Promise<State>,
  initial: Awaited<State>,
  readIntent: (formData: FormData) => Intent,
) {
  const [intent, setIntent] = useState<Intent | null>(null);
  const [state, formAction, pending] = useActionState(
    async (previous: Awaited<State>, formData: FormData) => {
      setIntent(readIntent(formData));
      return action(previous, formData);
    },
    initial,
  );
  return [state, formAction, pending, intent] as const;
}

/**
 * Copy a manual run command from a toast action. The receipt is another toast,
 * so the only surface stays the toast — including when the clipboard refuses.
 */
export function copyCommand(command: string) {
  const failed = () => {
    toast.add({
      title: "Could not copy",
      description: "Select the command and copy it by hand.",
      type: "error",
      priority: "high",
    });
  };
  try {
    // `navigator.clipboard` is absent outside a secure context, and reading it
    // can throw on its own, so the lookup is as guarded as the write.
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      failed();
      return;
    }
    clipboard.writeText(command).then(() => {
      toast.add({ title: "Copied to clipboard", type: "success", timeout: 3_000 });
    }, failed);
  } catch {
    failed();
  }
}

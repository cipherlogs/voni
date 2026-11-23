"use client";

import { useEffect, useState, type ReactNode } from "react";
import { AlertCircle, Check, CheckCircle2, Copy } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";

/**
 * The one place a server-action result becomes something an operator can see.
 *
 * Every card on `/email` renders the same three pieces — an inline Alert for
 * the outcome, a toast riding along as a convenience, and the copy-to-clipboard
 * manual-run fallback — and each copy drifted slightly. The copy lives here
 * once; a card supplies only what is genuinely its own: the error title, the
 * test id and, for the fallback, the exact command and the sentence about the
 * credential it needs.
 *
 * Copy and test ids are deliberately preserved from the cards this replaced: a
 * reviewer's test, and an operator's eye, should not have to relearn them.
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

/**
 * Inline Alert for one action result. `errorTitle` is the card's own sentence
 * ("Could not update targets", "Burst not dispatched"); the success title is
 * "Done" unless the card says otherwise. `children` renders under the
 * description — a run link, for the burst card.
 */
export function FeedbackAlert({
  state,
  errorTitle = "Could not complete",
  successTitle = "Done",
  testId,
  children,
}: {
  state: ActionFeedbackState;
  errorTitle?: string;
  successTitle?: string;
  testId?: string;
  children?: ReactNode;
}) {
  if (!state.error && !state.message) return null;

  return (
    <Alert
      variant={state.error ? "destructive" : "default"}
      className="status-enter"
      data-testid={testId}
    >
      {state.error ? <AlertCircle /> : <CheckCircle2 />}
      <AlertTitle>{state.error ? errorTitle : successTitle}</AlertTitle>
      <AlertDescription>
        <span className="block">{state.error ?? state.message}</span>
        {children}
      </AlertDescription>
    </Alert>
  );
}

/** Inline Alert is the required surface; a toast rides along as a convenience. */
export function useActionToast(
  state: ActionFeedbackState,
  errorTitle = "Could not complete",
) {
  useEffect(() => {
    if (state.error) {
      toast.add({
        title: errorTitle,
        description: state.error,
        type: "error",
      });
      return;
    }
    if (state.message) {
      toast.add({ title: "Done", description: state.message, type: "success" });
    }
    // `state` is a fresh object per submission, so a repeat message still shows.
  }, [state, errorTitle]);
}

/**
 * The manual run, when no dispatch token is configured. A missing token is a
 * normal outcome, so this is plain paper rather than a destructive Alert.
 *
 * The label is a receipt for one click, not a permanent state: a stale
 * "Copied" next to a command that has since changed would be a lie.
 */
export function ManualRunFallback({
  command,
  testId,
  copyTestId,
  note,
}: {
  command: string;
  testId?: string;
  copyTestId?: string;
  /** What credential the line needs; the line itself never carries it. */
  note: ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      toast.add({
        title: "Could not copy",
        description: "Select the command and copy it by hand.",
        type: "error",
      });
    }
  }

  return (
    <div
      className="grid gap-2 rounded-lg border px-3 py-3"
      data-testid={testId}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          Run it yourself — no dispatch token configured.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void copy();
          }}
          data-testid={copyTestId}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs whitespace-pre">
        <code>{command}</code>
      </pre>
      <p className="text-muted-foreground text-xs">{note}</p>
    </div>
  );
}

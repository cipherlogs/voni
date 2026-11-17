"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { AlertCircle, LockKeyhole } from "lucide-react";
import { unlockPage, type ControlState } from "@/app/email/actions";
import { LoadingButton } from "@/components/loading-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/**
 * The `/email` page gate. Presentation only: `unlockPage` re-checks the
 * password on the server, and the cookie it sets is what the page reads before
 * it reads anything else.
 *
 * No reveal toggle on purpose — a password field that can be switched to plain
 * text is one shoulder-surf away from being a plain text field.
 */

const INITIAL: ControlState = { ok: false };

function GateSubmitButton() {
  const { pending } = useFormStatus();
  return (
    <LoadingButton
      type="submit"
      pending={pending}
      pendingText="Checking…"
      icon={<LockKeyhole />}
      className="w-full"
    >
      Unlock
    </LoadingButton>
  );
}

export function EmailGateForm() {
  const [state, action, pending] = useActionState(unlockPage, INITIAL);

  return (
    <form action={action} className="grid gap-4">
      <Field>
        <FieldLabel htmlFor="email-page-password">Password</FieldLabel>
        <Input
          id="email-page-password"
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          disabled={pending}
          required
        />
      </Field>
      {state.error ? (
        <Alert variant="destructive" className="status-enter">
          <AlertCircle />
          <AlertTitle>Could not unlock</AlertTitle>
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <GateSubmitButton />
    </form>
  );
}

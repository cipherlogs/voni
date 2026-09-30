"use client";

import { useState, useTransition } from "react";
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import Login01 from "@/components/login-01";
import { signIn } from "@/lib/auth-client";

/**
 * The whole auth stack on the vendored login-01 idiom (DESIGN.md §3–§4),
 * so `/login` and `/signup` stay thin and cannot drift apart.
 * Google-only sign-in (Better Auth social) — the email form from the
 * upstream block is intentionally dropped.
 */
export function AuthForm({
  mode,
  nextPath,
  oauthError,
}: {
  mode: "login" | "signup";
  nextPath: string;
  oauthError?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState(oauthError);
  const signup = mode === "signup";

  function continueWithGoogle() {
    setError(undefined);
    startTransition(async () => {
      // errorCallbackURL brings OAuth failures (e.g. ?error=invite_only) back
      // to this page instead of Better Auth's bare /api/auth/error screen.
      const result = await signIn.social({
        provider: "google",
        callbackURL: nextPath,
        errorCallbackURL: `/${mode}?next=${encodeURIComponent(nextPath)}`,
      });
      if (result?.error) setError("Google sign-in could not start. Please try again.");
    });
  }

  return (
    <div className="flex w-full flex-1 flex-col items-center">
      <Login01
        alert={
          error ? (
            <Alert variant="destructive" className="mb-6">
              <AlertCircle />
              <AlertTitle>Sign-in did not complete</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null
        }
        title={signup ? "Create your workspace" : "Welcome back"}
        description={
          signup
            ? "Your first Google sign-in creates a private workspace automatically."
            : "Sign in with the Google account connected to your workspace."
        }
        pending={pending}
        pendingText="Opening Google…"
        onGoogle={continueWithGoogle}
        switchLine={signup ? "Already have an account?" : "New to Voni?"}
        switchHref={`${signup ? "/login" : "/signup"}?next=${encodeURIComponent(nextPath)}`}
        switchLabel={signup ? "Sign in" : "Create an account"}
      />
    </div>
  );
}

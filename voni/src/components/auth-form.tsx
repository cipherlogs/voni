"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { LoadingButton } from "@/components/loading-button";
import { VoniLogo } from "@/components/voni-logo";
import { signIn } from "@/lib/auth-client";

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12.48 10.92v3.28h7.84c-.24 1.84-.85 3.19-1.79 4.13-1.15 1.15-2.93 2.4-6.05 2.4-4.83 0-8.6-3.89-8.6-8.72s3.77-8.72 8.6-8.72c2.6 0 4.51 1.03 5.91 2.35l2.31-2.31C18.75 1.44 16.13 0 12.48 0 5.87 0 .31 5.39.31 12s5.56 12 12.17 12c3.57 0 6.27-1.17 8.37-3.36 2.16-2.16 2.84-5.21 2.84-7.67 0-.76-.05-1.47-.17-2.05h-7.04Z"
      />
    </svg>
  );
}

/**
 * The whole auth stack, card included, so `/login` and `/signup` stay thin and
 * cannot drift apart.
 *
 * Layout follows the convention users already know from GitHub and Vercel: the
 * mark sits above the card and the account-switch line below it, leaving the
 * card holding one idea — the single action. Both pages are the app's own
 * surface colour with the card as the only raised layer; an extra tinted panel
 * behind it just reads as a smudge.
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
      const result = await signIn.social({ provider: "google", callbackURL: nextPath });
      if (result?.error) setError("Google sign-in could not start. Please try again.");
    });
  }

  return (
    <div className="auth-enter flex w-full max-w-[400px] flex-col items-center gap-8">
      <Link href="/" className="cursor-pointer rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <VoniLogo size="lg" wordmark animate />
        <span className="sr-only">Voni home</span>
      </Link>

      <div className="w-full rounded-xl border bg-card p-8">
        <div className="flex flex-col gap-7">
          <div className="flex flex-col gap-2 text-center">
            <h1 className="text-xl font-semibold tracking-tight">
              {signup ? "Create your workspace" : "Welcome back"}
            </h1>
            <p className="text-muted-foreground text-sm leading-relaxed text-balance">
              {signup
                ? "Your first Google sign-in creates a private workspace automatically."
                : "Sign in with the Google account connected to your workspace."}
            </p>
          </div>

          {error ? (
            <Alert variant="destructive" className="status-enter">
              <AlertCircle />
              <AlertTitle>Sign-in did not complete</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <LoadingButton
            size="lg"
            variant="outline"
            onClick={continueWithGoogle}
            pending={pending}
            pendingText="Opening Google…"
            icon={<GoogleMark />}
            className="h-10 w-full"
          >
            Continue with Google
          </LoadingButton>
        </div>
      </div>

      <p className="text-muted-foreground text-sm">
        {signup ? "Already have an account?" : "New to Voni?"}{" "}
        <Link
          className="cursor-pointer rounded-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
          href={`${signup ? "/login" : "/signup"}?next=${encodeURIComponent(nextPath)}`}
        >
          {signup ? "Sign in" : "Create an account"}
        </Link>
      </p>
    </div>
  );
}

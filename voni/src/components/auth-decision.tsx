import { headers } from "next/headers";
import { AuthForm } from "@/components/auth-form";
import { AuthenticatedRedirect } from "@/components/authenticated-redirect";
import { auth } from "@/lib/auth";
import { safeNextPath } from "@/lib/auth-redirect";
import { devBypassEnabled } from "@/lib/dev-bypass";

const INVITE_ONLY =
  "Voni is in private beta, so accounts are invite-only while we save our call credits for early testers. Want in? Email hi@voni.cc and we'll get you set up.";

const LOGIN_OAUTH_ERRORS: Record<string, string> = {
  invite_only: INVITE_ONLY,
  access_denied:
    "Google access was cancelled. You can try again when you are ready.",
  oauth_callback_error:
    "Google could not verify this sign-in. Please try again.",
};

/**
 * Shared session decision for the public auth screens: runs behind its own
 * Suspense boundary so each auth-page frame prerenders without awaiting
 * request data. Preserves the client-redirect path — no async Server
 * Component redirect here. Mode selects only the single-sign-on copy and
 * the OAuth error mapping; session, next-path, and bypass semantics stay
 * identical for login and signup.
 */
export async function AuthDecision({
  mode,
  searchParams,
}: {
  mode: "login" | "signup";
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const query = await searchParams;
  const nextPath = safeNextPath(query.next);
  const authBypassed = devBypassEnabled();
  const session = authBypassed
    ? null
    : await auth.api.getSession({ headers: await headers() });
  if (authBypassed || session) {
    return <AuthenticatedRedirect destination={nextPath} />;
  }
  if (mode === "login") {
    const errorCode = typeof query.error === "string" ? query.error : "";
    return (
      <AuthForm
        mode="login"
        nextPath={nextPath}
        oauthError={LOGIN_OAUTH_ERRORS[errorCode]}
      />
    );
  }
  const oauthError = query.error === "invite_only"
    ? INVITE_ONLY
    : query.error
    ? "Google could not complete account creation. No workspace was created. Please try again."
    : undefined;
  return <AuthForm mode="signup" nextPath={nextPath} oauthError={oauthError} />;
}

import { Suspense } from "react";
import { connection } from "next/server";
import { headers } from "next/headers";
import { AuthForm } from "@/components/auth-form";
import { AuthenticatedRedirect } from "@/components/authenticated-redirect";
import { SiteFooter } from "@/components/site-footer";
import { auth } from "@/lib/auth";
import { safeNextPath } from "@/lib/auth-redirect";
import { devBypassEnabled } from "@/lib/dev-bypass";

const OAUTH_ERRORS: Record<string, string> = {
  access_denied: "Google access was cancelled. You can try again when you are ready.",
  oauth_callback_error: "Google could not verify this sign-in. Please try again.",
};

/**
 * Session decision: runs behind its own boundary so the auth-page frame
 * (Task 9 shell) prerenders without awaiting request data. Preserves the
 * client-redirect path — no async Server Component redirect here.
 */
async function LoginDecision({
  searchParams,
}: {
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
  const errorCode = typeof query.error === "string" ? query.error : "";
  return (
    <AuthForm mode="login" nextPath={nextPath} oauthError={OAUTH_ERRORS[errorCode]} />
  );
}

export default function LoginPage(props: PageProps<"/login">) {
  return (
    <main data-testid="login-shell" className="flex min-h-svh flex-col">
      <div className="flex flex-1 flex-col">
        <Suspense
          fallback={
            <p aria-live="polite" className="text-muted-foreground p-6 text-sm">
              Loading sign-in…
            </p>
          }
        >
          <LoginDecision searchParams={props.searchParams} />
        </Suspense>
      </div>
      <SiteFooter
        year={
          <Suspense fallback={<span>© Voni</span>}>
            <LoginYear />
          </Suspense>
        }
      />
    </main>
  );
}

/**
 * Request-time footer leaf: isolates the current-year read so the auth-page
 * frame prerenders without awaiting request data. Same language as the
 * landing footer via SiteFooter.
 */
async function LoginYear() {
  await connection();
  return <>© {new Date().getFullYear()} Voni</>;
}

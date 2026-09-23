import { Suspense } from "react";
import { connection } from "next/server";
import { headers } from "next/headers";
import { AuthForm } from "@/components/auth-form";
import { AuthenticatedRedirect } from "@/components/authenticated-redirect";
import { SiteFooter } from "@/components/site-footer";
import { auth } from "@/lib/auth";
import { safeNextPath } from "@/lib/auth-redirect";
import { devBypassEnabled } from "@/lib/dev-bypass";

/**
 * Session decision: runs behind its own boundary so the auth-page frame
 * (Task 9 shell) prerenders without awaiting request data. Same protections
 * as login, preserving signup copy — client-redirect path, no async Server
 * Component redirect.
 */
async function SignupDecision({
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
  const oauthError = query.error
    ? "Google could not complete account creation. No workspace was created. Please try again."
    : undefined;
  return (
    <AuthForm mode="signup" nextPath={nextPath} oauthError={oauthError} />
  );
}

export default function SignupPage(props: PageProps<"/signup">) {
  return (
    <main data-testid="signup-shell" className="flex min-h-svh flex-col">
      <div className="flex flex-1 flex-col">
        <Suspense
          fallback={
            <p aria-live="polite" className="text-muted-foreground p-6 text-sm">
              Loading sign-up…
            </p>
          }
        >
          <SignupDecision searchParams={props.searchParams} />
        </Suspense>
      </div>
      <SiteFooter
        year={
          <Suspense fallback={<span>© Voni</span>}>
            <SignupYear />
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
async function SignupYear() {
  await connection();
  return <>© {new Date().getFullYear()} Voni</>;
}

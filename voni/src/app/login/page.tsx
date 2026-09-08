import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { auth } from "@/lib/auth";
import { safeNextPath } from "@/lib/auth-redirect";

const OAUTH_ERRORS: Record<string, string> = {
  access_denied: "Google access was cancelled. You can try again when you are ready.",
  oauth_callback_error: "Google could not verify this sign-in. Please try again.",
};

export default async function LoginPage(props: PageProps<"/login">) {
  const query = await props.searchParams;
  const nextPath = safeNextPath(query.next);
  const session = await auth.api.getSession({ headers: await headers() });
  if (session) redirect(nextPath);
  const errorCode = typeof query.error === "string" ? query.error : "";
  return (
    <main className="flex min-h-svh flex-col items-center justify-center px-4 py-12">
      <AuthForm mode="login" nextPath={nextPath} oauthError={OAUTH_ERRORS[errorCode]} />
    </main>
  );
}

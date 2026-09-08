import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { auth } from "@/lib/auth";
import { safeNextPath } from "@/lib/auth-redirect";

export default async function SignupPage(props: PageProps<"/signup">) {
  const query = await props.searchParams;
  const nextPath = safeNextPath(query.next);
  const session = await auth.api.getSession({ headers: await headers() });
  if (session) redirect(nextPath);
  const oauthError = query.error
    ? "Google could not complete account creation. No workspace was created. Please try again."
    : undefined;
  return (
    <main className="flex min-h-svh flex-col items-center justify-center px-4 py-12">
      <AuthForm mode="signup" nextPath={nextPath} oauthError={oauthError} />
    </main>
  );
}

import { Suspense } from "react";
import { AuthDecision } from "@/components/auth-decision";
import { FooterYear, SiteFooter } from "@/components/site-footer";

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
          <AuthDecision mode="signup" searchParams={props.searchParams} />
        </Suspense>
      </div>
      <SiteFooter
        year={
          <Suspense fallback={<span>© Voni</span>}>
            <FooterYear />
          </Suspense>
        }
      />
    </main>
  );
}


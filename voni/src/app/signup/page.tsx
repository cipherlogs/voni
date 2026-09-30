import { Suspense } from "react";
import Link from "next/link";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { FooterYear, SiteFooter } from "@/components/site-footer";

/**
 * Private beta: sign-up is closed (the server gate in src/lib/auth.ts rejects
 * non-allowlisted emails anyway). To reopen, restore this page to mirror
 * /login with mode="signup" (see git history).
 */
export default function SignupPage() {
  return (
    <main data-testid="signup-shell" className="flex min-h-svh flex-col">
      <div className="flex flex-1 items-center justify-center p-4">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Mail />
            </EmptyMedia>
            <EmptyTitle>Voni is in private beta</EmptyTitle>
            <EmptyDescription>
              Accounts are invite-only while we save our call credits for early
              testers. Email hi@voni.cc and we&apos;ll get you set up.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row justify-center gap-2">
            <Button nativeButton={false} render={<a href="mailto:hi@voni.cc" />}>
              Request an invite
            </Button>
            <Button nativeButton={false} render={<Link href="/login" />} variant="outline">
              Sign in
            </Button>
          </EmptyContent>
        </Empty>
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

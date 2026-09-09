"use client";

import Link from "next/link";
import { ModeToggle } from "@/components/mode-toggle";
import { Button } from "@/components/ui/button";
import { VoniLogo } from "@/components/voni-logo";
import { useSession } from "@/lib/auth-client";

const CONTAINER = "mx-auto w-full max-w-6xl px-6";

export function LandingHeader({
  initialAuthenticated,
  authBypassed = false,
}: {
  initialAuthenticated: boolean;
  authBypassed?: boolean;
}) {
  const { data: session, isPending } = useSession();
  const authenticated =
    authBypassed || (isPending ? initialAuthenticated : Boolean(session));

  return (
    <header className="bg-background/80 sticky top-0 z-40 border-b backdrop-blur-md">
      <div className={`${CONTAINER} flex h-16 items-center justify-between`}>
        <Link
          href="/"
          aria-label="Voni home"
          className="cursor-pointer rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <VoniLogo size="sm" wordmark animate />
        </Link>
        <div className="flex items-center gap-1.5">
          {authenticated ? (
            <Button
              nativeButton={false}
              render={<Link href="/dashboard" />}
            >
              Open dashboard
            </Button>
          ) : (
            <>
              <Button
                nativeButton={false}
                variant="ghost"
                render={<Link href="/login" />}
              >
                Sign in
              </Button>
              <Button nativeButton={false} render={<Link href="/signup" />}>
                Get started
              </Button>
            </>
          )}
          <div className="bg-border mx-1 h-5 w-px" />
          <ModeToggle />
        </div>
      </div>
    </header>
  );
}

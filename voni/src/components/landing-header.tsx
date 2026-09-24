"use client";

import Link from "next/link";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { VoniLogo } from "@/components/voni-logo";
import { useSession } from "@/lib/auth-client";

/* The landing is light-only (DESIGN.md §10c), so it carries no theme toggle.
   Same gutter as PUBLIC_CONTAINER (site-footer.tsx is server-only, so the
   literal is repeated here rather than imported into a client bundle). */
const CONTAINER = "mx-auto w-full max-w-300 px-6";

const SECTIONS = [
  ["#demo", "Live demo"],
  ["#features", "Features"],
  ["#how", "How it works"],
  ["#faq", "FAQ"],
] as const;

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

  const primary = authenticated
    ? { href: "/dashboard", label: "Open dashboard" }
    : { href: "/signup", label: "Get started" };

  return (
    <header className="bg-background/95 sticky top-0 z-40 border-b backdrop-blur-md">
      <div className={`${CONTAINER} flex h-14 items-center justify-between max-md:px-4 md:h-16`}>
        <Link
          href="/"
          aria-label="Voni home"
          className="cursor-pointer rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <VoniLogo size="sm" wordmark animate className="text-lg" />
        </Link>
        <nav aria-label="Page sections" className="text-foreground/70 hidden items-center gap-8 text-sm md:flex">
          {SECTIONS.map(([href, label]) => (
            <a key={href} href={href} className="hover:text-foreground transition-colors">
              {label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-1.5">
          {authenticated ? null : (
            <Button
              nativeButton={false}
              variant="ghost"
              render={<Link href="/login" />}
              className="hidden h-10 rounded-md px-3.5 md:inline-flex"
            >
              Sign in
            </Button>
          )}
          <Button
            nativeButton={false}
            render={<Link href={primary.href} />}
            className="h-9 rounded-md px-3 md:h-10 md:px-4"
          >
            <span className="text-ui md:text-sm">{primary.label}</span>
          </Button>
          <Sheet>
            <SheetTrigger
              render={<Button variant="ghost" size="icon" className="size-11 md:hidden" aria-label="Open menu" />}
            >
              <Menu className="size-5" />
            </SheetTrigger>
            <SheetContent side="top" className="gap-1 p-4 pt-14">
              <SheetTitle className="sr-only">Menu</SheetTitle>
              {SECTIONS.map(([href, label]) => (
                <SheetClose
                  key={href}
                  nativeButton={false}
                  render={<a href={href} />}
                  className="hover:bg-muted flex h-11 items-center rounded-md px-3 text-base"
                >
                  {label}
                </SheetClose>
              ))}
              {authenticated ? null : (
                <SheetClose
                  nativeButton={false}
                  render={<Link href="/login" />}
                  className="hover:bg-muted flex h-11 items-center rounded-md px-3 text-base"
                >
                  Sign in
                </SheetClose>
              )}
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}

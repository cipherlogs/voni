import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { VoniLogo } from "@/components/voni-logo";
import { FooterYear, PUBLIC_CONTAINER, SiteFooter } from "@/components/site-footer";

/** Shared frame for /privacy and /terms: plain prose on the public measure. */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <div className="bg-background flex min-h-svh flex-col">
      <header className="border-b">
        <div className={`${PUBLIC_CONTAINER} flex h-14 items-center md:h-16`}>
          <Link href="/" aria-label="Voni home">
            <VoniLogo size="sm" wordmark className="text-lg" />
          </Link>
        </div>
      </header>
      <main className={`${PUBLIC_CONTAINER} flex-1 py-12`}>
        <article className="text-foreground/85 mx-auto flex max-w-2xl flex-col gap-4 text-base leading-7 [&_a]:underline [&_h2]:text-foreground [&_h2]:pt-4 [&_h2]:text-lg [&_h2]:font-semibold [&_ul]:list-disc [&_ul]:pl-5">
          <h1 className="text-foreground text-3xl font-semibold tracking-tight">{title}</h1>
          <p className="text-muted-foreground text-sm">Last updated {updated}</p>
          {children}
        </article>
      </main>
      <SiteFooter
        year={
          <Suspense fallback={<span>© Voni</span>}>
            <FooterYear />
          </Suspense>
        }
      />
    </div>
  );
}

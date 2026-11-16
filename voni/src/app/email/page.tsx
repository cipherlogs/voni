import type { Metadata } from "next";
import Link from "next/link";
import { MailIcon } from "lucide-react";
import { EmailPoolPanel } from "@/components/email-pool-panel";
import { Badge } from "@/components/ui/badge";
import { PUBLIC_CONTAINER } from "@/lib/public-container";
import { VoniLogo } from "@/components/voni-logo";

/**
 * The public `/email` link. It used to 307 to an affiliate; it is a page now:
 * one drawn target and one claimed source per visit, fetched by every Worker in
 * the pool, with the report rendered here. Public on purpose — no login, no
 * data stored — and noindex so it never shows up in search.
 */
export const metadata: Metadata = {
  title: "Email pool · Voni",
  description:
    "Fans out one drawn target to every Cloudflare edge Worker in the pool and shows what each one saw.",
  robots: { index: false, follow: false },
};

export default function EmailPoolPage() {
  return (
    <main className="flex min-h-svh flex-1 flex-col">
      <header className="border-b">
        <div
          className={`${PUBLIC_CONTAINER} flex h-14 items-center justify-between`}
        >
          <Link href="/" aria-label="Voni home">
            <VoniLogo wordmark />
          </Link>
          <Badge variant="outline">Email pool</Badge>
        </div>
      </header>

      <div className={`${PUBLIC_CONTAINER} flex flex-col gap-6 py-8 md:py-10`}>
        <div className="flex max-w-2xl flex-col gap-2">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <MailIcon className="size-5" />
            Email pool
          </h1>
          <p className="text-muted-foreground text-sm">
            Opening this link draws one target and one source, then asks every
            Worker in the pool to fetch that target from its own edge location,
            following redirects wherever they lead. Targets are pages on voni.cc
            or off-site affiliate links — chosen server-side, never by the
            browser — and nothing is stored beyond the visit id shown below. Run
            it again for a new draw.
          </p>
        </div>

        <EmailPoolPanel />
      </div>
    </main>
  );
}

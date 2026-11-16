import type { Metadata } from "next";
import Link from "next/link";
import { FingerprintIcon } from "lucide-react";
import { FingerprintTestPanel } from "@/components/fingerprint-test-panel";
import { Badge } from "@/components/ui/badge";
import { PUBLIC_CONTAINER } from "@/lib/public-container";
import { VoniLogo } from "@/components/voni-logo";

/**
 * A scratch page for the Fingerprint JS Pro round trip. Public on purpose —
 * no login, no data stored — and noindex so it never shows up in search.
 */
export const metadata: Metadata = {
  title: "Fingerprint test · Voni",
  description:
    "Checks the Fingerprint browser identification and the server-side event lookup.",
  robots: { index: false, follow: false },
};

export default function FingerprintTestPage() {
  return (
    <main className="flex min-h-svh flex-1 flex-col">
      <header className="border-b">
        <div
          className={`${PUBLIC_CONTAINER} flex h-14 items-center justify-between`}
        >
          <Link href="/" aria-label="Voni home">
            <VoniLogo wordmark />
          </Link>
          <Badge variant="outline">Test page</Badge>
        </div>
      </header>

      <div className={`${PUBLIC_CONTAINER} flex flex-col gap-6 py-8 md:py-10`}>
        <div className="flex max-w-2xl flex-col gap-2">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <FingerprintIcon className="size-5" />
            Fingerprint test
          </h1>
          <p className="text-muted-foreground text-sm">
            Identifies this browser with the public key, then looks the
            resulting event up in Fingerprint&apos;s Server API with the secret
            key. Nothing is stored, no session is required, and each page load
            performs one billable identification plus one server lookup.
          </p>
        </div>

        <FingerprintTestPanel />
      </div>
    </main>
  );
}

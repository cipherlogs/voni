"use client";

import { useEffect } from "react";
import { LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { VoniLogo } from "@/components/voni-logo";

export function AuthenticatedRedirect({ destination }: { destination: string }) {
  const router = useRouter();

  useEffect(() => {
    router.replace(destination);
  }, [destination, router]);

  return (
    <div className="auth-enter flex w-full max-w-[400px] flex-col items-center gap-8">
      <Link
        href="/"
        className="cursor-pointer rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <VoniLogo size="lg" wordmark animate />
        <span className="sr-only">Voni home</span>
      </Link>

      <div
        aria-live="polite"
        className="flex w-full flex-col items-center gap-5 rounded-xl border bg-card p-8 text-center"
      >
        <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
        <div className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold tracking-tight">
            Opening your dashboard
          </h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            You are already signed in.
          </p>
        </div>
        <Button
          nativeButton={false}
          variant="outline"
          render={<Link href={destination} />}
        >
          Open dashboard
        </Button>
      </div>
    </div>
  );
}

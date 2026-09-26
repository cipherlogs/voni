"use client";

import { useState } from "react";
import { Check, Copy, Mail } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The demo's test inbox address, shown on the call card once Voni invites
 * the email test (DESIGN.md §10c amendment: the one non-transcript item on
 * the demo card). Tap copies; phones also get a `mailto:` to open Mail.
 */
export function DemoAddressChip({ address, className }: { address: string; className?: string }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied("copied");
    } catch {
      // Insecure context or a denied permission: the address stays selectable.
      setCopied("failed");
    }
  };
  return (
    <div data-testid="demo-address-chip" className={cn("flex items-center justify-center gap-2", className)}>
      <Button
        type="button"
        variant="outline"
        onClick={copy}
        aria-label={`Copy ${address}`}
        className="h-11 min-w-0 gap-2 rounded-full px-4 text-sm font-medium"
      >
        {copied === "copied" ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
        <span className="truncate select-all">{address}</span>
      </Button>
      <a
        href={`mailto:${address}`}
        aria-label={`Email ${address}`}
        className={cn(
          buttonVariants({ variant: "outline" }),
          "hidden size-11 shrink-0 rounded-full p-0 pointer-coarse:inline-flex",
        )}
      >
        <Mail className="size-4" aria-hidden />
      </a>
      <span role="status" className="sr-only">
        {copied === "copied" ? "Address copied" : copied === "failed" ? "Couldn't copy. Select the address instead." : ""}
      </span>
    </div>
  );
}

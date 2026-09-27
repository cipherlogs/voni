"use client";

import { useState } from "react";
import { Check, Copy, Mail } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The demo's test inbox address and the visitor's Test tag, shown on the call
 * card once Voni invites the email test (DESIGN.md §10c amendment: the one
 * non-transcript item on the demo card). Each copies on tap; phones also get
 * a `mailto:` that opens Mail with the tag as the subject.
 */
export function DemoAddressChip({ address, tag, className }: { address: string; tag: string; className?: string }) {
  const [copied, setCopied] = useState<{ what: string; ok: boolean } | null>(null);
  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied({ what, ok: true });
    } catch {
      // Insecure context or a denied permission: the text stays selectable.
      setCopied({ what, ok: false });
    }
  };
  const pill = (what: string, label: string, text: string) => (
    <Button
      type="button"
      variant="outline"
      onClick={() => copy(what, text)}
      aria-label={`Copy ${label} ${text}`}
      className="h-11 min-w-0 gap-2 rounded-full px-4 text-sm font-medium"
    >
      {copied?.what === what && copied.ok ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      <span className="truncate select-all">{text}</span>
    </Button>
  );
  return (
    <div data-testid="demo-address-chip" className={cn("flex flex-wrap items-center justify-center gap-2", className)}>
      {pill("address", "address", address)}
      <span className="flex items-center gap-2">
        <span className="text-foreground/70 text-xs">Subject</span>
        {pill("tag", "tag", tag)}
      </span>
      <a
        href={`mailto:${address}?subject=${encodeURIComponent(tag)}`}
        aria-label={`Email ${address} with subject ${tag}`}
        className={cn(
          buttonVariants({ variant: "outline" }),
          "hidden size-11 shrink-0 rounded-full p-0 pointer-coarse:inline-flex",
        )}
      >
        <Mail className="size-4" aria-hidden />
      </a>
      <span role="status" className="sr-only">
        {copied ? (copied.ok ? `${copied.what === "tag" ? "Tag" : "Address"} copied` : "Couldn't copy. Select it instead.") : ""}
      </span>
    </div>
  );
}

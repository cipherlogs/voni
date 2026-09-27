"use client";

import { useState } from "react";
import { Check, Copy, Mail } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The demo's test inbox address and the visitor's Test tag, shown on the call
 * card once Voni invites the email test (DESIGN.md §10c amendment: the one
 * non-transcript item on the demo card). Each copies on tap. On phones the
 * address also opens Mail with the tag as the subject, in the same tap
 * (owner, 2026-09-27); desktop keeps a separate mail button, since a mail
 * link there often opens nothing.
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
  const mailto = `mailto:${address}?subject=${encodeURIComponent(tag)}`;
  const pillClass = "h-9 min-w-0 shrink gap-1.5 rounded-full px-3 text-xs font-medium";
  const icon = (what: string) =>
    copied?.what === what && copied.ok ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />;
  const pill = (what: string, label: string, text: string, className?: string) => (
    <Button
      type="button"
      variant="outline"
      onClick={() => copy(what, text)}
      aria-label={`Copy ${label} ${text}`}
      // `shrink` undoes the Button base's shrink-0, so a long address truncates instead of wrapping the row.
      className={cn(pillClass, className)}
    >
      {icon(what)}
      <span className="truncate select-all">{text}</span>
    </Button>
  );
  return (
    // One row at every width: the address gives way first (it stays copyable and in the mailto).
    <div data-testid="demo-address-chip" className={cn("flex min-w-0 items-center justify-center gap-1.5", className)}>
      {pill("address", "address", address, "pointer-coarse:hidden")}
      {/* Phones: one tap copies the address and opens Mail with the tag as the subject. */}
      <a
        href={mailto}
        onClick={() => void copy("address", address)}
        aria-label={`Email ${address} with subject ${tag}`}
        className={cn(buttonVariants({ variant: "outline" }), pillClass, "hidden pointer-coarse:inline-flex")}
      >
        {icon("address")}
        <span className="truncate">{address}</span>
      </a>
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="text-foreground/70 text-xs">Subject</span>
        {pill("tag", "tag", tag)}
      </span>
      <a
        href={mailto}
        aria-label={`Open your mail app to email ${address}`}
        className={cn(buttonVariants({ variant: "outline" }), "size-9 shrink-0 rounded-full p-0 pointer-coarse:hidden")}
      >
        <Mail className="size-3.5" aria-hidden />
      </a>
      <span role="status" className="sr-only">
        {copied ? (copied.ok ? `${copied.what === "tag" ? "Tag" : "Address"} copied` : "Couldn't copy. Select it instead.") : ""}
      </span>
    </div>
  );
}

"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/toast";

/**
 * The control lock and unlock actions end in a redirect, so their outcome
 * arrives as one of two fixed query values rather than as returned state. The
 * panel has one surface for outcomes — the toast — so the notice is announced
 * once here and the query string is cleaned, which keeps a reload from saying
 * it again.
 *
 * The copy is chosen from the closed union below, never from the URL, so
 * `?notice=<anything>` cannot put attacker text in the toast.
 */
export type ControlNotice = "unlocked" | "locked";

const COPY: Record<ControlNotice, { title: string; description: string }> = {
  unlocked: {
    title: "Controls unlocked",
    description: "Controls unlocked for 12 hours.",
  },
  locked: {
    title: "Controls locked",
    description: "Controls locked. This panel is read-only again.",
  },
};

export function ControlNoticeToast({ notice }: { notice: ControlNotice | null }) {
  const router = useRouter();
  // A ref, not state: the effect must not re-run (and re-toast) when the
  // navigation below re-renders this component.
  const announced = useRef(false);

  useEffect(() => {
    if (!notice || announced.current) return;
    announced.current = true;

    const { title, description } = COPY[notice];
    toast.add({
      title,
      description,
      type: notice === "unlocked" ? "success" : "info",
      timeout: 6_000,
    });

    // The action's redirect keeps the query string; dropping it keeps the URL
    // shareable and a reload quiet. Scroll stays put — this is a cleanup, not a
    // navigation the operator asked for.
    router.replace("/email", { scroll: false });
  }, [notice, router]);

  return null;
}

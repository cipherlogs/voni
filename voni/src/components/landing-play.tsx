"use client";

import { useEffect } from "react";

/**
 * Stamps `data-inview` on each `[data-play]` section the first time it
 * scrolls into view, so its decorative pictures play once (globals.css
 * `[data-inview] .landing-*`) instead of looping off-screen. Renders nothing;
 * without it every picture simply shows its finished frame.
 */
export function LandingPlay() {
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.setAttribute("data-inview", "");
        observer.unobserve(entry.target);
      }
    });
    document.querySelectorAll("[data-play]").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);
  return null;
}

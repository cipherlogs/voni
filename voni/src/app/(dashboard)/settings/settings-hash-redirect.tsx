"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { settingsHashTarget } from "@/lib/settings-tabs";

/**
 * Legacy-hash redirect (ticket 02): tabbed settings never had deep URLs, so
 * `#voice`-style fragments are the only bookmarkable past. Fragments never
 * reach the server, so the landing resolves them here on mount and replaces
 * them with the real `/settings/<tab>` route. Unrecognized hashes stay put.
 */
export function SettingsHashRedirect() {
  const router = useRouter();
  useEffect(() => {
    const target = settingsHashTarget(window.location.hash);
    if (target) router.replace(`/settings/${target}`);
  }, [router]);
  return null;
}

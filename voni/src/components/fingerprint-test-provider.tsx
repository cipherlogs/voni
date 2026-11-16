"use client";

import type { PropsWithChildren } from "react";
import { FingerprintProvider } from "@fingerprint/react";

/**
 * Fingerprint's *public* API key. It is safe in the browser by design — the
 * SDK sends it on every identification request. The secret key the server
 * route needs is a different value and lives only in `.env.local` as
 * `FINGERPRINT_SECRET_API_KEY`; never put it here, in `NEXT_PUBLIC_*`, or in
 * any client bundle.
 */
const PUBLIC_API_KEY = "QVTz4PvJUUtPvQEm9fmo";

/**
 * The provider mounts the JS agent for everything under it, so it is scoped to
 * the `/test` segment instead of the root layout: the rest of the app must not
 * pay for a script it never calls.
 *
 * `region="us"` is Fingerprint's Global region (`api.fpjs.io`). An EU or AP
 * key must switch this to `eu` / `ap` *and* the base URL in
 * `src/app/api/test/fingerprint/route.ts`, or identification succeeds while
 * server lookups 403.
 */
export function FingerprintTestProvider({ children }: PropsWithChildren) {
  return (
    <FingerprintProvider apiKey={PUBLIC_API_KEY} region="us">
      {children}
    </FingerprintProvider>
  );
}

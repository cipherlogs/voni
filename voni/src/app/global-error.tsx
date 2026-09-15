"use client";

import { RouteError } from "@/components/route-error";
import "./globals.css";

/**
 * Last-resort boundary for errors the root layout itself throws while
 * rendering — everything else is caught by a route segment's own error.tsx.
 * Must define its own <html>/<body>: it replaces the root layout when active.
 * Delegates to the shared RouteError card so app-level and segment-level
 * failures read as one system.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <body className="bg-background text-foreground flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <RouteError error={error} retry={retry} />
        </div>
      </body>
    </html>
  );
}

"use client";

import "./globals.css";

/**
 * Last-resort boundary for errors the root layout itself throws while
 * rendering — everything else is caught by a route segment's own error.tsx.
 * Must define its own <html>/<body>: it replaces the root layout when active.
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
        <div className="flex max-w-sm flex-col items-center gap-4 text-center">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-muted-foreground text-sm">
            {error.message || "The app hit an unexpected error. Try again."}
          </p>
          <button
            type="button"
            onClick={() => retry()}
            className="cursor-pointer rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}

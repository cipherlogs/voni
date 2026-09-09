/**
 * Narrow client authentication-state context for the persistent signed-in
 * shell (myplan.md Task 8).
 *
 * Presentation + provider-readiness only — it NEVER authorizes server
 * operations. Every private data function, action, and route handler still
 * verifies authorization itself.
 *
 * Flow: the synchronous dashboard layout renders its generic frame with this
 * provider in `pending` state. A server auth resolver inside a Suspense
 * boundary performs the existing session + operator checks, then renders
 * `ShellAuthBridge` with the snapshot. The bridge commits the snapshot in an
 * effect (never during another component's render); equivalent snapshots are
 * ignored so provider state is not repeatedly reset.
 */

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ShellAuthState =
  | { status: "pending" }
  | {
      status: "authenticated";
      user: {
        id: string;
        name: string;
        email: string;
        image: string | null;
      };
      platformAdmin: boolean;
    }
  | { status: "unavailable" };

type ShellAuthContextValue = {
  snapshot: ShellAuthState;
  publish: (next: ShellAuthState) => void;
};

const ShellAuthContext = createContext<ShellAuthContextValue | null>(null);

function sameSnapshot(a: ShellAuthState, b: ShellAuthState): boolean {
  if (a.status !== b.status) return false;
  if (a.status === "authenticated" && b.status === "authenticated") {
    return (
      a.user.id === b.user.id &&
      a.user.name === b.user.name &&
      a.user.email === b.user.email &&
      (a.user.image ?? null) === (b.user.image ?? null) &&
      a.platformAdmin === b.platformAdmin
    );
  }
  return true;
}

export function ShellAuthProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<ShellAuthState>({ status: "pending" });
  // Stable publisher that drops equivalent snapshots so enabling providers
  // once stays once across re-renders and route changes.
  const publish = useCallback((next: ShellAuthState) => {
    setSnapshot((prev) => (sameSnapshot(prev, next) ? prev : next));
  }, []);
  const value = useMemo(() => ({ snapshot, publish }), [snapshot, publish]);
  return <ShellAuthContext.Provider value={value}>{children}</ShellAuthContext.Provider>;
}

export function useShellAuth(): ShellAuthState {
  const ctx = useContext(ShellAuthContext);
  if (!ctx) throw new Error("useShellAuth must be used inside ShellAuthProvider.");
  return ctx.snapshot;
}

/**
 * Rendered by the server auth resolver after it completes the existing
 * session + operator checks. Publishes the snapshot post-commit.
 */
export function ShellAuthBridge({ snapshot }: { snapshot: ShellAuthState }) {
  const ctx = useContext(ShellAuthContext);
  // Re-publish when the resolved snapshot actually changes (e.g. identity
  // change); the publisher itself drops equivalent snapshots.
  const key = JSON.stringify(snapshot);
  useEffect(() => {
    ctx?.publish(snapshot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, key]);
  return null;
}

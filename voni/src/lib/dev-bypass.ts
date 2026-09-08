/**
 * Dev-only shortcut past Google sign-in, for local UI verification without a
 * live OAuth session (Google's own sign-in flow refuses automated/embedded
 * browsers, which otherwise makes the dashboard unreachable for that kind of
 * check). Gated on two independent conditions — a non-production build AND
 * an explicit opt-in env var in `.env.local` — so it can't activate by
 * accident, and can't activate at all in a deployed build even if the var
 * leaked into the environment.
 */
export function devBypassEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.DEV_BYPASS_AUTH === "true"
  );
}

export const DEV_BYPASS_USER = {
  id: "dev-bypass-user",
  name: "Dev User",
  email: "dev@localhost",
  image: null as string | null,
};

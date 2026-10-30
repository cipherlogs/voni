import { createDemoTokenHandler } from "@/lib/demo/mint";

/**
 * Public demo token — the one door to a demo call, and the only client the
 * cascade pipeline has (demo-cascade ticket 09).
 *
 * There is nothing here to read: the controls live in `lib/demo/mint.ts`, one
 * injected step each, so the route test drives the real handler with the
 * rate-limit store and the pipeline faked. The four controls are unchanged:
 *
 * 1. **A server-built stored body.** The app assembles and signs the demo body
 *    locally with the one stored-body builder — never an inline prompt, never a
 *    vendor stored agent. The browser receives identity only.
 * 2. **Rate limits, per-IP and global.** Per-IP stops one person hammering it;
 *    the global daily cap is what bounds the bill against a crowd or a botnet.
 * 3. **A server-enforced wall cap.** `maxSessionSeconds` is the client's bound
 *    and the pipeline enforces its own per-call ceiling.
 * 4. **Validated inputs.** The voice is checked against the demo roster before
 *    any tag, call or delivery exists; the subject is always `demo:<voice>`.
 *
 * There is no managed fallback: a refused or unconfigured pipeline is the
 * visitor's unavailable state, and the response carries no session token for
 * another engine.
 */
export const POST = createDemoTokenHandler();

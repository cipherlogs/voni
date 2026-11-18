"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIp } from "@/lib/demo/rate-limit";
import { secret } from "@/lib/env";
import { describePlan, planBurst } from "@/lib/burst/plan";
import { dispatchBurst } from "@/lib/burst/dispatch";
import type { BurstState } from "@/lib/burst/state";
import { recordAffiliateClick } from "@/lib/email/clicks";
import { simulateOneClick } from "@/lib/email/click-simulator";
import {
  EMAIL_CONTROL_COOKIE,
  controlCookieMatches,
  controlCookieValue,
  safeSecretEqual,
} from "@/lib/email/control";
import {
  PAGE_COOKIE,
  isPageUnlocked,
  pageGateCookieOptions,
  pagePasswordDigest,
} from "@/lib/email/page-gate";
import {
  nextEmailProvider,
  nextEmailTarget,
  resolveTarget,
} from "@/lib/email/pool";
import {
  spendUnlockAttempt,
  type ThrottleVerdict,
  type UnlockScope,
} from "@/lib/email/unlock-throttle";
import { clicksPerDay, validateVolume } from "@/lib/email/volume";
import { buildCheckScript } from "@/lib/email/check-script";
import {
  AFFILIATE_CHECK_JOB,
  getCheck,
  resolveCheckId,
  updateCheck,
  uploadCheckScript,
  type SyntheticResult,
} from "@/lib/grafana/synthetic";

/**
 * Mutations for the `/email` affiliate click control panel.
 *
 * Every action is a public endpoint once it is exported from a `"use server"`
 * file, so authorisation happens *inside each body*: the client's locked /
 * unlocked rendering is a convenience, never a gate. A request that reaches
 * `saveVolume` without the control cookie gets the same refusal as one that
 * never rendered the panel at all.
 *
 * The two password forms are the only paths that run before any cookie exists,
 * so they are the only ones a stranger can hammer; both spend a DB-backed
 * attempt budget *before* comparing anything (see `throttleUnlocks`).
 *
 * The control cookie is minted and verified through `@/lib/email/control`, the
 * same module the page reads with. A local copy of the digest here could drift
 * from the page's and render the panel unlocked while every write refuses.
 *
 * What is deliberately absent: the submitted secret is never logged, a failed
 * unlock never says whether `EMAIL_CONTROL_SECRET` is set, and no Grafana or
 * target response body is read into a result. The panel shows curated messages,
 * not upstream text that may quote a token or an arbitrary URL.
 */

const WRONG_SECRET = "Wrong secret.";
const WRONG_PASSWORD = "Wrong password.";

/**
 * Spend one attempt against the shared budget.
 *
 * The policy (order, limits, window, fail-closed verdict) lives in
 * `@/lib/email/unlock-throttle` so a test can drive it with a fake store; this
 * wrapper only supplies the two things it cannot know: which form is asking,
 * and the caller's IP.
 *
 * The header order belongs to `clientIp` (Cloudflare's `cf-connecting-ip`
 * first), not to this file — one reader for every public form.
 */
async function throttleUnlocks(scope: UnlockScope): Promise<ThrottleVerdict> {
  return spendUnlockAttempt({ scope, ip: clientIp(await headers()) });
}

/**
 * The result shape every action returns to its form.
 */
export type ControlState = {
  ok: boolean;
  message?: string;
  error?: string;
};

/**
 * A refusal that looks like a wrong password and adds only the wait.
 *
 * It deliberately opens with the action's own wrong-password sentence: a
 * throttled request that happens to carry the right password must be
 * indistinguishable from a throttled wrong one.
 */
function throttled(wrongPassword: string, retryAfterSeconds: number): ControlState {
  return {
    ok: false,
    error: `${wrongPassword} Too many attempts; try again in ${retryAfterSeconds} seconds.`,
  };
}

const LOCKED: ControlState = {
  ok: false,
  error: "Controls are locked. Unlock the panel first.",
};

function locked(): ControlState {
  return { ...LOCKED };
}

function burstLocked(): BurstState {
  return { ok: false, error: LOCKED.error };
}

/**
 * Server-side gate. The cookie holds `sha256(secret)`, so the comparison is
 * between fixed-length digests and the secret itself never travels back to the
 * browser. An unset env secret is indistinguishable from a wrong cookie: both
 * mean "locked", and neither is logged.
 *
 * The predicate is `controlCookieMatches`, the same one the page renders the
 * lock state with — not a second copy of the rule.
 */
async function requireControl(): Promise<boolean> {
  const expected = await secret("EMAIL_CONTROL_SECRET");
  if (!expected) return false;

  const cookieStore = await cookies();
  return controlCookieMatches(
    cookieStore.get(EMAIL_CONTROL_COOKIE)?.value,
    expected,
  );
}

/**
 * Map a typed Grafana failure to operator language. The module's own messages
 * are already sanitized (no token, no response body); only the "not configured"
 * case needs a sentence an operator can act on without reading Grafana docs.
 */
function describeSyntheticFailure(
  result: Extract<SyntheticResult<unknown>, { ok: false }>,
): string {
  if (result.reason === "not_configured") {
    return "Grafana credentials are not configured on this deployment.";
  }
  return result.message;
}

export async function unlockControl(
  _previous: ControlState,
  formData: FormData,
): Promise<ControlState> {
  // Before the comparison, never after: a locked-out attacker must not learn
  // anything — by answer or by timing — from a request that then has its
  // secret compared anyway. An unavailable limiter refuses too, but with a
  // message that says so rather than a rejection the form cannot render.
  const throttle = await throttleUnlocks("control");
  if (!throttle.allowed) {
    if (throttle.reason === "unavailable") {
      return { ok: false, error: throttle.error };
    }
    return throttled(WRONG_SECRET, throttle.retryAfterSeconds);
  }

  const submitted = String(formData.get("secret") ?? "");
  const expected = await secret("EMAIL_CONTROL_SECRET");

  // The same answer whether the variable is missing, the field is empty or the
  // value is wrong. Saying which would turn this form into a probe for the
  // deployment's configuration. Both sides are hashed first, so the compared
  // buffers are always 32 bytes and the timing does not depend on the input.
  if (!expected) {
    return { ok: false, error: WRONG_SECRET };
  }
  const matches =
    submitted.length > 0 && safeSecretEqual(submitted, expected);
  if (!matches) {
    return { ok: false, error: WRONG_SECRET };
  }

  const cookieStore = await cookies();
  cookieStore.set({
    name: EMAIL_CONTROL_COOKIE,
    value: controlCookieValue(expected),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/email",
    maxAge: 60 * 60 * 12,
  });
  // A redirect, not a returned message: `revalidatePath` remounts the client
  // subtree, which threw away the `useActionState` success state before it
  // rendered. The fixed notice is rendered by the page from the query string.
  revalidatePath("/email");
  redirect("/email?notice=unlocked");
}

/**
 * Drop the control cookie and return to the panel read-only.
 *
 * This function never returns normally: `redirect` rejects by design, because
 * that rejection is how Next unwinds the action into a navigation. Callers must
 * therefore tolerate a rejected promise — an un-caught `void lockControl()`
 * surfaces as an unhandled rejection — and must not render that rejection as a
 * failed lock.
 */
export async function lockControl(): Promise<ControlState> {
  const cookieStore = await cookies();
  cookieStore.delete({ name: EMAIL_CONTROL_COOKIE, path: "/email" });
  revalidatePath("/email");
  redirect("/email?notice=locked");
}

/**
 * The page gate. This is the only thing standing between an anonymous visitor
 * and the panel, so the comparison happens here on the server: the client form
 * is a convenience, never the gate.
 *
 * A missing `EMAIL_PAGE_PASSWORD` is reported as "not configured" without
 * naming the variable, and a wrong password is one fixed sentence. Nothing the
 * visitor typed is ever echoed back, and the cookie holds the digest, not the
 * password.
 *
 * The attempt budget is spent first, so a throttled request gets the
 * wrong-password refusal plus the wait even when the page is unconfigured —
 * the throttle must not become a way to ask whether the password would have
 * been right, or whether there is one at all.
 */
export async function unlockPage(
  _previous: ControlState,
  formData: FormData,
): Promise<ControlState> {
  void _previous;
  // Same order as the control form: budget first, comparison second. A limiter
  // that cannot answer still refuses — visibly, so the gate can say why.
  const throttle = await throttleUnlocks("page");
  if (!throttle.allowed) {
    // `revalidatePath` is what moves the action response into the render phase;
    // see the "not configured" branch below for why a refusal needs it.
    revalidatePath("/email");
    if (throttle.reason === "unavailable") {
      return { ok: false, error: throttle.error };
    }
    return throttled(WRONG_PASSWORD, throttle.retryAfterSeconds);
  }

  const submitted = String(formData.get("password") ?? "");
  const expected = await secret("EMAIL_PAGE_PASSWORD");

  if (!expected) {
    // `revalidatePath` is what moves the action response into the render phase.
    // Without it Next re-renders the page while still in the action phase, and
    // the gate's `cookies()` read trips a framework invariant instead of
    // showing this message. It also keeps the rendered page honest: still the
    // gate, because the cookie was never set.
    revalidatePath("/email");
    return { ok: false, error: "This page is not configured." };
  }
  if (!isPageUnlocked(pagePasswordDigest(submitted), expected)) {
    revalidatePath("/email");
    return { ok: false, error: WRONG_PASSWORD };
  }

  const cookieStore = await cookies();
  cookieStore.set({
    name: PAGE_COOKIE,
    value: pagePasswordDigest(submitted),
    ...pageGateCookieOptions(),
  });
  redirect("/email");
}

/**
 * Lock the page: drop both grants, not just the visible one.
 *
 * The page cookie decides whether the panel renders, and the control cookie
 * decides whether it writes. Deleting only the view cookie would leave a
 * "locked" screen that anyone who re-enters the page password could still
 * write with — a lock that only hides the keypad.
 */
export async function lockPage(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete({ name: PAGE_COOKIE, path: "/email" });
  cookieStore.delete({ name: EMAIL_CONTROL_COOKIE, path: "/email" });
  revalidatePath("/email");
  redirect("/email");
}

export async function saveVolume(
  _previous: ControlState,
  formData: FormData,
): Promise<ControlState> {
  if (!(await requireControl())) return locked();

  const frequencyMinutes = Number(formData.get("frequency"));
  const probeIds = formData.getAll("probe").map((value) => Number(value));
  const clicksPerRun = Number(formData.get("clicks"));
  const volume = validateVolume({
    frequencyMs: frequencyMinutes * 60_000,
    probeIds,
    clicksPerRun,
  });
  if (!volume.ok) return { ok: false, error: volume.reason };

  // The script carries the real secret, so an unset one is a refusal, not a
  // reason to write the placeholder: an uploaded placeholder script clicks
  // silently and reports nothing, which looks exactly like a healthy check.
  const reportSecret = await secret("EMAIL_CLICK_REPORT_SECRET");
  if (!reportSecret) {
    return {
      ok: false,
      error:
        "EMAIL_CLICK_REPORT_SECRET is not configured on this deployment, so the " +
        "check's script could not report its clicks. Set it and save again.",
    };
  }

  const id = resolveCheckId(await secret("EMAIL_CLICK_CHECK_ID"));

  // The script is rebuilt here from the same builder `npm run affiliate:check`
  // uses, so the uploaded copy and the committed one cannot drift. A bad count
  // is already refused by validateVolume above; the builder's own bound is the
  // backstop that keeps a hand-crafted request from writing a second source.
  let script: string;
  try {
    script = buildCheckScript({ clicksPerRun: volume.value.clicksPerRun, reportSecret });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "The check script could not be built.",
    };
  }

  // Script first, then the frequency: the stored script is what describes how
  // many clicks one run sends, so a failure between the two leaves a check that
  // still runs and reports, just at the old interval.
  const uploaded = await uploadCheckScript(
    id,
    Buffer.from(script, "utf8").toString("base64"),
    AFFILIATE_CHECK_JOB,
  );
  if (!uploaded.ok) {
    return { ok: false, error: describeSyntheticFailure(uploaded) };
  }

  const updated = await updateCheck(id, {
    frequencyMs: volume.value.frequencyMs,
    probeIds: volume.value.probeIds,
  });
  if (!updated.ok) {
    return { ok: false, error: describeSyntheticFailure(updated) };
  }

  revalidatePath("/email");
  const perDay = clicksPerDay(
    volume.value.frequencyMs,
    volume.value.probeIds.length,
    volume.value.clicksPerRun,
  );
  const { probeIds: probes, clicksPerRun: clicks, frequencyMs } = volume.value;
  const plural = probes.length === 1 ? "" : "s";
  return {
    ok: true,
    message: `Saved. This check now runs ${perDay} clicks/day: ${probes.length} probe${plural} × every ${frequencyMs / 60_000} min × ${clicks} click${clicks === 1 ? "" : "s"} per run.`,
  };
}

export async function toggleCheck(
  _previous: ControlState,
  _formData: FormData,
): Promise<ControlState> {
  // `useActionState` supplies both; a flip reads neither the prior state nor
  // the body, and ignoring them here keeps the signature the form expects.
  void _previous;
  void _formData;
  if (!(await requireControl())) return locked();

  const id = resolveCheckId(await secret("EMAIL_CLICK_CHECK_ID"));
  const current = await getCheck(id);
  if (!current.ok) {
    return { ok: false, error: describeSyntheticFailure(current) };
  }

  const updated = await updateCheck(id, { enabled: !current.data.enabled });
  if (!updated.ok) {
    return { ok: false, error: describeSyntheticFailure(updated) };
  }

  revalidatePath("/email");
  return {
    ok: true,
    message: updated.data.enabled ? "Check resumed." : "Check paused.",
  };
}

/**
 * One click, right now, from the server this app runs on. This exists to prove
 * the target and the attribution work without waiting for Grafana's next run —
 * so the result must not imply Grafana produced it. The target and source are
 * drawn by the pool's own bags, which keeps this from becoming an open proxy.
 */
export async function runOneOffClick(
  _previous: ControlState,
  _formData: FormData,
): Promise<ControlState> {
  // The target and source are drawn server-side; the form body has nothing to
  // say about either, which is what keeps this from being an open proxy.
  void _previous;
  void _formData;
  if (!(await requireControl())) return locked();

  const source = nextEmailProvider();
  const target = resolveTarget(nextEmailTarget(), source);

  // The identity, headers and redirect behaviour live in one place so this
  // button and the Grafana check cannot drift apart.
  const click = await simulateOneClick({ target, source });
  const { status, finalUrl, ms, userAgent, device, browser } = click;
  const transportError = status === null;

  try {
    await recordAffiliateClick({
      target,
      source,
      finalUrl,
      status,
      ms,
      ranAt: new Date(),
      userAgent,
      device,
      browser,
    });
  } catch {
    return {
      ok: false,
      error:
        "The click ran from voni's server, not Grafana, but it could not be recorded. The click history is unchanged.",
    };
  }

  revalidatePath("/email");

  if (transportError) {
    return {
      ok: false,
      error:
        "The click ran from voni's server, not Grafana, but the target did not answer. The attempt is recorded.",
    };
  }

  // A refused redirect hop is a failure even though the last status was a
  // redirect, so the simulator's verdict — not the status code — decides. Two
  // different events, two different sentences: a target that answered non-2xx
  // is a fact about the target and worth quoting; a hop or scheme refusal is a
  // fact about the chain, and it must not quote the address it tried to reach.
  if (!click.ok) {
    const answered = status !== null && (status < 200 || status >= 400);
    if (answered) {
      return {
        ok: false,
        error:
          `The click ran from voni's server, not Grafana, but the target answered HTTP ${status}. ` +
          "The attempt is recorded.",
      };
    }
    return {
      ok: false,
      error:
        "The click ran from voni's server, not Grafana, but the visit was stopped before the chain finished. " +
        "The attempt is recorded.",
    };
  }

  return {
    ok: true,
    message:
      `One click ran from voni's server, not Grafana: HTTP ${status ?? "—"} in ${ms} ms. ` +
      "The row is in the table below.",
  };
}

/**
 * Send a burst: the one action here that spends money elsewhere.
 *
 * The planner owns every bound — clicks, duration, zones, VUs, VU-hours — so a
 * hand-crafted request cannot ask for more than `planBurst` allows. Dispatch is
 * two shapes of success on purpose: with a token the workflow owns the run,
 * without one the operator gets the exact `k6 cloud run` line instead of an
 * error, because a missing token is a configuration choice, not a failure.
 */
export async function runBurst(
  _previous: BurstState,
  formData: FormData,
): Promise<BurstState> {
  void _previous;
  if (!(await requireControl())) return burstLocked();

  const clicks = Number(formData.get("clicks"));
  const durationMinutes = Number(formData.get("duration"));
  const zoneIds = formData.getAll("zone").map((value) => String(value));

  const planned = planBurst({
    clicks,
    durationSec: Math.round(durationMinutes * 60),
    zoneIds,
  });
  if (!planned.ok) return { ok: false, error: planned.reason };

  const result = await dispatchBurst(planned.plan);
  if (!result.ok) return { ok: false, error: result.error };

  if (result.mode === "manual") {
    return {
      ok: true,
      message:
        "No dispatch token is configured, so nothing was queued — run this line yourself:",
      fallback: result.fallback,
    };
  }

  return {
    ok: true,
    message:
      `${describePlan(planned.plan)}. The workflow is queued; its progress is in the run list.`,
    runUrl: result.runUrl,
  };
}

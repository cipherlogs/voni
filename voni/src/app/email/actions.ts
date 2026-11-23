"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIp } from "@/lib/demo/rate-limit";
import { secret } from "@/lib/env";
import { describePlan, planBurst } from "@/lib/burst/plan";
import { dispatchBurst } from "@/lib/burst/dispatch";
import type { BurstState } from "@/lib/burst/state";
import type { TargetState } from "@/lib/email/target-state";
import { lastClickByTargetUrl, recordAffiliateClick } from "@/lib/email/clicks";
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
import { nextEmailProvider, baseTargetUrl, resolveTarget } from "@/lib/email/pool";
import {
  TARGET_SELECTION_DEFAULT,
  TARGET_SELECTION_LEGACY,
  parseTargetSelection,
  pickTarget,
  type TargetSelection,
} from "@/lib/email/target-selection";
import {
  activeTargetUrls,
  addAffiliateTarget,
  listAffiliateTargets,
  removeAffiliateTarget,
  setAffiliateTargetEnabled,
} from "@/lib/email/targets";
import {
  canonicalTargetUrl,
  invalidTargetMessage,
  targetHost,
  targetUrlProblem,
} from "@/lib/email/target-url";
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

function targetLocked(): TargetState {
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

  // The mode is the operator's choice, so a request without one is a refusal,
  // not a reason to save the default: a stale or hand-built form would
  // otherwise flip a rotating check to random while claiming success.
  const selection = parseTargetSelection(formData.get("selection"));
  if (selection === null) {
    return {
      ok: false,
      error: "Choose how each click picks its target: Random or Rotate through all.",
    };
  }

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
  // uses, so the uploaded copy and the committed one cannot drift. The target
  // list is read fresh: the same script inlines it, and defaulting to the seed
  // here would resurrect every paused or removed target on a volume save.
  const targets = await activeTargetUrls();
  const uploadError = await uploadRebuiltCheck({
    clicksPerRun: volume.value.clicksPerRun,
    targets,
    selection,
  });
  if (uploadError !== null) return { ok: false, error: uploadError };

  // Script first, then the frequency: the stored script is what describes how
  // many clicks one run sends, so a failure between the two leaves a check that
  // still runs and reports, just at the old interval.

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
    message:
      `Saved. This check now runs ${perDay} clicks/day: ${probes.length} probe${plural} × every ${frequencyMs / 60_000} min × ${clicks} click${clicks === 1 ? "" : "s"} per run.` +
      ` Targets are drawn ${selection === "random" ? "at random" : "by rotating through every active target"}.`,
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
 * Rebuild and upload the check's script.
 *
 * Both the volume form and every target change land here, because the same
 * text carries both facts: the target list is inlined and `CLICKS_PER_RUN` is
 * read back from Grafana's stored copy. One path means a target edit cannot
 * reset the count and a volume save cannot resurrect a paused URL.
 *
 * Returns `null` on success, or the sentence to show instead.
 */
async function uploadRebuiltCheck(change: {
  clicksPerRun: number;
  targets: readonly string[];
  selection: TargetSelection;
}): Promise<string | null> {
  const reportSecret = await secret("EMAIL_CLICK_REPORT_SECRET");
  if (!reportSecret) {
    return (
      "EMAIL_CLICK_REPORT_SECRET is not configured on this deployment, so the " +
      "check's script could not be rebuilt. Nothing was changed."
    );
  }

  const id = resolveCheckId(await secret("EMAIL_CLICK_CHECK_ID"));

  let script: string;
  try {
    script = buildCheckScript({
      clicksPerRun: change.clicksPerRun,
      reportSecret,
      targets: change.targets,
      selection: change.selection,
    });
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "The check script could not be built.";
  }

  const uploaded = await uploadCheckScript(
    id,
    Buffer.from(script, "utf8").toString("base64"),
    AFFILIATE_CHECK_JOB,
  );
  if (!uploaded.ok) return describeSyntheticFailure(uploaded);
  return null;
}

/** Push a target list using the click count and mode Grafana already has stored. */
async function pushTargetsToCheck(
  targets: readonly string[],
): Promise<string | null> {
  const id = resolveCheckId(await secret("EMAIL_CLICK_CHECK_ID"));
  const current = await getCheck(id);
  if (!current.ok) return describeSyntheticFailure(current);
  return uploadRebuiltCheck({
    clicksPerRun: current.data.clicksPerRun,
    targets,
    // The mode lives in the same stored script as the count. An unmarked script
    // is "no choice yet", so this rebuild applies the new default (random); a
    // marked one is preserved, because a target add or pause must not silently
    // flip the mode the operator chose.
    selection: current.data.targetSelection ?? TARGET_SELECTION_DEFAULT,
  });
}

/**
 * Apply one target change to both sides.
 *
 * The script goes first — a Grafana refusal then leaves both sides untouched —
 * and if the row write fails afterwards the previous list is pushed back, so
 * the probes never keep clicking a URL the table no longer has. `saveVolume`
 * has the same order because it only changes the count.
 */
async function applyTargetChange(
  change: { previous: readonly string[]; next: readonly string[] },
  write: () => Promise<{ ok: true } | { ok: false; error: string }>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const uploadError = await pushTargetsToCheck(change.next);
  if (uploadError !== null) return { ok: false, error: uploadError };

  let result: { ok: true } | { ok: false; error: string };
  try {
    result = await write();
  } catch {
    result = { ok: false, error: "The target list could not be saved." };
  }
  if (result.ok) return { ok: true };

  const rollback = await pushTargetsToCheck(change.previous);
  return {
    ok: false,
    error:
      result.error +
      (rollback === null
        ? " Nothing was changed: the check was put back to the previous list."
        : " The check may still click the new list until the next change."),
  };
}

/** One refusal for both pause and remove, so the rule reads the same twice. */
const NO_ACTIVE_TARGETS =
  "That would leave no active target, so the check would click nothing. " +
  "Add another target, or keep this one active.";

/**
 * Add a target from the panel. The canonical URL is the row's identity, so
 * adding one twice is a confirmation rather than a duplicate in the bag.
 */
export async function addTarget(
  _previous: TargetState,
  formData: FormData,
): Promise<TargetState> {
  void _previous;
  if (!(await requireControl())) return targetLocked();

  const raw = String(formData.get("url") ?? "");
  const problem = targetUrlProblem(raw);
  if (problem !== null) {
    return { ok: false, error: invalidTargetMessage(problem) };
  }
  const url = canonicalTargetUrl(raw);

  const targets = await listAffiliateTargets();
  const existing = targets.find((target) => target.url === url);
  if (existing) {
    return {
      ok: true,
      message: existing.enabled
        ? `${targetHost(url)} is already in the list.`
        : `${targetHost(url)} is in the list but paused. Resume it on its row ` +
          "to start clicking it again.",
    };
  }

  const active = targets
    .filter((target) => target.enabled)
    .map((target) => target.url);
  const change = await applyTargetChange(
    { previous: active, next: [...active, url] },
    () => addAffiliateTarget(url),
  );
  if (!change.ok) return { ok: false, error: change.error };

  revalidatePath("/email");
  return {
    ok: true,
    message:
      `Added ${targetHost(url)}. The check was rebuilt and now draws from ` +
      `${active.length + 1} active target${active.length === 0 ? "" : "s"}.`,
  };
}

/**
 * Pause or resume one target. Pausing stops the draw without losing the URL,
 * which is the lever for investigating one creative: the check keeps clicking
 * the others, and one form submission puts it back.
 */
export async function toggleTarget(
  _previous: TargetState,
  formData: FormData,
): Promise<TargetState> {
  void _previous;
  if (!(await requireControl())) return targetLocked();

  const id = String(formData.get("id") ?? "");
  const enabled = formData.get("enabled") === "true";

  const targets = await listAffiliateTargets();
  const row = targets.find((target) => target.id === id);
  if (!row) {
    return { ok: false, error: "That target is no longer in the list. Reload the page." };
  }
  if (row.enabled === enabled) {
    return {
      ok: true,
      message: `${targetHost(row.url)} is already ${enabled ? "active" : "paused"}.`,
    };
  }

  const previous = targets
    .filter((target) => target.enabled)
    .map((target) => target.url);
  const next = targets
    .filter((target) => (target.id === id ? enabled : target.enabled))
    .map((target) => target.url);
  if (next.length === 0) return { ok: false, error: NO_ACTIVE_TARGETS };

  const change = await applyTargetChange({ previous, next }, () =>
    setAffiliateTargetEnabled(id, enabled),
  );
  if (!change.ok) return { ok: false, error: change.error };

  revalidatePath("/email");
  return {
    ok: true,
    message:
      `${enabled ? "Resumed" : "Paused"} ${targetHost(row.url)}. The check now ` +
      `draws from ${next.length} active target${next.length === 1 ? "" : "s"}.`,
  };
}

/**
 * Remove one target for good. Its click history stays: `affiliate_clicks` keeps
 * the URL each visit actually used, so removing a target never rewrites what
 * was sent.
 */
export async function removeTarget(
  _previous: TargetState,
  formData: FormData,
): Promise<TargetState> {
  void _previous;
  if (!(await requireControl())) return targetLocked();

  const id = String(formData.get("id") ?? "");
  const targets = await listAffiliateTargets();
  const row = targets.find((target) => target.id === id);
  if (!row) {
    return { ok: false, error: "That target is no longer in the list. Reload the page." };
  }

  const previous = targets
    .filter((target) => target.enabled)
    .map((target) => target.url);
  const remaining = targets.filter((target) => target.id !== id);
  const next = remaining
    .filter((target) => target.enabled)
    .map((target) => target.url);
  if (next.length === 0) return { ok: false, error: NO_ACTIVE_TARGETS };

  const change = await applyTargetChange({ previous, next }, () =>
    removeAffiliateTarget(id),
  );
  if (!change.ok) return { ok: false, error: change.error };

  revalidatePath("/email");
  return {
    ok: true,
    message:
      `Removed ${targetHost(row.url)}. ${next.length} target` +
      `${next.length === 1 ? "" : "s"} remain active.`,
  };
}

/**
 * One click, right now, from the server this app runs on. This exists to prove
 * the target and the attribution work without waiting for Grafana's next run —
 * so the result must not imply Grafana produced it. The form names the set of
 * target rows to draw from, never a URL, and every id is checked against the
 * enabled list before the draw: the source comes from the pool's provider bag
 * server-side. A body cannot therefore point this action at an arbitrary host,
 * which keeps it from becoming an open proxy.
 */
export async function runOneOffClick(
  _previous: ControlState,
  formData: FormData,
): Promise<ControlState> {
  void _previous;
  if (!(await requireControl())) return locked();

  // Ticked rows, as ids: a URL in the body would make this an open proxy.
  const requested = formData.getAll("target").map(String);
  if (requested.length === 0) {
    return { ok: false, error: "Select at least one target for this click." };
  }

  const targets = await listAffiliateTargets();
  const active = targets.filter((target) => target.enabled);

  // Dedupe: a repeated id must not weight the draw toward that row. The set is
  // also the staleness check — every ticked id has to still be an enabled row,
  // because drawing the remainder would quietly send fewer clicks than asked.
  const wanted = new Set(requested);
  const chosen = active.filter((target) => wanted.has(target.id));
  if (chosen.length !== wanted.size) {
    return {
      ok: false,
      error:
        "One of the selected targets is paused or no longer in the list. Reload the page.",
    };
  }

  // The candidates are the requested rows' URLs in list order, so both modes
  // draw from exactly the operator's ticked subset — never the whole list.
  const candidates = chosen.map((target) => target.url);

  // The mode is the live check's, not a form field: the scheduled clicks and
  // this button must pick targets the same way. An unmarked script is still
  // rotating, so it reads as rotate here; a failed read falls back to the
  // default — the mode only decides which of the same URLs goes next, and a
  // Grafana outage must not cost the operator the click they asked for.
  const id = resolveCheckId(await secret("EMAIL_CLICK_CHECK_ID"));
  const current = await getCheck(id);
  const selection = current.ok
    ? (current.data.targetSelection ?? TARGET_SELECTION_LEGACY)
    : TARGET_SELECTION_DEFAULT;

  // `lastClickByTargetUrl` keys by the *base* URL — the stamped click with its
  // utm params removed. A row's canonical URL is normally that key already,
  // but a target may carry its own utm params, so re-key onto the exact
  // candidate strings instead of assuming they match. Random never reads
  // history, so the query is skipped there and a click stays one query.
  const lastVisits = new Map<string, number>();
  if (selection === "rotate") {
    const byBase = await lastClickByTargetUrl();
    for (const url of candidates) {
      const at = byBase.get(baseTargetUrl(url));
      if (at !== undefined) lastVisits.set(url, at);
    }
  }
  const picked = pickTarget(candidates, selection, lastVisits);

  const source = nextEmailProvider();
  const target = resolveTarget(picked, source);

  // The identity, headers and redirect behaviour live in one place so this
  // button and the Grafana check cannot drift apart. The full list, paused
  // included, is the host allowlist a redirect chain may hop through.
  const click = await simulateOneClick({
    target,
    source,
    targets: targets.map((row) => row.url),
  });
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
      producer: "oneoff",
      runnerOs: null,
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
  // "zones" is the checkbox group's name in burst-card.tsx. These two strings
  // drifting apart costs nothing at compile time and silently makes every
  // submission empty, which reads as "you selected nothing" in the UI.
  const zoneIds = formData.getAll("zones").map((value) => String(value));

  const planned = planBurst({
    clicks,
    durationSec: Math.round(durationMinutes * 60),
    zoneIds,
  });
  if (!planned.ok) return { ok: false, error: planned.reason };

  // Today's enabled list, not the seed: a burst must click what the panel
  // shows. Empty is refused here — the workflow would otherwise keep the
  // committed seed and click targets the operator paused.
  const targets = await activeTargetUrls();
  if (targets.length === 0) {
    return {
      ok: false,
      error: "Every target is paused, so a burst would click nothing. Resume one first.",
    };
  }

  // The burst clicks the same list the check does, so it should split those
  // clicks the same way. A burst rebuilds the script, so an unmarked script
  // takes the new default (random); a failed read falls back to it too, because
  // the mode only decides which of the same URLs each click takes and a
  // Grafana outage must not cost the operator a burst.
  const id = resolveCheckId(await secret("EMAIL_CLICK_CHECK_ID"));
  const current = await getCheck(id);
  const selection = current.ok
    ? (current.data.targetSelection ?? TARGET_SELECTION_DEFAULT)
    : TARGET_SELECTION_DEFAULT;

  const result = await dispatchBurst(planned.plan, { targets, selection });
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

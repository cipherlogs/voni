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
  PAGE_COOKIE,
  isPageUnlocked,
  pageGateCookieOptions,
  pagePasswordDigest,
} from "@/lib/email/page-gate";
import { nextEmailProvider, baseTargetUrl, resolveTarget } from "@/lib/email/pool";
import {
  GITHUB_SOURCE_PRODUCER,
  readSourceConfig,
  recordSourceDispatch,
  saveSourceSchedule,
  setSourceEnabled,
} from "@/lib/email/source-config";
import {
  MAX_JOB_SECONDS,
  RUNNER_OSES,
  parseInterval,
  parseRestartSeconds,
  parseSegmentSeconds,
  parseWindowSeconds,
  parseWindowStartHour,
  windowRemainingSeconds,
  type RunnerOs,
} from "@/lib/email/sources";
import {
  cancelBrowserCheckRuns,
  dispatchBrowserCheck,
} from "@/lib/github/dispatch";
import { restartSegment } from "@/lib/github/restart";
import { currentRotation, saveRotationSetting } from "@/lib/email/rotation";
import { saveRotationMode } from "@/lib/email/rotation-save";
import { parseProxyCountry, parseProxyPoolTarget } from "@/lib/email/proxy-policy";
import { writeProxySettings } from "@/lib/email/proxy-settings";
import {
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
 * file, so authorisation happens *inside each body*: the client's rendering is
 * a convenience, never a gate. A request that reaches `saveVolume` without the
 * page grant gets the same refusal as one that never rendered the panel at all.
 *
 * There is one password. The page password decides whether the console
 * renders, and that same grant is what authorises its writes: a locked or
 * expired page has no cookie, so every write is refused. The gate is minted and
 * verified through `@/lib/email/page-gate`, the same module the page reads
 * with — a local copy of the digest here could drift from the page's and render
 * the panel unlocked while every write refuses.
 *
 * `unlockPage` is the only path that runs before any cookie exists, so it is
 * the only one a stranger can hammer; it spends a DB-backed attempt budget
 * *before* comparing anything (see `throttleUnlocks`).
 *
 * What is deliberately absent: the submitted password is never logged, a failed
 * unlock never says whether `EMAIL_PAGE_PASSWORD` is set, and no Grafana or
 * target response body is read into a result. The panel shows curated messages,
 * not upstream text that may quote a token or an arbitrary URL.
 */

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
async function throttleUnlocks(scope: "page"): Promise<ThrottleVerdict> {
  return spendUnlockAttempt({ scope, ip: clientIp(await headers()) });
}

/**
 * The result shape every action returns to its form.
 */
export type ControlState = {
  ok: boolean;
  message?: string;
  error?: string;
  /**
   * A save that landed but whose second effect did not — the setting is stored
   * and the script is stale. It is not an error: the caller did what it asked
   * for. The card renders it as its own warning, never under "could not save".
   */
  warning?: string;
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
 * The write gate. The page password is the only authorization on `/email`, so a
 * write is allowed exactly when the presentation gate in `EmailPageGate` is:
 * the same cookie, the same password, the same predicate from
 * `@/lib/email/page-gate`.
 *
 * A missing cookie is a locked or expired page; an unset `EMAIL_PAGE_PASSWORD`
 * is indistinguishable from a wrong one, so both mean "locked" and neither is
 * logged. The cookie holds the digest, so the password itself never travels
 * back to the browser.
 */
async function requirePageUnlock(): Promise<boolean> {
  const cookieStore = await cookies();
  return isPageUnlocked(
    cookieStore.get(PAGE_COOKIE)?.value,
    await secret("EMAIL_PAGE_PASSWORD"),
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
  // Budget first, comparison second. A limiter that cannot answer still
  // refuses — visibly, so the gate can say why.
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
 * Lock the page: drop the page grant, which is also the write grant.
 *
 * One cookie decides both, so deleting it returns the console to the password
 * screen and makes every write refuse in the same step. Nothing is left behind
 * that a re-entered password could write with before it is checked.
 */
export async function lockPage(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete({ name: PAGE_COOKIE, path: "/email" });
  revalidatePath("/email");
  redirect("/email");
}

/**
 * The Grafana script's own `TARGET_SELECTION` marker, or `null` when the check
 * carries none or cannot be read.
 *
 * Only the migration path calls this: once the operator saves a mode on the
 * page, the stored setting answers for every producer and the script's copy is
 * never consulted. Reading it here rather than in each caller is what stops a
 * second rule growing beside the setting.
 */
async function scriptSelection(): Promise<TargetSelection | null> {
  const id = resolveCheckId(await secret("EMAIL_CLICK_CHECK_ID"));
  const current = await getCheck(id);
  return current.ok ? current.data.targetSelection : null;
}

/**
 * The mode every producer runs with today: the page's setting, or — until that
 * setting is written for the first time — whatever the saved script carries.
 */
async function liveSelection(): Promise<TargetSelection> {
  return currentRotation(scriptSelection);
}

/**
 * Save the rotation mode: one setting, read by every producer.
 *
 * The order and the two-part outcome live in `saveRotationMode`, which takes
 * the database and Grafana as injected functions: the setting is the source of
 * truth and is written first, the script is rebuilt from the value just
 * written, and a rebuild failure is reported as "saved, script stale" — a
 * warning, not a failed save. This body only validates the form and revalidates
 * the page.
 */
export async function saveRotation(
  _previous: ControlState,
  formData: FormData,
): Promise<ControlState> {
  void _previous;
  if (!(await requirePageUnlock())) return locked();

  const selection = parseTargetSelection(formData.get("selection"));
  if (selection === null) {
    return {
      ok: false,
      error: "Choose how each click picks its target: Random or Rotate through all.",
    };
  }

  const id = resolveCheckId(await secret("EMAIL_CLICK_CHECK_ID"));
  const outcome = await saveRotationMode(selection, {
    saveSetting: saveRotationSetting,
    readCheck: async () => {
      const current = await getCheck(id);
      return current.ok
        ? { ok: true as const, clicksPerRun: current.data.clicksPerRun }
        : { ok: false as const, message: describeSyntheticFailure(current) };
    },
    readTargets: activeTargetUrls,
    rebuild: uploadRebuiltCheck,
  });

  // A failed write revalidated nothing; a stored setting did.
  if (outcome.ok) revalidatePath("/email");
  return outcome;
}

/**
 * Save the proxy card: US, and a pool target from three to eight.
 *
 * The country is validated first because it is the constraint the whole exit
 * layer rests on: a request that names another country is refused before the
 * input is read further and before anything is written, so it is never stored
 * and never passed down. The target is validated next and refused with the range
 * in the message. Only then does the single settings write run.
 *
 * A failed write says so plainly; a successful one names both facts, so the
 * toast is a receipt for what actually changed.
 */
export async function saveProxy(
  _previous: ControlState,
  formData: FormData,
): Promise<ControlState> {
  void _previous;
  if (!(await requirePageUnlock())) return locked();

  const country = parseProxyCountry(formData.get("country"));
  if (country === null) {
    return {
      ok: false,
      error:
        "The proxy country must be US. An exit in any other country is never " +
        "used, so nothing was saved.",
    };
  }

  const poolTarget = parseProxyPoolTarget(formData.get("poolTarget"));
  if (poolTarget === null) {
    return {
      ok: false,
      error:
        "The pool target must be a whole number from 3 to 8. Nothing was saved.",
    };
  }

  try {
    await writeProxySettings({ poolTarget });
  } catch {
    return {
      ok: false,
      error: "The proxy settings could not be saved, so nothing changed. Try again.",
    };
  }

  revalidatePath("/email");
  return {
    ok: true,
    message:
      `Saved. The pool holds ${poolTarget} US exits; the next client start ` +
      `fills to ${poolTarget}.`,
  };
}

export async function saveVolume(
  _previous: ControlState,
  formData: FormData,
): Promise<ControlState> {
  if (!(await requirePageUnlock())) return locked();

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
  // The mode is the page's setting, not this form's: the switch moved out of
  // this card, and the script only ever carries a copy of that choice.
  const selection = await liveSelection();
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
  if (!(await requirePageUnlock())) return locked();

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
    // The mode is the page's setting. The script's own copy is only what a
    // deployment that has never saved a setting still reports, so a target add
    // or pause can neither flip the operator's choice nor invent one.
    selection: await liveSelection(),
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
  if (!(await requirePageUnlock())) return targetLocked();

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
  if (!(await requirePageUnlock())) return targetLocked();

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
  if (!(await requirePageUnlock())) return targetLocked();

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
  if (!(await requirePageUnlock())) return locked();

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

  // The mode is the page's setting, not a form field: the scheduled clicks and
  // this button must pick targets the same way. Until the operator saves a
  // mode, the live script's own mode is the answer, and a Grafana read failure
  // at that point is tolerated — the mode only decides which of the same URLs
  // goes next, so an outage must not cost the operator the click they asked for.
  const selection = await liveSelection();

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
      passId: null,
      // The in-app one-off click runs from the server itself: no exit, no proxy.
      exitIp: null,
      exitCountry: null,
      exitAsn: null,
      proxyKind: "none",
      failureReason: null,
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
  if (!(await requirePageUnlock())) return burstLocked();

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

  // The burst clicks the same list the check does, so it splits those clicks
  // the same way — the page's setting, not a copy of it. Until a mode is saved,
  // the live script's own mode is the answer; a Grafana outage at that point is
  // tolerated, because the mode only decides which of the same URLs each click
  // takes and an outage must not cost the operator a burst.
  const selection = await liveSelection();

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

/**
 * The one refusal an enable/disable form can produce.
 *
 * A checkbox would always send a legal value; this form posts the state it
 * wants explicitly so a hand-crafted request cannot flip the source by posting
 * nothing, and so "true"/"false" stays the whole vocabulary.
 */
const SOURCE_STATE_REASON = "Source state must be on or off.";

/**
 * Turn the GitHub source on or off.
 *
 * Only the flag moves. The schedule stays exactly as it was, so resuming a
 * source after a pause does not silently re-time it.
 */
export async function setGithubSourceEnabled(
  _previous: ControlState,
  formData: FormData,
): Promise<ControlState> {
  void _previous;
  if (!(await requirePageUnlock())) return locked();

  const raw = formData.get("enabled");
  if (raw !== "true" && raw !== "false") {
    return { ok: false, error: SOURCE_STATE_REASON };
  }
  const enabled = raw === "true";

  await setSourceEnabled(GITHUB_SOURCE_PRODUCER, enabled);
  revalidatePath("/email");

  return {
    ok: true,
    message: enabled
      ? "GitHub source enabled. It starts clicking on the next tick, inside its window."
      : "GitHub source disabled. Nothing clicks from GitHub until it is enabled again.",
  };
}

/**
 * Save the interval, window and start hour in one write.
 *
 * The parsers in `@/lib/email/sources` are the only gate — the same ones the
 * card draws its preview from and the ticker reads back — so a hand-crafted
 * interval outside the offered set is refused with the sentence that names the
 * legal values, and nothing is written. All three are parsed before the row is
 * touched, so a bad start hour cannot leave a half-applied schedule behind.
 */
export async function saveGithubSchedule(
  _previous: ControlState,
  formData: FormData,
): Promise<ControlState> {
  void _previous;
  if (!(await requirePageUnlock())) return locked();

  const interval = parseInterval(formData.get("interval"));
  if (!interval.ok) return { ok: false, error: interval.reason };

  const activeWindow = parseWindowSeconds(formData.get("window"));
  if (!activeWindow.ok) return { ok: false, error: activeWindow.reason };

  const startHour = parseWindowStartHour(formData.get("startHour"));
  if (!startHour.ok) return { ok: false, error: startHour.reason };

  const segment = parseSegmentSeconds(formData.get("segment"));
  if (!segment.ok) return { ok: false, error: segment.reason };

  const restart = parseRestartSeconds(formData.get("restart"));
  if (!restart.ok) return { ok: false, error: restart.reason };

  await saveSourceSchedule(GITHUB_SOURCE_PRODUCER, {
    intervalSeconds: interval.value,
    windowSeconds: activeWindow.value,
    windowStartHour: startHour.value,
    segmentSeconds: segment.value,
    restartSeconds: restart.value,
  });
  revalidatePath("/email");

  return {
    ok: true,
    message:
      "Schedule saved. The new pace applies on the next dispatch: one segment of clicking, then a new runner after the restart gap.",
  };
}

/** The refusal for an OS the workflow cannot run; the allowlist is the closed set. */
const GITHUB_OS_REASON =
  "Choose one operating system to dispatch: ubuntu, windows or macos.";

const GITHUB_NO_TARGETS_REASON =
  "Every target is paused, so a browser check would click nothing. Resume one first.";

const GITHUB_NOT_CONFIGURED_REASON =
  "The GitHub source has no configuration row yet, so there is no schedule to dispatch with.";

/**
 * What a manual dispatch returns. It carries more than `ControlState` because a
 * dispatch has two shapes of success: a queued run links to the workflow page,
 * and a missing token prints the exact command instead of failing.
 */
export type GithubDispatchState = {
  ok: boolean;
  /** `dispatched` queued a run; `manual` printed the command to run instead. */
  mode?: "dispatched" | "manual";
  message?: string;
  error?: string;
  runUrl?: string;
  fallback?: { command: string };
};

/**
 * Dispatch one operating system right now, so the path can be proved before
 * continuous running is turned on.
 *
 * This is an inline bounded call, not a job: the request is one small POST, the
 * run's durability is GitHub's, and creating a job row would mean a session- and
 * creator-scoped record for a page that authorises with a control cookie.
 *
 * The targets and the schedule are read here, never taken from the form: a body
 * could otherwise point GitHub's runners at any host, or dispatch an interval
 * the schedule domain would refuse. The segment is clamped to the job ceiling
 * for the same reason a chained window is — a single job cannot outlive six
 * hours.
 */
export async function dispatchGithubNow(
  _previous: GithubDispatchState,
  formData: FormData,
): Promise<GithubDispatchState> {
  void _previous;
  if (!(await requirePageUnlock())) return { ok: false, error: LOCKED.error };

  const os = String(formData.get("os") ?? "");
  if (!(RUNNER_OSES as readonly string[]).includes(os)) {
    return { ok: false, error: GITHUB_OS_REASON };
  }

  // The live list, not a field: the runner must click what the console shows.
  const targets = await activeTargetUrls();
  if (targets.length === 0) {
    return { ok: false, error: GITHUB_NO_TARGETS_REASON };
  }

  const config = await readSourceConfig();
  if (!config) return { ok: false, error: GITHUB_NOT_CONFIGURED_REASON };

  // One dispatch runs one segment: the rest of the open window, capped at the
  // job ceiling. Outside the window there is nothing left to measure, so a
  // manual dispatch takes a full segment rather than refusing the operator.
  const now = new Date();
  const segment = Math.min(
    windowRemainingSeconds(now, config.windowSeconds, config.windowStartHour) ||
      MAX_JOB_SECONDS,
    MAX_JOB_SECONDS,
  );

  const result = await dispatchBrowserCheck({
    os: os as RunnerOs,
    targets,
    intervalSeconds: config.intervalSeconds,
    windowSeconds: segment,
    // The rotation mode is the page's setting, the same one Grafana runs: a
    // dispatch must never leave with a mode the operator did not choose.
    selection: await liveSelection(),
  });

  // The dispatcher owns every sentence — 401, 403, 404, transport, other — and
  // has already redacted the token, so it reaches the operator unchanged.
  if (!result.ok) return { ok: false, error: result.error };

  if (result.mode === "manual") {
    // No token is a configuration choice, not a failure. Nothing was queued, so
    // nothing is recorded: a recorded dispatch here would throttle a retry for a
    // run that never happened.
    return {
      ok: true,
      mode: "manual",
      message:
        "No dispatch token is configured, so nothing was queued — run this line yourself:",
      fallback: result.fallback,
    };
  }

  await recordSourceDispatch(GITHUB_SOURCE_PRODUCER, now);
  revalidatePath("/email");

  return {
    ok: true,
    mode: "dispatched",
    message: `The ${os} browser check is queued. Its progress is in the run list on the workflow page.`,
    runUrl: result.runUrl,
  };
}

/**
 * Restart: cancel this OS's running Segment, wait until GitHub says it has
 * stopped, then dispatch exactly one replacement.
 *
 * The order is the safety property, not a preference. A dispatch alone would
 * queue behind the running Segment (`browser-check.yml` uses
 * `cancel-in-progress: false`), and a dispatch before an observed stop would
 * put two browsers on the same target. Both live in `@/lib/github/restart`,
 * which is tested against a fake GitHub; this body reads the same live inputs
 * as Dispatch now and reports which step failed.
 *
 * The anti-thrash throttle (`DISPATCH_THROTTLE_SECONDS`, read by `decideDue`)
 * is deliberately bypassed. It protects the ticker from respawning a failing
 * source every minute; an operator pressing Restart is asking for a
 * replacement, so a throttle must not silently swallow the request. The
 * replacement is still recorded below, so the ticker's own throttle starts
 * from this restart and cannot immediately dispatch a second Segment.
 *
 * A cancellation that is not observed is reported as the cancel step failing,
 * and nothing is dispatched — the old Segment may still be clicking.
 */
export async function restartGithubSegment(
  _previous: GithubDispatchState,
  formData: FormData,
): Promise<GithubDispatchState> {
  void _previous;
  if (!(await requirePageUnlock())) return { ok: false, error: LOCKED.error };

  const os = String(formData.get("os") ?? "");
  if (!(RUNNER_OSES as readonly string[]).includes(os)) {
    return { ok: false, error: GITHUB_OS_REASON };
  }

  // The same live reads as a dispatch: a restart must click the list the
  // console shows, under the schedule and mode it shows.
  const targets = await activeTargetUrls();
  if (targets.length === 0) {
    return { ok: false, error: GITHUB_NO_TARGETS_REASON };
  }

  const config = await readSourceConfig();
  if (!config) return { ok: false, error: GITHUB_NOT_CONFIGURED_REASON };

  const now = new Date();
  const segment = Math.min(
    windowRemainingSeconds(now, config.windowSeconds, config.windowStartHour) ||
      MAX_JOB_SECONDS,
    MAX_JOB_SECONDS,
  );

  const result = await restartSegment(
    {
      os: os as RunnerOs,
      targets,
      intervalSeconds: config.intervalSeconds,
      windowSeconds: segment,
      selection: await liveSelection(),
    },
    {
      cancel: (runnerOs) => cancelBrowserCheckRuns(runnerOs),
      dispatch: dispatchBrowserCheck,
    },
  );

  if (!result.ok) {
    // The step is named so the operator knows whether GitHub refused to stop
    // the old run or refused to start the replacement. Every sentence is the
    // cancel client's or dispatcher's, already redacted.
    return {
      ok: false,
      error: `Restart failed at the ${result.step} step: ${result.error}`,
    };
  }

  if (result.mode === "manual") {
    // Unreachable in practice (both halves need the same token), but a manual
    // result must never be recorded as a run that exists.
    return {
      ok: true,
      mode: "manual",
      message: result.message,
      fallback: result.fallback,
    };
  }

  await recordSourceDispatch(GITHUB_SOURCE_PRODUCER, now);
  revalidatePath("/email");

  return {
    ok: true,
    mode: "dispatched",
    message: result.message,
    runUrl: result.runUrl,
  };
}

/**
 * Pause all: the console's one act that stops every continuous source.
 *
 * It is deliberately two writes rather than one transaction: Grafana's check
 * lives in Grafana and GitHub's state lives in our table, so there is no
 * transaction that could span them. The honest shape is therefore per-source
 * outcomes — one failing must not be reported as success, and must not stop the
 * other write from being attempted, because an operator asking to stop
 * everything is worse off with one source still clicking.
 *
 * What it deliberately does not touch: the target list (a pause is not a
 * delete), Burst (on demand, nothing to pause), and a GitHub segment that is
 * already queued or running (GitHub owns that job; this action never asks it to
 * cancel, so a window in flight finishes its segment).
 */

/** One source's outcome. `changed` separates "did the write" from "already off". */
export type PauseOutcome =
  | { ok: true; changed: boolean }
  | { ok: false; error: string };

/**
 * The result the card renders. `grafana`/`github` are present only when the
 * action actually attempted them: a locked refusal claims no outcome it did
 * not earn.
 */
export type PauseAllState = {
  ok: boolean;
  message?: string;
  error?: string;
  grafana?: PauseOutcome;
  github?: PauseOutcome;
};

/** Fixed sentences for the two ways a helper can throw instead of answering. */
const GRAFANA_UNREACHABLE =
  "Grafana's check could not be reached, so it was not paused.";
const GITHUB_UNWRITTEN =
  "The GitHub source state could not be saved, so it was not paused.";

/** Pause Grafana's check, reading it first so an already-paused check is not a write. */
async function pauseGrafanaSource(): Promise<PauseOutcome> {
  const id = resolveCheckId(await secret("EMAIL_CLICK_CHECK_ID"));
  const current = await getCheck(id);
  if (!current.ok) return { ok: false, error: describeSyntheticFailure(current) };
  if (!current.data.enabled) return { ok: true, changed: false };

  const updated = await updateCheck(id, { enabled: false });
  if (!updated.ok) return { ok: false, error: describeSyntheticFailure(updated) };
  return { ok: true, changed: true };
}

/** Disable the GitHub source; a missing row is "not configured", not a silent write. */
async function disableGithubSource(): Promise<PauseOutcome> {
  const config = await readSourceConfig();
  if (!config) {
    return {
      ok: false,
      error:
        "The GitHub source has no configuration row yet, so it was not paused.",
    };
  }
  if (!config.enabled) return { ok: true, changed: false };

  await setSourceEnabled(GITHUB_SOURCE_PRODUCER, false);
  return { ok: true, changed: true };
}

export async function pauseAllSources(
  _previous: PauseAllState,
  _formData: FormData,
): Promise<PauseAllState> {
  // `useActionState` supplies both; this act reads neither the prior state nor
  // the body, and taking no fields means a hand-built form cannot widen it.
  void _previous;
  void _formData;
  if (!(await requirePageUnlock())) return { ok: false, error: LOCKED.error };

  // Both helpers start together and each settles into its own outcome. A
  // Grafana outage therefore cannot stop the GitHub disable, and neither throw
  // can reject the whole action.
  const [grafana, github] = await Promise.all([
    pauseGrafanaSource().catch(
      (): PauseOutcome => ({ ok: false, error: GRAFANA_UNREACHABLE }),
    ),
    disableGithubSource().catch(
      (): PauseOutcome => ({ ok: false, error: GITHUB_UNWRITTEN }),
    ),
  ]);

  const changed =
    (grafana.ok && grafana.changed) || (github.ok && github.changed);
  // A failed write revalidated nothing, so the page keeps showing the source
  // that is still running rather than a stale "paused" it did not achieve.
  if (changed) revalidatePath("/email");

  if (!grafana.ok || !github.ok) {
    const failures: string[] = [];
    if (!grafana.ok) {
      failures.push(`Grafana's check was not paused: ${grafana.error}`);
    }
    if (!github.ok) {
      failures.push(`The GitHub source was not disabled: ${github.error}`);
    }
    return {
      ok: false,
      error:
        failures.join(" ") +
        " Nothing else moved: no target was changed and no queued GitHub segment was cancelled.",
      grafana,
      github,
    };
  }

  return {
    ok: true,
    message:
      "Paused every continuous source: Grafana's check is paused and the GitHub " +
      "source is disabled. The target list is unchanged, and a GitHub segment " +
      "already queued keeps running to the end of its window.",
    grafana,
    github,
  };
}

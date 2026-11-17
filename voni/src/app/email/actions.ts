"use server";

import { createHash, timingSafeEqual } from "node:crypto";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { secret } from "@/lib/env";
import { recordAffiliateClick } from "@/lib/email/clicks";
import { simulateOneClick } from "@/lib/email/click-simulator";
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
import { clicksPerDay, validateVolume } from "@/lib/email/volume";
import {
  getCheck,
  updateCheck,
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
 * What is deliberately absent: the submitted secret is never logged, a failed
 * unlock never says whether `EMAIL_CONTROL_SECRET` is set, and no Grafana or
 * target response body is read into a result. The panel shows curated messages,
 * not upstream text that may quote a token or an arbitrary URL.
 */

const COOKIE = "voni_email_control";
const DEFAULT_CHECK_ID = 68584;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Constant-time equality over SHA-256 digests. Hashing both sides first fixes
 * the buffer length, so `timingSafeEqual` cannot throw on a short or malformed
 * cookie and the number of matching leading characters never leaks.
 */
function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/** The cookie value: `sha256(secret)` in hex, never the secret itself. */
function controlCookieValue(expected: string): string {
  return digest(expected).toString("hex");
}

export type ControlState = {
  ok: boolean;
  message?: string;
  error?: string;
};

const LOCKED: ControlState = {
  ok: false,
  error: "Controls are locked. Unlock the panel first.",
};

function locked(): ControlState {
  return { ...LOCKED };
}

/**
 * Server-side gate. The cookie holds `sha256(secret)`, so the comparison is
 * between fixed-length digests and the secret itself never travels back to the
 * browser. An unset env secret is indistinguishable from a wrong cookie: both
 * mean "locked", and neither is logged.
 */
async function requireControl(): Promise<boolean> {
  const expected = await secret("EMAIL_CONTROL_SECRET");
  if (!expected) return false;

  const cookieStore = await cookies();
  const provided = cookieStore.get(COOKIE)?.value;
  if (!provided) return false;

  return constantTimeEqual(provided, controlCookieValue(expected));
}

/** `EMAIL_CLICK_CHECK_ID` when it is a positive integer, else the known check. */
async function checkId(): Promise<number> {
  const raw = await secret("EMAIL_CLICK_CHECK_ID");
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CHECK_ID;
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
  const submitted = String(formData.get("secret") ?? "");
  const expected = await secret("EMAIL_CONTROL_SECRET");

  // The same answer whether the variable is missing, the field is empty or the
  // value is wrong. Saying which would turn this form into a probe for the
  // deployment's configuration. Both sides are hashed first, so the compared
  // buffers are always 32 bytes and the timing does not depend on the input.
  if (!expected) {
    return { ok: false, error: "Wrong secret." };
  }
  const matches =
    submitted.length > 0 &&
    timingSafeEqual(digest(submitted), digest(expected));
  if (!matches) {
    return { ok: false, error: "Wrong secret." };
  }

  const cookieStore = await cookies();
  cookieStore.set({
    name: COOKIE,
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

export async function lockControl(): Promise<ControlState> {
  const cookieStore = await cookies();
  cookieStore.delete({ name: COOKIE, path: "/email" });
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
 */
export async function unlockPage(
  _previous: ControlState,
  formData: FormData,
): Promise<ControlState> {
  void _previous;
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
    return { ok: false, error: "Wrong password." };
  }

  const cookieStore = await cookies();
  cookieStore.set({
    name: PAGE_COOKIE,
    value: pagePasswordDigest(submitted),
    ...pageGateCookieOptions(),
  });
  redirect("/email");
}

/** Drop the gate cookie and send the visitor back to the gate screen. */
export async function lockPage(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete({ name: PAGE_COOKIE, path: "/email" });
  redirect("/email");
}

export async function saveVolume(
  _previous: ControlState,
  formData: FormData,
): Promise<ControlState> {
  if (!(await requireControl())) return locked();

  const frequencyMinutes = Number(formData.get("frequency"));
  const probeIds = formData.getAll("probe").map((value) => Number(value));
  const volume = validateVolume({
    frequencyMs: frequencyMinutes * 60_000,
    probeIds,
  });
  if (!volume.ok) return { ok: false, error: volume.reason };

  const id = await checkId();
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
  );
  return {
    ok: true,
    message: `Saved. This check now runs ${perDay} clicks/day across ${volume.value.probeIds.length} probe${volume.value.probeIds.length === 1 ? "" : "s"}.`,
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

  const id = await checkId();
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
  const { status, finalUrl, ms, userAgent, device, browser } =
    await simulateOneClick({ target, source });
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

  if (status !== null && status >= 400) {
    return {
      ok: false,
      error: `The click ran from voni's server, not Grafana, but the target answered HTTP ${status}. The attempt is recorded.`,
    };
  }

  return {
    ok: true,
    message:
      `One click ran from voni's server, not Grafana: HTTP ${status ?? "—"} in ${ms} ms. ` +
      "The row is in the table below.",
  };
}

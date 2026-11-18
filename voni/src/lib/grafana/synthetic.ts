/**
 * Grafana Synthetic Monitoring client for the `/email` control panel: read a
 * check, list the probes a check can run from, replace a check's stored script,
 * and change a check's enabled state, frequency or probe set.
 *
 * The panel only ever nudges an existing check, so this module deliberately
 * has no create/delete path. Every call reports a typed failure instead of
 * throwing: a missing secret, a rejected token and a Grafana outage are three
 * different things an operator must be able to tell apart.
 *
 * Server quirks the API's own docs get wrong, encoded here so the next reader
 * does not rediscover them the hard way:
 *
 *   probes   — `GET /probe`, singular. `/probes` is a 404.
 *   update   — `POST /check/{id}` with the *whole* check body, including `id`
 *              and `tenantId`. `PUT` and `PATCH` both 404.
 *   labels   — `[{name, value}]`, an array. A map (the obvious guess from the
 *              way labels read) is rejected: `http 400, "cannot unmarshal
 *              object into Go struct field UpdateCheckRequest.labels of type
 *              []synthetic_monitoring.Label"`. Every write path posts the whole
 *              body back, so getting this wrong breaks *all* of them.
 *   script   — `settings.scripted.script` is base64, and must go back exactly
 *              as it came or the check stops running.
 *   create   — `POST /check` (not used here; kept for reference).
 */

import { secret } from "@/lib/env";
import { readClicksPerRun } from "@/lib/email/check-script";

type Fetch = typeof globalThis.fetch;

// Grafana answers in well under this; the panel needs a verdict, not a hang.
const REQUEST_TIMEOUT_MS = 10_000;

export type SyntheticResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      reason: "not_configured" | "unauthorized" | "http_error" | "network_error";
      message: string;
      status?: number;
    };

/** One Grafana label, in the shape the API both reads and writes. */
export type SyntheticLabel = { name: string; value: string };

/** The check as the panel shows it, flattened from Grafana's wire shape. */
export type SyntheticCheck = {
  id: number;
  job: string;
  target: string;
  enabled: boolean;
  frequencyMs: number;
  timeoutMs: number;
  probeIds: number[];
  labels: SyntheticLabel[];
  modified: number | null;
  /**
   * Clicks one iteration sends, read from the stored script. Grafana has no
   * field for it, and the panel's preview has to start from the real value.
   */
  clicksPerRun: number;
};

export type Probe = {
  id: number;
  name: string;
  region: string;
  public: boolean;
  latitude: number | null;
  longitude: number | null;
};

/** The only fields the panel may change. Everything else rides along untouched. */
export type SyntheticCheckPatch = {
  enabled?: boolean;
  frequencyMs?: number;
  probeIds?: number[];
};

/**
 * Scripted checks are capped at 60s on this stack: Grafana rejects anything
 * faster for them whatever the tenant's plan says, so the floor is not a
 * suggestion the UI may round down.
 */
export const frequencyBounds = { minMs: 60_000, maxMs: 3_600_000 } as const;

/**
 * Grafana's own check body. `tenantId` and `settings` are kept even though the
 * panel never renders them, because a `POST /check/{id}` that drops either one
 * is rejected (or, worse, silently rewrites the script).
 */
export type SyntheticCheckBody = {
  id: number;
  tenantId: number | null;
  job: string;
  target: string;
  enabled: boolean;
  frequency: number;
  timeout: number;
  probes: number[];
  labels: SyntheticLabel[];
  settings: Record<string, unknown>;
  modified: number | null;
} & Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Labels arrive and leave as `[{name, value}]`. They are never folded into a
 * map: the update POST sends the body back as read, and Grafana answers a map
 * with 400 before it looks at anything else.
 *
 * An absent key is an empty list (a check with no labels). A present value that
 * is not a label array fails the read instead of becoming `[]`, because posting
 * `[]` back would silently delete labels the panel never showed.
 */
function parseLabels(value: unknown): SyntheticLabel[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;

  const labels: SyntheticLabel[] = [];
  for (const entry of value) {
    const label = asRecord(entry);
    const name = label ? asString(label["name"]) : null;
    const labelValue = label ? asString(label["value"]) : null;
    if (name === null || labelValue === null) return null;
    labels.push({ name, value: labelValue });
  }
  return labels;
}

function isTimeout(cause: unknown): boolean {
  const name = (cause as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

function clampFrequencyMs(frequencyMs: number): number {
  return Math.min(
    frequencyBounds.maxMs,
    Math.max(frequencyBounds.minMs, Math.trunc(frequencyMs)),
  );
}

/**
 * `GRAFANA_SM_URL` as an operator types it: a host, maybe with a path, maybe
 * with a scheme and a trailing slash. Node's `fetch` needs all three loose ends
 * tied, and a bare host throws `TypeError: Failed to parse URL` at request time
 * — which used to surface as an unhelpful `network_error`. Returns null when the
 * value is empty or cannot name a host, so the caller can say "not configured"
 * before it ever calls the network.
 */
export function normalizeBaseUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const withoutTrailingSlash = withScheme.replace(/\/+$/, "");

  let hostname: string;
  try {
    hostname = new URL(withoutTrailingSlash).hostname;
  } catch {
    return null;
  }
  // A public Grafana stack always has a dot in its host; `localhost` and a bare
  // word are typos, not a deployment.
  if (!hostname.includes(".")) return null;

  return withoutTrailingSlash;
}

/**
 * The update path is "read, merge, post the whole body back". Keeping the merge
 * pure makes that the one thing a test can prove without a socket: the patch
 * lands, and `job`, `target`, `labels`, `settings`, `tenantId`, `id` and every
 * field this module does not know about survive verbatim.
 */
export function mergeCheckUpdate(
  current: SyntheticCheckBody,
  patch: SyntheticCheckPatch,
): SyntheticCheckBody {
  const next: SyntheticCheckBody = { ...current };
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.frequencyMs !== undefined) {
    next.frequency = clampFrequencyMs(patch.frequencyMs);
  }
  if (patch.probeIds !== undefined) next.probes = [...patch.probeIds];
  return next;
}

function parseCheckBody(value: unknown): SyntheticCheckBody | null {
  const body = asRecord(value);
  if (!body) return null;
  const id = asNumber(body.id);
  const job = asString(body.job);
  const target = asString(body.target);
  if (id === null || job === null || target === null) return null;

  const probes = Array.isArray(body.probes)
    ? body.probes
        .map(asNumber)
        .filter((probe): probe is number => probe !== null)
    : [];

  const labels = parseLabels(body.labels);
  if (labels === null) return null;

  return {
    ...body,
    id,
    tenantId: asNumber(body.tenantId),
    job,
    target,
    // Grafana treats an absent `enabled` as on; mirroring that keeps a body
    // that only carries a patch from being posted back as disabled.
    enabled: body.enabled !== false,
    frequency: asNumber(body.frequency) ?? frequencyBounds.minMs,
    timeout: asNumber(body.timeout) ?? REQUEST_TIMEOUT_MS,
    probes,
    labels,
    settings: asRecord(body.settings) ?? {},
    modified: asNumber(body.modified),
  };
}

function parseProbe(value: unknown): Probe | null {
  const body = asRecord(value);
  if (!body) return null;
  const id = asNumber(body.id);
  if (id === null) return null;
  return {
    id,
    name: asString(body.name) ?? "",
    region: asString(body.region) ?? "",
    public: body.public === true,
    latitude: asNumber(body.latitude),
    longitude: asNumber(body.longitude),
  };
}

function toSyntheticCheck(body: SyntheticCheckBody): SyntheticCheck {
  const scripted = asRecord(body.settings["scripted"]);
  const script =
    scripted && typeof scripted["script"] === "string"
      ? scripted["script"]
      : null;
  return {
    id: body.id,
    job: body.job,
    target: body.target,
    enabled: body.enabled,
    frequencyMs: body.frequency,
    timeoutMs: body.timeout,
    probeIds: [...body.probes],
    labels: [...body.labels],
    modified: body.modified,
    clicksPerRun: script === null ? 1 : readClicksPerRun(decodeScript(script)),
  };
}

type SyntheticConfig = { baseUrl: string; token: string };

/**
 * Both secrets, or a `not_configured` that names the missing variable. The
 * token is never echoed, not even redacted: a message that quotes it is a leak
 * once it reaches a job result or a log line.
 */
async function getConfig(): Promise<SyntheticResult<SyntheticConfig>> {
  const [baseUrl, token] = await Promise.all([
    secret("GRAFANA_SM_URL"),
    secret("GRAFANA_SM_TOKEN"),
  ]);

  if (!baseUrl || !token) {
    const missing: string[] = [];
    if (!baseUrl) missing.push("GRAFANA_SM_URL");
    if (!token) missing.push("GRAFANA_SM_TOKEN");
    return {
      ok: false,
      reason: "not_configured",
      message: `Grafana Synthetic Monitoring is not configured: set ${missing.join(" and ")}.`,
    };
  }

  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return {
      ok: false,
      reason: "not_configured",
      message: "GRAFANA_SM_URL is not set or malformed",
    };
  }

  return { ok: true, data: { baseUrl: normalized, token } };
}

async function requestJson(
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown },
  fetcher: Fetch,
): Promise<SyntheticResult<unknown>> {
  const config = await getConfig();
  if (!config.ok) return config;

  const hasBody = options.body !== undefined;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.data.token}`,
    Accept: "application/json",
  };
  if (hasBody) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetcher(`${config.data.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: hasBody ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (cause) {
    // The underlying message is what tells an operator an unparseable URL from
    // a refused connection. It comes from `fetch` and never contains the token:
    // the token only travels in a header, which the error does not quote.
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      reason: "network_error",
      message: isTimeout(cause)
        ? `Grafana Synthetic Monitoring timed out (GRAFANA_SM_URL): ${detail}`
        : `Grafana Synthetic Monitoring could not be reached (GRAFANA_SM_URL): ${detail}`,
    };
  }

  // 403 is the same operator action as 401 here: the token is wrong or lacks
  // the synthetic-monitoring scope. Grafana's own message body is never echoed.
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      reason: "unauthorized",
      message: `Grafana Synthetic Monitoring rejected the token (HTTP ${response.status}).`,
      status: response.status,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: "http_error",
      message: `Grafana Synthetic Monitoring returned HTTP ${response.status}.`,
      status: response.status,
    };
  }

  try {
    return { ok: true, data: (await response.json()) as unknown };
  } catch {
    return {
      ok: false,
      reason: "http_error",
      message: "Grafana Synthetic Monitoring returned an unreadable response.",
      status: response.status,
    };
  }
}

function unexpectedBody(message: string): SyntheticResult<never> {
  return { ok: false, reason: "http_error", message };
}

async function fetchCheckBody(
  id: number,
  fetcher: Fetch,
): Promise<SyntheticResult<SyntheticCheckBody>> {
  const result = await requestJson(
    `/check/${encodeURIComponent(String(id))}`,
    {},
    fetcher,
  );
  if (!result.ok) return result;
  const body = parseCheckBody(result.data);
  if (!body) {
    return unexpectedBody("Grafana Synthetic Monitoring returned an unexpected check body.");
  }
  return { ok: true, data: body };
}

export async function getCheck(
  id: number,
  fetcher: Fetch = fetch,
): Promise<SyntheticResult<SyntheticCheck>> {
  const body = await fetchCheckBody(id, fetcher);
  if (!body.ok) return body;
  return { ok: true, data: toSyntheticCheck(body.data) };
}

/** Probes come from `GET /probe` (singular), never `/probes`. */
export async function listProbes(
  fetcher: Fetch = fetch,
): Promise<SyntheticResult<Probe[]>> {
  const result = await requestJson("/probe", {}, fetcher);
  if (!result.ok) return result;
  if (!Array.isArray(result.data)) {
    return unexpectedBody("Grafana Synthetic Monitoring returned an unexpected probe list.");
  }

  const probes: Probe[] = [];
  for (const entry of result.data) {
    const probe = parseProbe(entry);
    // Dropping an unreadable probe would quietly shrink the set an operator can
    // pick from, so a malformed entry fails the whole read instead.
    if (!probe) {
      return unexpectedBody("Grafana Synthetic Monitoring returned an unexpected probe.");
    }
    probes.push(probe);
  }
  return { ok: true, data: probes };
}

/**
 * The affiliate click check's job name. The script upload refuses to write to a
 * check whose job is not this, because a misconfigured `EMAIL_CLICK_CHECK_ID`
 * would otherwise put the secret-bearing script in someone else's check.
 */
export const AFFILIATE_CHECK_JOB = "voni-affiliate-click-us";

function decodeScript(scriptBase64: string): string {
  return Buffer.from(scriptBase64, "base64").toString("utf8");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Replace the check's stored script, then prove Grafana kept it.
 *
 * The stored script is base64 of the k6 source and must go back exactly as it
 * came or the check stops running, so this is `POST /check/{id}` with the whole
 * body — same quirk as `updateCheck`, and the same reason the body is read
 * first rather than assembled from a patch.
 *
 * The read-back is the point: a 200 from the write only says Grafana accepted
 * the request. The function confirms three things before it reports success —
 * the script hash, the job (so a wrong id cannot silently aim the secret at
 * another check), and the frequency (a script POST must not move the interval
 * the panel is about to set separately). A failed confirmation is reported as
 * `http_error`, because "written but not what we sent" is a lost write, not a
 * transport failure.
 */
export async function uploadCheckScript(
  id: number,
  scriptBase64: string,
  expectedJob: string,
  fetcher: Fetch = fetch,
): Promise<SyntheticResult<SyntheticCheck>> {
  const current = await fetchCheckBody(id, fetcher);
  if (!current.ok) return current;

  if (current.data.job !== expectedJob) {
    return unexpectedBody(
      `Grafana check ${id} is job ${JSON.stringify(current.data.job)}, not ${expectedJob}; refusing to write the script.`,
    );
  }
  if (current.data.tenantId === null) {
    return unexpectedBody(
      "Grafana Synthetic Monitoring did not report the check's tenant id, so its script cannot be updated.",
    );
  }

  const scripted = asRecord(current.data.settings["scripted"]);
  if (!scripted || typeof scripted["script"] !== "string") {
    return unexpectedBody(
      `Grafana check ${id} is not a scripted check; refusing to rewrite it.`,
    );
  }

  const posted = await requestJson(
    `/check/${encodeURIComponent(String(id))}`,
    {
      method: "POST",
      body: {
        ...current.data,
        settings: {
          ...current.data.settings,
          scripted: { ...scripted, script: scriptBase64 },
        },
      },
    },
    fetcher,
  );
  if (!posted.ok) return posted;

  const confirmed = await fetchCheckBody(id, fetcher);
  if (!confirmed.ok) return confirmed;

  const confirmedScripted = asRecord(confirmed.data.settings["scripted"]);
  if (!confirmedScripted || typeof confirmedScripted["script"] !== "string") {
    return unexpectedBody(
      "Grafana Synthetic Monitoring returned the check without a stored script.",
    );
  }

  const [storedHash, expectedHash] = await Promise.all([
    sha256Hex(decodeScript(confirmedScripted["script"])),
    sha256Hex(decodeScript(scriptBase64)),
  ]);
  if (storedHash !== expectedHash) {
    return unexpectedBody(
      "Grafana accepted the script but stores different bytes; the check's script was not updated.",
    );
  }
  if (confirmed.data.job !== expectedJob) {
    return unexpectedBody(
      "Grafana accepted the script but the check's job changed; re-read the check before using it.",
    );
  }
  if (confirmed.data.frequency !== current.data.frequency) {
    return unexpectedBody(
      "Grafana accepted the script but the check's frequency changed; re-read the check before saving an interval.",
    );
  }

  return { ok: true, data: toSyntheticCheck(confirmed.data) };
}

/**
 * Read, merge, post the whole body back, then re-read: the panel shows what
 * Grafana says the check is now, not what we hoped we sent.
 */
export async function updateCheck(
  id: number,
  patch: SyntheticCheckPatch,
  fetcher: Fetch = fetch,
): Promise<SyntheticResult<SyntheticCheck>> {
  const current = await fetchCheckBody(id, fetcher);
  if (!current.ok) return current;

  if (current.data.tenantId === null) {
    // Posting a body without it is not "leave it as it was": Grafana rejects the
    // write, and pretending otherwise would leave the panel showing a lie.
    return unexpectedBody(
      "Grafana Synthetic Monitoring did not report the check's tenant id, so it cannot be updated.",
    );
  }

  const merged = mergeCheckUpdate(current.data, patch);
  const posted = await requestJson(
    `/check/${encodeURIComponent(String(id))}`,
    { method: "POST", body: merged },
    fetcher,
  );
  if (!posted.ok) return posted;

  const confirmed = await fetchCheckBody(id, fetcher);
  if (!confirmed.ok) return confirmed;
  return { ok: true, data: toSyntheticCheck(confirmed.data) };
}

/**
 * The check this deployment edits when `EMAIL_CLICK_CHECK_ID` is unset.
 *
 * It is a constant, not a discovery step: the panel and the actions must agree
 * on which check they are talking about, and a resolver that guessed would
 * let the page render one check while the save wrote another.
 */
export const DEFAULT_CHECK_ID = 68584;

/**
 * `EMAIL_CLICK_CHECK_ID` when it is a positive integer, else the known check.
 *
 * Accepts the raw secret (or `undefined`) rather than reading env itself, so
 * the page and every action share one parse instead of keeping a copy each.
 * Anything that is not a positive integer — `""`, `"0"`, `"68584.5"`, a
 * missing variable — is the default rather than an error: the panel has one
 * check to show, and refusing to render is worse than showing the known one.
 */
export function resolveCheckId(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CHECK_ID;
}

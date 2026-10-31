/**
 * The cutover proof surface (demo-cascade ticket 25).
 *
 * `--show` reads the durable routing switch and its append-only audit trail
 * through `voice-pipeline/scripts/routing_switch.py` — the one operator path to
 * the store. `--set` flips future calls through the same CLI, then re-reads the
 * switch to prove the audit entry it claims was actually written. `--prove-off`
 * is the kill-switch proof: flip to `off`, deliver a valid v2 demo body, open
 * the real browser-call socket, and assert the service refuses with
 * `code: "managed"` and leaves no greeting, turn, or vendor leg behind.
 *
 * Hard limits:
 *
 * - A missing or corrupt switch is a failure, never "off". Only a switch the
 *   CLI reports as *missing* is fail-safe off, and the report says so.
 * - A flip needs a mode, a named operator and a reason. A no-op is refused by
 *   the CLI and reported as a failure here; this surface never pretends a
 *   write happened.
 * - The proof never invents a production read: the trace directory is the one
 *   the operator names, and a trace that cannot be read on a local service is
 *   a failure. No browser is re-run; the visitor-facing unavailable state is
 *   cited from the ticket-16 rig (`voni/tests/e2e/cascade-delivery.spec.ts`).
 * - The production flip is the operator's human step. This command runs
 *   against whatever store it is pointed at and never claims a production
 *   action it did not observe.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { buildDemoCascadeBody } from "../../src/lib/demo/cascade-body";
import { deliverCallBody } from "../../src/lib/demo/pipeline-delivery";
import {
  CASCADE_PROTOCOL_VERSION,
  buildConfigMessage,
  parseServerMessage,
} from "../../src/lib/voice/cascade-session";
import { DEMO_VOICE_IDS } from "../../src/lib/demo/voni-agent";
import {
  ROUTING_MODES,
  ROUTING_SWITCH_PATH,
  parseRoutingShow,
  type RoutingMode,
  type RoutingView,
} from "./parity";
import { resolveTargets, type RealLegsSocket } from "./real-legs";

export const CUTOVER_USAGE = `usage: npm run cutover:check -- <action> [options]

  --show                    read the durable routing switch and its audit trail
  --set MODE                flip future calls (off, demo or all); needs an
                            operator and a reason, and refuses a no-op
  --prove-off               flip to off, prove a new demo call is refused with
                            code "managed" and does no vendor work, then
                            restore the mode it found and print the audit
  --operator ID             who is making the change (required for --set)
  --reason TEXT             why the change is made (required for --set)
  --keep-off                with --prove-off, leave the switch off so the
                            restore is the operator's recorded --set action
  --base-url URL            the pipeline HTTP(S) base (default: VOICE_PIPELINE_URL,
                            then VOICE_PIPELINE_SERVICE_URL)
  --ws-url URL              the browser-call WebSocket URL (derived from --base-url)
  --events-dir PATH         the service's trace directory for the proof (default:
                            VOICE_PIPELINE_EVENTS_DIR, then voice-pipeline/.events)
  --sqlite PATH             the local routing store (CASCADE_STORE_PATH)
  --database-url DSN        the Postgres routing store (DATABASE_URL); never printed
  --python PATH             the interpreter for routing_switch.py (PYTHON, python3)
  --voice ID                a demo voice for the throwaway body (first demo voice)
  --timeout-ms N            per-wait bound for the proof (default: 15000)
  --json                    print one machine-readable report
  --help, -h                this text

The proof needs the shared VOICE_PIPELINE_ENVELOPE_SECRET to sign the body.
It never opens a browser and never runs in the pull-request path.`;

export class CutoverUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CutoverUsageError";
  }
}

export type CutoverAction = "show" | "set" | "prove-off";

export type CutoverOptions = {
  action: CutoverAction;
  mode?: RoutingMode;
  operator?: string;
  reason?: string;
  keepOff: boolean;
  baseUrl?: string;
  wsUrl?: string;
  eventsDir?: string;
  sqlite: string;
  databaseUrl: string;
  python: string;
  voice: string;
  timeoutMs: number;
  json: boolean;
  help: boolean;
};

const FLAGS_WITH_VALUE = new Set([
  "--set",
  "--operator",
  "--reason",
  "--base-url",
  "--ws-url",
  "--events-dir",
  "--sqlite",
  "--database-url",
  "--python",
  "--voice",
  "--timeout-ms",
]);

function requireValue(flag: string, argv: readonly string[], index: number): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new CutoverUsageError(`${flag} needs a value`);
  }
  return value;
}

function nonBlank(flag: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new CutoverUsageError(`${flag} must not be blank`);
  }
  return trimmed;
}

/** Parse the operator's argv; every malformed request is a named usage error. */
export function parseCutoverArgs(argv: readonly string[]): CutoverOptions {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--json" || flag === "--keep-off") {
      flags.set(flag, "");
      continue;
    }
    if (flag === "--help" || flag === "-h") {
      flags.set("--show", "");
      flags.set("--help", "");
      continue;
    }
    if (flag === "--show" || flag === "--prove-off") {
      flags.set(flag, "");
      continue;
    }
    if (!FLAGS_WITH_VALUE.has(flag)) {
      throw new CutoverUsageError(`unknown option ${JSON.stringify(flag)}`);
    }
    flags.set(flag, requireValue(flag, argv, index));
    index += 1;
  }

  const actions: CutoverAction[] = [];
  if (flags.has("--show")) actions.push("show");
  if (flags.has("--set")) actions.push("set");
  if (flags.has("--prove-off")) actions.push("prove-off");
  if (actions.length !== 1) {
    throw new CutoverUsageError(
      `one of --show, --set MODE or --prove-off is required; got ${actions.length === 0 ? "none" : actions.join(", ")}`,
    );
  }
  const action = actions[0];

  if (flags.has("--keep-off") && action !== "prove-off") {
    throw new CutoverUsageError(
      "--keep-off belongs to --prove-off; --show and --set never leave the switch off",
    );
  }

  let mode: RoutingMode | undefined;
  if (action === "set") {
    const raw = nonBlank("--set", flags.get("--set")) as string;
    if (!(ROUTING_MODES as readonly string[]).includes(raw)) {
      throw new CutoverUsageError(
        `unknown routing mode ${JSON.stringify(raw)}; expected one of ${ROUTING_MODES.join(", ")}`,
      );
    }
    mode = raw as RoutingMode;
  }

  const operator = nonBlank("--operator", flags.get("--operator"));
  const reason = nonBlank("--reason", flags.get("--reason"));
  if (action === "set") {
    if (operator === undefined) {
      throw new CutoverUsageError(
        "--set needs a non-empty --operator: every change records who, when, from and to",
      );
    }
    if (reason === undefined) {
      throw new CutoverUsageError(
        "--set needs a non-empty --reason: a flip is a dated operator action",
      );
    }
  }

  const timeoutRaw = flags.get("--timeout-ms");
  let timeoutMs = 15_000;
  if (timeoutRaw !== undefined) {
    timeoutMs = Number(timeoutRaw);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new CutoverUsageError(
        `--timeout-ms must be a positive whole number, got ${JSON.stringify(timeoutRaw)}`,
      );
    }
  }

  const voice = flags.get("--voice") ?? DEMO_VOICE_IDS[0];
  if (!(DEMO_VOICE_IDS as readonly string[]).includes(voice)) {
    throw new CutoverUsageError(
      `unknown demo voice ${JSON.stringify(voice)}; the demo offers ${DEMO_VOICE_IDS.join(", ")}`,
    );
  }

  return {
    action,
    ...(mode !== undefined ? { mode } : {}),
    ...(operator !== undefined ? { operator } : {}),
    ...(reason !== undefined ? { reason } : {}),
    keepOff: flags.has("--keep-off"),
    baseUrl: flags.get("--base-url"),
    wsUrl: flags.get("--ws-url"),
    eventsDir: flags.get("--events-dir"),
    sqlite: flags.get("--sqlite") ?? "",
    databaseUrl: flags.get("--database-url") ?? "",
    python: flags.get("--python") ?? process.env.PYTHON ?? "python3",
    voice,
    timeoutMs,
    json: flags.has("--json"),
    help: flags.has("--help"),
  };
}

// ---------------------------------------------------------------------------
// The durable switch and its audit trail
// ---------------------------------------------------------------------------

/** One checklist row: what was checked, its stable name, and its source. */
export type CutoverCheck = {
  name: string;
  code: string;
  ok: boolean;
  detail: string;
  source: string;
};

export type CliResult = { status: number; stdout: string; stderr: string };
export type CliRunner = (args: string[]) => CliResult;

/** The one store this command may read or flip; the DSN never appears in text. */
export type SwitchStore = {
  sqlite: string;
  databaseUrl: string;
  python: string;
  /** How the operator surface describes the chosen store; never the DSN. */
  label?: string;
};

/** The one store, named for the report. A Postgres DSN is never printed. */
export function describeStore(store: SwitchStore): string {
  if (store.label !== undefined && store.label.trim() !== "") return store.label.trim();
  if (store.sqlite.trim() !== "") return `sqlite ${store.sqlite.trim()}`;
  if (store.databaseUrl.trim() !== "") return "postgres (DSN not printed)";
  return "no store configured";
}

export class CutoverError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class InvalidSwitchView extends CutoverError {
  constructor(message: string) {
    super("routing-switch-invalid", message);
  }
}

export type AuditChange = {
  at: number;
  actor: string;
  from_mode: string;
  to_mode: RoutingMode;
  reason: string;
};

/** The switch as `routing_switch.py show --json` reports it, audit included. */
export type SwitchView = {
  mode: RoutingMode;
  recordVersion: number | null;
  decidedAt: number | null;
  missing: boolean;
  changes: AuditChange[];
};

function objectAt(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidSwitchView(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidSwitchView(`${label} must be a finite number`);
  }
  return value;
}

/**
 * Validate the CLI's JSON. A document that is not a switch is refused by
 * name: an operator must never read "unreadable" as "off".
 */
export function parseSwitchShow(stdout: string): SwitchView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new InvalidSwitchView("the routing switch printed no readable JSON");
  }
  const view = objectAt(parsed, "the routing switch document");
  const mode = view.mode;
  if (!(ROUTING_MODES as readonly unknown[]).includes(mode)) {
    throw new InvalidSwitchView(
      `the routing switch reported an unknown mode ${JSON.stringify(mode)}; expected off, demo or all`,
    );
  }
  if (typeof view.missing !== "boolean") {
    throw new InvalidSwitchView(
      "the routing switch did not say whether a switch is stored",
    );
  }
  let recordVersion: number | null = null;
  if (view.recordVersion !== null) {
    recordVersion = finiteNumber(view.recordVersion, "recordVersion");
    if (!Number.isInteger(recordVersion)) {
      throw new InvalidSwitchView("recordVersion must be a whole number");
    }
  }
  let decidedAt: number | null = null;
  if (view.decidedAt !== null) {
    decidedAt = finiteNumber(view.decidedAt, "decidedAt");
  }
  if (!view.missing && recordVersion === null) {
    throw new InvalidSwitchView("a stored switch reported no recordVersion");
  }
  if (!Array.isArray(view.changes)) {
    throw new InvalidSwitchView("changes must be an array");
  }
  const changes = view.changes.map((raw, index) => {
    const change = objectAt(raw, `changes[${index}]`);
    const at = finiteNumber(change.at, `changes[${index}].at`);
    const actor = change.actor;
    if (typeof actor !== "string" || actor.trim() === "") {
      throw new InvalidSwitchView(`changes[${index}].actor must be a non-empty string`);
    }
    for (const field of ["from", "to"] as const) {
      const value = change[field];
      if (typeof value !== "string" || value.trim() === "") {
        throw new InvalidSwitchView(
          `changes[${index}].${field} must be a non-empty string`,
        );
      }
    }
    const to = change.to as string;
    if (!(ROUTING_MODES as readonly string[]).includes(to)) {
      throw new InvalidSwitchView(
        `changes[${index}].to is not a routing mode: ${JSON.stringify(to)}`,
      );
    }
    if (typeof change.reason !== "string") {
      throw new InvalidSwitchView(`changes[${index}].reason must be a string`);
    }
    return {
      at,
      actor,
      from_mode: change.from as string,
      to_mode: to as RoutingMode,
      reason: change.reason,
    };
  });
  return {
    mode: mode as RoutingMode,
    recordVersion,
    decidedAt,
    missing: view.missing,
    changes,
  };
}

/** One store flag, never two: the CLI refuses an ambiguous store itself. */
function storeArgs(store: SwitchStore): string[] {
  if (store.sqlite.trim() !== "") return ["--sqlite", store.sqlite.trim()];
  if (store.databaseUrl.trim() !== "") return ["--database-url", store.databaseUrl.trim()];
  return [];
}

function cliMessage(result: CliResult): string {
  return (result.stderr || result.stdout).trim() || "(no message)";
}

function describeChange(change: AuditChange): string {
  return `${change.actor} ${change.from_mode} → ${change.to_mode} at ${change.at}: reason "${change.reason}"`;
}

const SHOW_SOURCE = "routing_switch.py show --json";

/** Read the switch and its audit; an unreadable switch is a failure row. */
export function readSwitch(
  store: SwitchStore,
  runner: CliRunner,
): { checks: CutoverCheck[]; view: SwitchView | null } {
  const result = runner(["show", "--json", ...storeArgs(store)]);
  if (result.status !== 0) {
    return {
      view: null,
      checks: [
        {
          name: "routing switch",
          code: "routing-switch-unreadable",
          ok: false,
          detail: `routing_switch.py exited ${result.status}: ${cliMessage(result)}; an unreadable switch is not "off"`,
          source: SHOW_SOURCE,
        },
      ],
    };
  }
  let view: SwitchView;
  try {
    view = parseSwitchShow(result.stdout);
  } catch (error) {
    return {
      view: null,
      checks: [
        {
          name: "routing switch",
          code: "routing-switch-invalid",
          ok: false,
          detail: (error as Error).message,
          source: SHOW_SOURCE,
        },
      ],
    };
  }
  const modeDetail = view.missing
    ? 'mode "off" (fail-safe; no switch is stored)'
    : `mode "${view.mode}" (recordVersion ${String(view.recordVersion)}, decidedAt ${String(view.decidedAt)})`;
  const auditDetail = view.missing
    ? "no audit trail: no switch is stored"
    : `${view.changes.length} change${view.changes.length === 1 ? "" : "s"}${
        view.changes.length > 0
          ? `; last: ${describeChange(view.changes[view.changes.length - 1])}`
          : ""
      }`;
  return {
    view,
    checks: [
      { name: "routing switch", code: "routing-switch", ok: true, detail: modeDetail, source: SHOW_SOURCE },
      { name: "audit trail", code: "audit-trail", ok: true, detail: auditDetail, source: SHOW_SOURCE },
    ],
  };
}

export type FlipRequest = { mode: RoutingMode; operator: string; reason: string };

/**
 * Flip future calls, then re-read the durable record and prove the audit entry
 * matches the request. The write response is never trusted on its own.
 */
export function flipSwitch(
  store: SwitchStore,
  runner: CliRunner,
  request: FlipRequest,
): { checks: CutoverCheck[]; view: SwitchView | null } {
  if (request.operator.trim() === "") {
    throw new CutoverUsageError("a flip needs a non-empty operator");
  }
  if (request.reason.trim() === "") {
    throw new CutoverUsageError("a flip needs a non-empty reason");
  }
  const before = readSwitch(store, runner);
  if (before.view === null) return { checks: before.checks, view: null };

  const setSource = `routing_switch.py set --mode ${request.mode} --operator ${request.operator}`;
  const result = runner([
    "set",
    "--mode",
    request.mode,
    "--operator",
    request.operator,
    "--reason",
    request.reason,
    "--json",
    ...storeArgs(store),
  ]);
  if (result.status !== 0) {
    return {
      view: null,
      checks: [
        {
          name: "flip",
          code: "flip-refused",
          ok: false,
          detail: `routing_switch.py exited ${result.status}: ${cliMessage(result)}; nothing was recorded`,
          source: setSource,
        },
      ],
    };
  }
  const flip: CutoverCheck = {
    name: "flip",
    code: "flip",
    ok: true,
    detail: `routing switch: ${before.view.missing ? "unset" : before.view.mode} → ${request.mode} via routing_switch.py set`,
    source: setSource,
  };

  const after = readSwitch(store, runner);
  if (after.view === null) {
    return {
      view: null,
      checks: [
        flip,
        {
          name: "audit entry",
          code: "audit-unreadable",
          ok: false,
          detail: `the flip returned success but the switch cannot be re-read: ${after.checks[0]?.detail ?? "no detail"}`,
          source: SHOW_SOURCE,
        },
      ],
    };
  }

  const expectedFrom = before.view.missing ? "unset" : before.view.mode;
  const expectedVersion = (before.view.recordVersion ?? 0) + 1;
  const expectedChanges = before.view.changes.length + 1;
  const last = after.view.changes.at(-1);
  const problems: string[] = [];
  if (after.view.mode !== request.mode) {
    problems.push(`mode is "${after.view.mode}", expected "${request.mode}"`);
  }
  if (after.view.recordVersion !== expectedVersion) {
    problems.push(`recordVersion is ${String(after.view.recordVersion)}, expected ${expectedVersion}`);
  }
  if (after.view.changes.length !== expectedChanges) {
    problems.push(`the audit has ${after.view.changes.length} entries, expected ${expectedChanges}`);
  }
  if (last === undefined) {
    problems.push("the audit has no last entry");
  } else {
    if (last.from_mode !== expectedFrom) {
      problems.push(`last.from is "${last.from_mode}", expected "${expectedFrom}"`);
    }
    if (last.to_mode !== request.mode) {
      problems.push(`last.to is "${last.to_mode}", expected "${request.mode}"`);
    }
    if (last.actor !== request.operator) {
      problems.push(`last.actor is "${last.actor}", expected "${request.operator}"`);
    }
    if (last.reason !== request.reason) {
      problems.push(`last.reason is "${last.reason}", expected "${request.reason}"`);
    }
    if (!(last.at > 0)) {
      problems.push("last.at is not a positive epoch timestamp");
    }
  }
  const audit: CutoverCheck =
    problems.length === 0 && last !== undefined
      ? {
          name: "audit entry",
          code: "audit-entry",
          ok: true,
          detail: `recordVersion ${String(after.view.recordVersion)}; ${describeChange(last)}`,
          source: SHOW_SOURCE,
        }
      : {
          name: "audit entry",
          code: "audit-entry-mismatch",
          ok: false,
          detail: `${problems.join("; ")}${
            last === undefined ? "" : `; last entry: ${JSON.stringify(last)}`
          }`,
          source: SHOW_SOURCE,
        };
  return { checks: [flip, audit], view: after.view };
}

/** Print every check with its source, then the named failure tally. */
export function formatCutoverReport(checks: readonly CutoverCheck[], title = "demo-cascade cutover (ticket 25)"): string {
  const lines = [title, ""];
  for (const entry of checks) {
    lines.push(`  ${entry.ok ? "PASS" : "FAIL"}  ${entry.name.padEnd(20)} ${entry.detail}`);
    lines.push(`        source: ${entry.source}`);
  }
  const failed = checks.filter((entry) => !entry.ok);
  lines.push("");
  lines.push(
    failed.length === 0
      ? `${checks.length} checks, all passed`
      : `${failed.length} of ${checks.length} checks failed: ${failed.map((entry) => entry.code).join(", ")}`,
  );
  return `${lines.join("\n")}\n`;
}

export function cutoverExitCode(checks: readonly CutoverCheck[]): number {
  return checks.some((entry) => !entry.ok) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// The kill-switch proof
// ---------------------------------------------------------------------------

/** The caller's own view of the socket, so tests can drive a fake service. */
type ProverSocket = {
  send(data: string): void;
  close(): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string) => void): void;
  onError(handler: (message: string) => void): void;
  onClose(handler: () => void): void;
};

type ProverBody = Awaited<ReturnType<typeof buildDemoCascadeBody>>;

export type ProveOffDeps = {
  store: SwitchStore;
  runner: CliRunner;
  target: { httpBase: string; wsUrl: string; local: boolean };
  eventsDir: string;
  voice: string;
  timeoutMs: number;
  keepOff: boolean;
  operator?: string;
  reason?: string;
  buildBody?: (input: { voice: string; callId: string }) => Promise<ProverBody>;
  fetchImpl?: typeof fetch;
  connect?: (url: string) => ProverSocket;
  traceExists?: (path: string) => boolean;
  readTrace?: (path: string) => string;
  sleep?: (ms: number) => Promise<void>;
  callId?: string;
  /** The ticket-16 rig this proof cites for the visitor-facing state. */
  citationPath: string;
  readCitation?: (path: string) => string;
};

type WsLike = {
  send(data: string): void;
  close(): void;
  on(event: "open", handler: () => void): void;
  on(event: "message", handler: (data: unknown) => void): void;
  on(event: "error", handler: (error: Error) => void): void;
  on(event: "close", handler: (code: number) => void): void;
};

/**
 * The proof uses the `ws` client, not the platform WebSocket: the service
 * answers a refused connect with an error frame and then tears the socket down
 * without a close frame (1006), and the platform WebSocket drops the queued
 * refusal frame. `ws` delivers the frame before the close, so the named
 * refusal is observable instead of being reported as an anonymous socket
 * error. It is a dev dependency, like the rest of `scripts/`.
 */
function defaultConnect(url: string): ProverSocket {
  const WsClient = createRequire(import.meta.url)("ws") as new (address: string) => WsLike;
  const socket = new WsClient(url);
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onOpen: (handler) => socket.on("open", handler),
    onMessage: (handler) =>
      socket.on("message", (data) => handler(typeof data === "string" ? data : String(data))),
    onError: (handler) => socket.on("error", (error) => handler(error.message)),
    onClose: (handler) => socket.on("close", () => handler()),
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

type Refusal = {
  code: string | null;
  message: string | null;
  frames: string[];
  closed: boolean;
  socketError: string | null;
  timedOut: boolean;
};

/** Open the socket, send identity only, and wait for the service's verdict. */
async function awaitRefusal(
  socket: ProverSocket,
  config: string,
  timeoutMs: number,
): Promise<Refusal> {
  const frames: string[] = [];
  let code: string | null = null;
  let message: string | null = null;
  let closed = false;
  let socketError: string | null = null;
  let timedOut = false;
  let settle: () => void = () => undefined;
  const done = new Promise<void>((resolvePromise) => {
    settle = resolvePromise;
  });

  // The message handler is attached before the socket opens: a fake service
  // (and a very fast refusal) may answer the config frame synchronously.
  socket.onMessage((raw) => {
    frames.push(raw);
    const event = parseServerMessage(raw);
    if (event?.kind === "error") {
      code = event.code ?? null;
      message = event.message;
      settle();
    }
  });
  socket.onClose(() => {
    closed = true;
    settle();
  });
  socket.onError((reason) => {
    socketError = reason;
    settle();
  });
  socket.onOpen(() => socket.send(config));
  const timer = setTimeout(() => {
    timedOut = true;
    settle();
  }, timeoutMs);
  await done;
  clearTimeout(timer);
  socket.close();
  return { code, message, frames, closed, socketError, timedOut };
}

const FORBIDDEN_TRACE_TYPES = new Set([
  "greeting.start",
  "greeting.first_audio",
  "greeting.done",
  "provider_fallback",
  "reconnect",
  "breaker.transition",
  "protocol.error",
  "turn.failed",
  "turn.attribution",
  "cost.priced",
]);

function forbiddenTraceRows(text: string): string[] {
  const offenders: string[] = [];
  const rows = text.split("\n");
  for (let index = 0; index < rows.length; index += 1) {
    const raw = rows[index].trim();
    if (raw === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      offenders.push(`line ${index + 1} is not JSON`);
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      offenders.push(`line ${index + 1} is not a JSON object`);
      continue;
    }
    const line = parsed as Record<string, unknown>;
    const type = typeof line.type === "string" ? line.type : "(no type)";
    if (
      FORBIDDEN_TRACE_TYPES.has(type) ||
      type.startsWith("turn.") ||
      type.startsWith("greeting.") ||
      type.startsWith("budget.") ||
      "leg" in line
    ) {
      offenders.push(type);
    }
  }
  return offenders;
}

const CITATION_MARKERS = [
  "a refused cascade connect shows the demo unavailable state and opens no managed session",
  "demo-unavailable",
  "DEMO_UNAVAILABLE_MESSAGES.managed",
];

/**
 * Prove the kill switch: flip to `off`, deliver a valid v2 demo body, open the
 * real browser-call socket, and assert the service refuses with
 * `code: "managed"`, opens no vendor frame, and leaves no greeting, turn or
 * vendor-leg row in the call's trace. Then restore the mode found (unless the
 * operator asked to keep it off) and print the audit.
 */
export async function proveOff(deps: ProveOffDeps): Promise<{ checks: CutoverCheck[]; mode: RoutingMode | null }> {
  const checks: CutoverCheck[] = [];
  const operator = deps.operator?.trim() || "cutover-check";
  const reason = deps.reason?.trim() || "kill-switch proof";
  const callId = deps.callId ?? randomUUID();
  const buildBody = deps.buildBody ?? ((input) => buildDemoCascadeBody(input));
  const connect = deps.connect ?? defaultConnect;
  const sleep = deps.sleep ?? defaultSleep;
  const traceExists = deps.traceExists ?? ((path: string) => existsSync(path));
  const readTrace =
    deps.readTrace ??
    ((path: string) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    });
  const readCitation =
    deps.readCitation ??
    ((path: string) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    });

  // 1. Read the switch; an unreadable switch is never "off".
  const before = readSwitch(deps.store, deps.runner);
  checks.push(...before.checks);
  if (before.view === null) return { checks, mode: null };
  const foundMode = before.view.mode;

  // 2. Flip to off (or record that it already is).
  if (foundMode === "off") {
    checks.push({
      name: "kill switch",
      code: "already-off",
      ok: true,
      detail: "the switch is already off; no flip was written",
      source: SHOW_SOURCE,
    });
  } else {
    const off = flipSwitch(deps.store, deps.runner, { mode: "off", operator, reason });
    checks.push(...off.checks);
    if (off.view === null) return { checks, mode: null };
  }

  // 3. Build the app's own v2 demo body and deliver it.
  let call: ProverBody;
  try {
    call = await buildBody({ voice: deps.voice, callId });
  } catch (error) {
    checks.push({
      name: "signed body",
      code: "sign-failed",
      ok: false,
      detail: `${(error as Error).name}: ${(error as Error).message}`,
      source: "buildDemoCascadeBody",
    });
    return { checks, mode: foundMode };
  }
  checks.push({
    name: "signed body",
    code: "signed-body",
    ok: true,
    detail: `v2 demo body for "${call.agentId}", call "${call.callId}", body hash ${call.bodyHash}`,
    source: "buildDemoCascadeBody (the mint's own builder)",
  });

  const delivery = await deliverCallBody(
    {
      pipelineBase: deps.target.httpBase,
      callToken: call.callToken,
      callId: call.callId,
      signedBody: call.signedBody,
    },
    deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {},
  );
  if (!delivery.ok) {
    checks.push({
      name: "delivery",
      code: delivery.code,
      ok: false,
      detail: `POST ${deps.target.httpBase}/v1/call-body refused: ${delivery.code} — ${delivery.message}`,
      source: `POST ${deps.target.httpBase}/v1/call-body`,
    });
    return { checks, mode: foundMode };
  }
  if (
    delivery.callId !== call.callId ||
    delivery.agentId !== call.agentId ||
    delivery.bodyHash !== call.bodyHash
  ) {
    checks.push({
      name: "delivery",
      code: "delivery-mismatch",
      ok: false,
      detail: `the service accepted call "${delivery.callId}" for "${delivery.agentId}" with body hash ${delivery.bodyHash}; the app sent "${call.callId}", "${call.agentId}", ${call.bodyHash}`,
      source: `POST ${deps.target.httpBase}/v1/call-body`,
    });
    return { checks, mode: foundMode };
  }
  checks.push({
    name: "delivery",
    code: "delivery",
    ok: true,
    detail: `POST ${deps.target.httpBase}/v1/call-body → 202 accepted; call "${call.callId}", subject "${call.agentId}"`,
    source: `POST ${deps.target.httpBase}/v1/call-body`,
  });

  // 4. Open the real socket with identity only and read the verdict.
  const config = buildConfigMessage({
    serviceUrl: deps.target.wsUrl,
    agentId: call.agentId,
    callToken: call.callToken,
    protocolVersion: CASCADE_PROTOCOL_VERSION,
  });
  let socket: ProverSocket;
  try {
    socket = connect(deps.target.wsUrl);
  } catch (error) {
    checks.push({
      name: "socket",
      code: "connect-failed",
      ok: false,
      detail: `could not open ${deps.target.wsUrl}: ${(error as Error).message}`,
      source: `WS ${deps.target.wsUrl}`,
    });
    return { checks, mode: foundMode };
  }
  const refusal = await awaitRefusal(socket, config, deps.timeoutMs);

  if (refusal.socketError !== null) {
    checks.push({
      name: "socket",
      code: "connect-failed",
      ok: false,
      detail: `the socket failed before a refusal: ${refusal.socketError}`,
      source: `WS ${deps.target.wsUrl}`,
    });
  } else if (refusal.timedOut) {
    checks.push({
      name: "refusal",
      code: "refusal-timeout",
      ok: false,
      detail: `no refusal frame within ${deps.timeoutMs} ms; the service never answered the config`,
      source: `WS ${deps.target.wsUrl}`,
    });
  } else if (refusal.code === "managed") {
    checks.push({
      name: "refusal",
      code: "refusal",
      ok: true,
      detail: `the service refused the new demo call with code "managed": ${refusal.message ?? "(no message)"}`,
      source: `WS ${deps.target.wsUrl}`,
    });
  } else {
    checks.push({
      name: "refusal",
      code: "refusal-code",
      ok: false,
      detail: `expected code "managed" (the routing kill switch), got ${
        refusal.code === null ? "no named refusal" : `code "${refusal.code}"`
      }${refusal.message ? `: ${refusal.message}` : ""}${
        refusal.closed && refusal.code === null ? " (the socket closed with no error frame)" : ""
      }`,
      source: `WS ${deps.target.wsUrl}`,
    });
  }

  // 5. No vendor work happened on the way to the refusal.
  const beforeError = refusal.frames
    .map((raw) => {
      try {
        const parsed = JSON.parse(raw) as { type?: unknown };
        return typeof parsed.type === "string" ? parsed.type : "(no type)";
      } catch {
        return "(unreadable)";
      }
    })
    .filter((type) => type !== "error");
  const callFrames = beforeError.filter((type) =>
    ["audio", "caption", "end", "interrupted", "end_call"].includes(type),
  );
  if (callFrames.length === 0) {
    checks.push({
      name: "no vendor work",
      code: "no-vendor-work",
      ok: true,
      detail: `no audio, caption, interrupted or end frame before the refusal (${refusal.frames.length} frame${refusal.frames.length === 1 ? "" : "s"} total, the refusal only)`,
      source: `WS ${deps.target.wsUrl}`,
    });
  } else {
    checks.push({
      name: "no vendor work",
      code: "vendor-work",
      ok: false,
      detail: `${callFrames.length} call frame(s) reached the caller before the refusal: ${callFrames.join(", ")}`,
      source: `WS ${deps.target.wsUrl}`,
    });
  }

  // 6. The trace: a refused call builds no lifecycle, so there is nothing to
  //    open a vendor leg for. Any greeting, turn or leg row is a violation.
  await sleep(250);
  const tracePath = `${deps.eventsDir.replace(/\/+$/, "")}/${call.callId}.jsonl`;
  if (!traceExists(tracePath)) {
    checks.push({
      name: "trace",
      code: "no-trace",
      ok: true,
      detail: `no trace artifact at ${tracePath}; the refusal happens before the call lifecycle is built`,
      source: tracePath,
    });
  } else {
    const offenders = forbiddenTraceRows(readTrace(tracePath));
    checks.push(
      offenders.length === 0
        ? {
            name: "trace",
            code: "no-trace-rows",
            ok: true,
            detail: `${tracePath} exists but carries no greeting, turn or vendor-leg row`,
            source: tracePath,
          }
        : {
            name: "trace",
            code: "no-trace-rows",
            ok: false,
            detail: `${tracePath} carries call work for a refused call: ${offenders.join(", ")}`,
            source: tracePath,
          },
    );
  }

  // 7. The visitor-facing state is cited from the ticket-16 rig, not re-run.
  const citation = readCitation(deps.citationPath);
  const missing = CITATION_MARKERS.filter((marker) => !citation.includes(marker));
  checks.push(
    missing.length === 0
      ? {
          name: "unavailable state",
          code: "unavailable-citation",
          ok: true,
          detail:
            "cited: the ticket-16 rig proves a refused connect shows data-testid=\"demo-unavailable\" with DEMO_UNAVAILABLE_MESSAGES.managed and opens zero managed sessions; the browser is not re-run here",
          source: deps.citationPath,
        }
      : {
          name: "unavailable state",
          code: "unavailable-citation",
          ok: false,
          detail: `the cited rig does not name: ${missing.join("; ")}`,
          source: deps.citationPath,
        },
  );

  // 8. Restore, or leave off for the operator's recorded restore.
  if (deps.keepOff) {
    checks.push({
      name: "restore",
      code: "left-off",
      ok: true,
      detail:
        "the switch is left off (--keep-off); restore it with the operator's own --set command so the audit names the human",
      source: "cutover-check --keep-off",
    });
  } else if (foundMode === "off") {
    checks.push({
      name: "restore",
      code: "nothing-to-restore",
      ok: true,
      detail: "the switch was already off before the proof; nothing was restored",
      source: SHOW_SOURCE,
    });
  } else {
    const restore = flipSwitch(deps.store, deps.runner, {
      mode: foundMode,
      operator,
      reason: `restore ${foundMode} after kill-switch proof`,
    });
    checks.push(...restore.checks);
    if (restore.view === null) return { checks, mode: foundMode };
  }

  // 9. Print the audit that remains.
  const final = readSwitch(deps.store, deps.runner);
  checks.push(...final.checks);
  return { checks, mode: final.view?.mode ?? foundMode };
}

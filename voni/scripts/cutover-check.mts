/**
 * `npm run cutover:check` — the cutover proof command (ticket 25).
 *
 * The pure surface (flags, the switch read/flip, the audit re-read, the
 * kill-switch proof) lives in `./lib/cutover.ts`; this file is the operator
 * join: argv, the store selection, the interpreter, the target and the printed
 * report.
 *
 * The production switch is the operator's human step. This command runs
 * against whatever store it is pointed at and never claims a production action
 * it did not observe. It is never run by the pull-request workflow; CI runs
 * `scripts/cutover.test.ts` only.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { secret } from "../src/lib/env";
import {
  CUTOVER_USAGE,
  CutoverUsageError,
  cutoverExitCode,
  describeStore,
  flipSwitch,
  formatCutoverReport,
  parseCutoverArgs,
  proveOff,
  readSwitch,
  type CliResult,
  type CliRunner,
  type CutoverCheck,
  type CutoverOptions,
  type SwitchStore,
} from "./lib/cutover";
import { ROUTING_SWITCH_PATH } from "./lib/parity";
import { resolveTargets, type RealLegsTarget } from "./lib/real-legs";

const EVENTS_DIR_ENV = "VOICE_PIPELINE_EVENTS_DIR";
const PIPELINE_URL_ENV = "VOICE_PIPELINE_URL";
const SERVICE_URL_ENV = "VOICE_PIPELINE_SERVICE_URL";

class UsageError extends Error {}

/** Exactly one store, explicit flags before environment; no hidden default. */
function resolveStore(options: CutoverOptions): SwitchStore {
  const sqliteFlag = options.sqlite.trim();
  const dsnFlag = options.databaseUrl.trim();
  if (sqliteFlag !== "" && dsnFlag !== "") {
    throw new UsageError(
      "ambiguous store: pass exactly one of --sqlite or --database-url, because one command must read one switch",
    );
  }
  const sqlite =
    sqliteFlag !== ""
      ? sqliteFlag
      : dsnFlag === ""
        ? (process.env.CASCADE_STORE_PATH ?? "").trim()
        : "";
  const databaseUrl =
    dsnFlag !== ""
      ? dsnFlag
      : sqliteFlag === ""
        ? (process.env.DATABASE_URL ?? "").trim()
        : "";
  if (sqlite !== "" && databaseUrl !== "") {
    throw new UsageError(
      "ambiguous store: both CASCADE_STORE_PATH and DATABASE_URL are set; pass exactly one flag",
    );
  }
  if (sqlite === "" && databaseUrl === "") {
    throw new UsageError(
      "no store configured: pass --sqlite PATH or --database-url DSN (or set CASCADE_STORE_PATH / DATABASE_URL); there is no hidden default",
    );
  }
  const label =
    sqliteFlag !== ""
      ? `sqlite ${sqlite} (flag --sqlite)`
      : dsnFlag !== ""
        ? "postgres (flag --database-url)"
        : sqlite !== ""
          ? `sqlite ${sqlite} (env CASCADE_STORE_PATH)`
          : "postgres (env DATABASE_URL)";
  return { sqlite, databaseUrl, python: options.python, label };
}

/**
 * The one operator CLI, spawned with exactly one store flag. Both store
 * variables are removed from the child so an inherited env cannot make the
 * invocation ambiguous; the DSN is passed as an argument, never printed.
 */
function runnerFor(store: SwitchStore): CliRunner {
  return (args: string[]): CliResult => {
    const childEnv = { ...process.env };
    delete childEnv.CASCADE_STORE_PATH;
    delete childEnv.DATABASE_URL;
    const result = spawnSync(store.python, [ROUTING_SWITCH_PATH, ...args], {
      encoding: "utf8",
      timeout: 30_000,
      env: childEnv,
    });
    if (result.error) {
      throw new Error(
        `could not run ${store.python} for the routing switch: ${result.error.message}; pass --python or set PYTHON`,
      );
    }
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
}

async function resolveTarget(options: CutoverOptions): Promise<RealLegsTarget> {
  let baseUrl = options.baseUrl?.trim() ?? "";
  if (baseUrl === "" && (options.wsUrl?.trim() ?? "") === "") {
    for (const name of [PIPELINE_URL_ENV, SERVICE_URL_ENV]) {
      const value = await secret(name);
      if (value && value.trim() !== "") {
        baseUrl = value.trim();
        break;
      }
    }
  }
  return resolveTargets({ baseUrl, wsUrl: options.wsUrl });
}

function resolveEventsDir(options: CutoverOptions): string {
  const flagged = options.eventsDir?.trim() ?? "";
  if (flagged !== "") return flagged;
  const configured = (process.env[EVENTS_DIR_ENV] ?? "").trim();
  if (configured !== "") return configured;
  return fileURLToPath(new URL("../../voice-pipeline/.events", import.meta.url));
}

function writeJson(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function report(
  action: string,
  checks: CutoverCheck[],
  json: boolean,
  title?: string,
  store?: SwitchStore,
): number {
  if (json) {
    writeJson({
      ok: cutoverExitCode(checks) === 0,
      action,
      ...(store ? { store: describeStore(store) } : {}),
      checks,
    });
  } else {
    if (store) {
      process.stdout.write(`store: ${describeStore(store)}\n`);
    }
    process.stdout.write(formatCutoverReport(checks, title));
  }
  return cutoverExitCode(checks);
}

export async function main(argv: string[]): Promise<number> {
  let options: CutoverOptions;
  try {
    options = parseCutoverArgs(argv);
  } catch (error) {
    if (error instanceof CutoverUsageError) {
      process.stderr.write(`cutover-check: ${error.message}\n\n${CUTOVER_USAGE}\n`);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    process.stdout.write(`${CUTOVER_USAGE}\n`);
    return 0;
  }

  let store: SwitchStore;
  let target: RealLegsTarget | null = null;
  try {
    store = resolveStore(options);
    if (options.action === "prove-off") target = await resolveTarget(options);
  } catch (error) {
    if (error instanceof UsageError || error instanceof CutoverUsageError) {
      process.stderr.write(`cutover-check: ${error.message}\n\n${CUTOVER_USAGE}\n`);
      return 2;
    }
    const named = error as { code?: string; message: string };
    const checks: CutoverCheck[] = [
      {
        name: "target",
        code: named.code ?? "target-invalid",
        ok: false,
        detail: named.message,
        source: "cutover-check target resolution",
      },
    ];
    return report(options.action, checks, options.json);
  }

  const runner = runnerFor(store);

  if (options.action === "show") {
    const result = readSwitch(store, runner);
    return report(
      "show",
      result.checks,
      options.json,
      "demo-cascade routing switch (ticket 25)",
      store,
    );
  }

  if (options.action === "set") {
    const result = flipSwitch(store, runner, {
      mode: options.mode as NonNullable<CutoverOptions["mode"]>,
      operator: options.operator as string,
      reason: options.reason as string,
    });
    return report(
      "set",
      result.checks,
      options.json,
      "demo-cascade routing switch flip (ticket 25)",
      store,
    );
  }

  const result = await proveOff({
    store,
    runner,
    target: target as RealLegsTarget,
    eventsDir: resolveEventsDir(options),
    voice: options.voice,
    timeoutMs: options.timeoutMs,
    keepOff: options.keepOff,
    ...(options.operator !== undefined ? { operator: options.operator } : {}),
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
    citationPath: fileURLToPath(
      new URL("../tests/e2e/cascade-delivery.spec.ts", import.meta.url),
    ),
  });
  return report(
    "prove-off",
    result.checks,
    options.json,
    "demo-cascade kill-switch proof (ticket 25)",
    store,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `cutover-check: ${(error as Error).name}: ${(error as Error).message}\n`,
      );
      process.exitCode = 1;
    });
}

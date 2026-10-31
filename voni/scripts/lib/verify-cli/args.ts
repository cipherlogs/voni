/**
 * The `demo:verify` argv contract: one command, three targets, four modes, an
 * optional Locale filter and one single-scenario diagnose form.
 *
 * Parsing only decides what was asked. It never decides whether the run can
 * happen (corpus, keys, vendor builds and the target's evidence sink are
 * preflighted later, so every gap is named in one refusal). A duplicate mode,
 * an unknown flag, an extra argument or a value flag without a value is exit 2
 * before any adapter opens.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Commands and exit codes".
 */

import { CERTIFICATE_TARGETS, type CertificateTarget } from "@/lib/demo/verification/certificate";
import { LOCALES, type Locale } from "@/lib/demo/verification/scenarios";

import { refuse } from "./errors";

/** The run plans the command dispatches; cutover stays ticket 29's gate. */
export const VERIFY_MODES = ["diagnose", "fast", "nightly", "full"] as const;

export type VerifyMode = (typeof VERIFY_MODES)[number];

/** One lower-case slug, the corpus directory-name rule. */
const SCENARIO_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type VerifyRequest = {
  readonly mode: VerifyMode;
  readonly target: CertificateTarget;
  readonly locale?: Locale;
  readonly scenario?: string;
  readonly appUrl?: string;
  readonly pipelineUrl?: string;
  readonly eventsDir?: string;
  readonly capturesDir?: string;
  readonly runRoot?: string;
  readonly corpusDir?: string;
  readonly vendorBuildsPath?: string;
  readonly timingLockPath?: string;
  readonly json: boolean;
  readonly help: boolean;
};

const VALUE_FLAGS = {
  "--target": "target",
  "--locale": "locale",
  "--scenario": "scenario",
  "--app-url": "appUrl",
  "--pipeline-url": "pipelineUrl",
  "--events-dir": "eventsDir",
  "--captures-dir": "capturesDir",
  "--run-root": "runRoot",
  "--corpus-dir": "corpusDir",
  "--vendor-builds": "vendorBuildsPath",
  "--timing-lock": "timingLockPath",
} as const;

type ValueFlag = keyof typeof VALUE_FLAGS;
type ValueField = (typeof VALUE_FLAGS)[ValueFlag];

const MODE_FLAGS: Readonly<Record<string, VerifyMode>> = {
  "--diagnose": "diagnose",
  "--fast": "fast",
  "--nightly": "nightly",
  "--full": "full",
};

/** Strip the repository's invocation prefix; a foreign program is bad input. */
function stripProgram(argv: readonly string[]): readonly string[] {
  if (argv[0] === "demo:verify") return argv.slice(1);
  if (argv[0] !== "npm") return argv;
  if (argv[1] !== "run" || argv[2] !== "demo:verify") {
    refuse(
      "bad-input",
      `the command must run "demo:verify", got "${argv.slice(0, 3).join(" ")}"`,
    );
  }
  const rest = argv.slice(3);
  if (rest[0] === "--") return rest.slice(1);
  return rest;
}

/**
 * Parse one invocation. The result records what was asked; validation that
 * depends on the corpus, the environment or the stack is a later preflight.
 */
export function parseVerifyArgs(argv: readonly string[]): VerifyRequest {
  const tokens = stripProgram(argv);
  const values: Partial<Record<ValueField, string>> = {};
  const modes: VerifyMode[] = [];
  let json = false;
  let help = false;

  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at] as string;
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    const mode = MODE_FLAGS[token];
    if (mode !== undefined) {
      modes.push(mode);
      continue;
    }
    if (token in VALUE_FLAGS) {
      const flag = token as ValueFlag;
      const value = tokens[at + 1];
      if (value === undefined || value.startsWith("--")) {
        refuse("bad-input", `${flag} needs a value`);
      }
      const field = VALUE_FLAGS[flag];
      if (values[field] !== undefined) {
        refuse("bad-input", `${flag} is given twice; a run has one ${field}`);
      }
      values[field] = value;
      at += 1;
      continue;
    }
    if (token.startsWith("-")) {
      refuse("bad-input", `unknown flag "${token}"`);
    }
    refuse("bad-input", `unexpected argument "${token}"`);
  }

  if (help) {
    return {
      mode: modes[0] ?? "full",
      target: "local",
      json,
      help: true,
    };
  }

  if (modes.length > 1) {
    refuse(
      "bad-input",
      `exactly one mode is required, got ${modes.map((mode) => `--${mode}`).join(" and ")}`,
    );
  }
  const mode: VerifyMode = modes[0] ?? "full";

  const targetValue = values.target ?? "local";
  if (!(CERTIFICATE_TARGETS as readonly string[]).includes(targetValue)) {
    refuse(
      "unknown-target",
      `unknown target "${targetValue}"; expected ${CERTIFICATE_TARGETS.join(", ")}`,
    );
  }
  const target = targetValue as CertificateTarget;

  const localeValue = values.locale;
  if (localeValue !== undefined && !(LOCALES as readonly string[]).includes(localeValue)) {
    refuse(
      "unknown-locale",
      `unknown Locale "${localeValue}"; expected ${LOCALES.join(", ")}`,
    );
  }
  const locale = localeValue as Locale | undefined;

  const scenario = values.scenario;
  if (scenario !== undefined && !SCENARIO_NAME.test(scenario)) {
    refuse(
      "bad-input",
      `"${scenario}" is not a scenario name; a name is one lower-case slug, never a path`,
    );
  }
  if (mode === "diagnose" && scenario === undefined) {
    refuse("missing-scenario", "--diagnose needs --scenario <name>; a diagnosis is one scenario");
  }
  if (mode !== "diagnose" && scenario !== undefined) {
    refuse(
      "bad-input",
      `--scenario belongs to --diagnose; a ${mode} run covers its plan, never one named scenario`,
    );
  }
  if (mode === "fast" && locale !== undefined && locale !== "en") {
    refuse(
      "bad-input",
      `the fast contract speaks en; --locale ${locale} is not a fast run`,
    );
  }

  return {
    mode,
    target,
    ...(locale === undefined ? {} : { locale }),
    ...(scenario === undefined ? {} : { scenario }),
    ...(values.appUrl === undefined ? {} : { appUrl: values.appUrl }),
    ...(values.pipelineUrl === undefined ? {} : { pipelineUrl: values.pipelineUrl }),
    ...(values.eventsDir === undefined ? {} : { eventsDir: values.eventsDir }),
    ...(values.capturesDir === undefined ? {} : { capturesDir: values.capturesDir }),
    ...(values.runRoot === undefined ? {} : { runRoot: values.runRoot }),
    ...(values.corpusDir === undefined ? {} : { corpusDir: values.corpusDir }),
    ...(values.vendorBuildsPath === undefined
      ? {}
      : { vendorBuildsPath: values.vendorBuildsPath }),
    ...(values.timingLockPath === undefined
      ? {}
      : { timingLockPath: values.timingLockPath }),
    json,
    help: false,
  };
}

/** The usage block every entry point prints. */
export const VERIFY_USAGE = `usage: npm run demo:verify -- --target <local|staging|production> [--full|--fast|--diagnose|--nightly]
       npm run demo:verify -- --scenario <name> --target local --diagnose
       npm run demo:verify -- --locale <en|es|fr|de|pt>

  --target T          local | staging | production (default local)
  --full              full certification (default)
  --fast              the ten-scenario English fast contract
  --nightly           nightly health (English 43 + Locale core 12)
  --diagnose          one scenario's diagnosis; never a certificate
  --scenario NAME     the scenario --diagnose runs
  --locale L          en | es | fr | de | pt (a Locale filter)
  --app-url URL       the real app (default VONI_APP_URL)
  --pipeline-url URL  the real pipeline (default VOICE_PIPELINE_URL)
  --events-dir PATH   the pipeline's per-call trace directory
  --captures-dir PATH the app's gitignored .captures directory
  --run-root PATH     where run directories are written
  --corpus-dir PATH   a different corpus root
  --vendor-builds P   the committed vendor-build record
  --timing-lock P     the machine-wide timing lock path
  --json              print one machine-readable result
  --help, -h          this text

Exit codes: 0 certified, 1 not-demo-ready, 2 bad input or missing evidence,
3 pending human panel. A held timing lock is a named refusal, never a wait.`;

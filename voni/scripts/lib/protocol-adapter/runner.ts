/**
 * The protocol adapter runner: one scenario, one real call, one verdict.
 *
 * Order of operations, and why it is this order:
 *
 * 1. **Preflight.** A missing key, corpus, scenario, vendor build or
 *    soundscape is refused by name with exit 2, before any vendor is opened.
 * 2. **One call.** The call adapter runs exactly once. There is no retry: a
 *    failure is evidence, not a reason to try again.
 * 3. **Evidence.** The trace, the end document, the priced row, the tool rows
 *    and the received PCM are read from the call. Cost is copied, never
 *    recomputed.
 * 4. **Verdict.** The one evidence bundle is judged by the real verdict engine
 *    and every declared evaluator. No evaluator means the property fails; this
 *    adapter has no power to stub a pass.
 * 5. **Cards.** A card is built only when the verdict itself cites a session,
 *    a turn and a module pointer. Everything else is a recorded gap.
 *
 * The adapter never writes a certificate. `certifiable` is always false and the
 * run record says the certification is withheld for the browser adapter.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "One seam, two adapters",
 * "Targets, runs and cadence" and "No retries".
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readCodeFingerprint,
} from "@/lib/demo/scoreboard";
import { loadContract, type Contract } from "@/lib/demo/verification/contract";
import { parseReplayCommand, renderDefectCards } from "@/lib/demo/verification/cards";
import {
  DEFAULT_CORPUS_DIR,
  type CorpusReference,
  type Locale,
} from "@/lib/demo/verification/scenarios";
import {
  evaluateScenarios,
  judgeRun,
  loadEvaluators,
  type PropertyEvaluator,
  type RunVerdict,
  type ScenarioAttempt,
} from "@/lib/demo/verification/verdict";

import { ProtocolAdapterError } from "./errors";
import {
  assembleEvidence,
  buildCards,
  cardInputs,
  requireSafeId,
  runDirectory,
  writeJson,
} from "./evidence";
import {
  defaultVendorBuildsPath,
  preflight,
  readVendorBuilds,
} from "./refusals";
import {
  DEFAULT_CALL_TIMEOUT_MS,
  runProtocolCall,
  type ProtocolCallDeps,
} from "./transport";
import {
  DEFAULT_RUN_ROOT,
  PROTOCOL_ADAPTER,
  PROTOCOL_RUN_SCHEMA_VERSION,
  type CardGap,
  type ProtocolCallAdapter,
  type ProtocolCallRecord,
  type ProtocolRunRecord,
  type ProtocolRunResult,
  type ProtocolRunStatus,
  type ProtocolTargetLabel,
  type VendorBuildRecord,
  type MissingItem,
} from "./types";
import type { CardTarget } from "@/lib/demo/verification/cards";

export type ProtocolRunInput = {
  readonly scenarioName: string;
  readonly target: ProtocolTargetLabel;
  readonly locale?: Locale;
  /** Defaults to the committed corpus root (ticket 12 fills it). */
  readonly corpusDir?: string | URL;
  /** Defaults to the live contract registry. */
  readonly contract?: Contract;
  /** Defaults to the discovered evaluator modules. */
  readonly evaluators?: readonly PropertyEvaluator[];
  /** Defaults to the real transport; tests inject a fake call. */
  readonly call?: ProtocolCallAdapter;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly targetUrl?: { readonly baseUrl?: string; readonly wsUrl?: string };
  readonly runRoot?: string;
  /** Defaults to the local pipeline's `.events` directory. */
  readonly eventsDir?: string;
  readonly vendorBuilds?: VendorBuildRecord | null;
  readonly vendorBuildsPath?: string;
  readonly soundscapes?: Readonly<Record<string, Uint8Array>>;
  readonly modules?: Readonly<Record<string, readonly string[]>>;
  readonly repoRoot?: string;
  readonly runId?: string;
  readonly callId?: string;
  readonly timeoutMs?: number;
  /** Bounded wait for the service's end sidecar; tests shorten it. */
  readonly endWaitMs?: number;
  readonly transport?: ProtocolCallDeps;
};

const VONI_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function defaultEventsDir(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env.VOICE_PIPELINE_EVENTS_DIR?.trim();
  if (configured !== undefined && configured !== "") return configured;
  return join(VONI_ROOT, "voice-pipeline", ".events");
}

function defaultTargetUrl(
  env: Readonly<Record<string, string | undefined>>,
): { baseUrl: string } | Record<string, never> {
  const base =
    env.VOICE_PIPELINE_SERVICE_URL?.trim() ||
    env.VOICE_PIPELINE_URL?.trim() ||
    "";
  return base === "" ? {} : { baseUrl: base };
}

function statusOf(verdict: RunVerdict): ProtocolRunStatus {
  switch (verdict.verdict) {
    case "certified":
      return "clean-diagnosis";
    case "ineligible":
      return "ineligible";
    case "not-demo-ready":
      return "findings";
  }
}

function moduleMap(input: ProtocolRunInput): Readonly<Record<string, readonly string[]>> {
  return input.modules ?? {};
}

/** Write a refused run's record, then return it. A refusal is still evidence. */
async function refused(
  runId: string,
  runDir: string,
  error: ProtocolAdapterError,
  context: {
    readonly target: ProtocolTargetLabel;
    readonly locale: Locale;
    readonly scenarioName: string;
    readonly corpus: CorpusReference | null;
    readonly scenarioFingerprint: string | null;
    readonly codeFingerprint: ProtocolRunRecord["codeFingerprint"];
    readonly startedAt: string;
    readonly call: ProtocolCallRecord | null;
  },
): Promise<ProtocolRunResult> {
  const record: ProtocolRunRecord = {
    schemaVersion: PROTOCOL_RUN_SCHEMA_VERSION,
    runId,
    adapter: PROTOCOL_ADAPTER,
    target: context.target,
    scenario: context.scenarioName,
    locale: context.locale,
    corpus: context.corpus,
    scenarioFingerprint: context.scenarioFingerprint,
    codeFingerprint: context.codeFingerprint,
    certifiable: false,
    certification: "withheld",
    certificationReason: "the protocol adapter diagnoses and never certifies",
    startedAt: context.startedAt,
    endedAt: new Date().toISOString(),
    status: "refused",
    call: context.call,
    verdict: null,
    cards: { file: null, count: 0, gaps: [] },
    unrun: [error.message],
    refusal: { code: error.code, message: error.message },
  };
  await mkdir(runDir, { recursive: true });
  await writeJson(join(runDir, "run.json"), record);
  return {
    runId,
    runDir,
    status: "refused",
    exitCode: 2,
    verdict: null,
    cards: [],
    cardGaps: [],
    call: context.call,
    unrun: [error.message],
    corpus: context.corpus,
    scenario: null,
    target: context.target,
    locale: context.locale,
  };
}

function refusalCodeFor(missing: readonly MissingItem[]): ProtocolAdapterError["code"] {
  const items = missing.map((item) => item.item);
  if (items.some((item) => item.endsWith("_KEY") || item.endsWith("_SECRET"))) return "missing-key";
  if (items.some((item) => item.startsWith("vendor-build"))) return "missing-vendor-build";
  if (items.some((item) => item.startsWith("soundscape:"))) return "missing-soundscape";
  if (items.some((item) => item === "target")) return "missing-target";
  if (items.some((item) => item.startsWith("scenario:"))) return "missing-scenario";
  return "missing-corpus";
}

/**
 * Run one diagnosis. The returned `exitCode` is 2 for a refusal and 1 for a
 * completed run; 0 is reserved for a certificate, which this adapter cannot
 * produce.
 */
export async function runProtocolDiagnosis(
  input: ProtocolRunInput,
): Promise<ProtocolRunResult> {
  const env = input.env ?? process.env;
  const startedAt = new Date().toISOString();
  const runId = requireSafeId(
    input.runId ?? `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    "run id",
  );
  const runDir = runDirectory(input.runRoot ?? DEFAULT_RUN_ROOT, runId);
  const repoRoot = input.repoRoot ?? REPO_ROOT;
  const locale = input.locale ?? "en";
  const codeFingerprint = readCodeFingerprint(repoRoot);

  const contract = input.contract ?? (await loadContract());
  const evaluators = input.evaluators ?? (await loadEvaluators(contract));
  const vendorBuildsPath = input.vendorBuildsPath ?? defaultVendorBuildsPath();
  let vendorBuilds = input.vendorBuilds;
  if (vendorBuilds === undefined) {
    vendorBuilds = await readVendorBuilds(vendorBuildsPath);
  }

  let preflightAnswer;
  try {
    preflightAnswer = await preflight({
      scenarioName: input.scenarioName,
      target: input.target,
      locale: input.locale,
      corpusDir: input.corpusDir ?? DEFAULT_CORPUS_DIR,
      knownProperties: new Set(contract.properties.map((property) => property.id)),
      env,
      targetUrl: input.targetUrl ?? defaultTargetUrl(env),
      vendorBuilds,
      vendorBuildsPath,
      soundscapes: input.soundscapes ?? {},
    });
  } catch (error) {
    const refusedError =
      error instanceof ProtocolAdapterError
        ? error
        : new ProtocolAdapterError("corpus-refused", String(error));
    return refused(runId, runDir, refusedError, {
      target: input.target,
      locale,
      scenarioName: input.scenarioName,
      corpus: null,
      scenarioFingerprint: null,
      codeFingerprint,
      startedAt,
      call: null,
    });
  }

  if (!preflightAnswer.ok) {
    const missing: readonly MissingItem[] = preflightAnswer.missing;
    const error = new ProtocolAdapterError(
      refusalCodeFor(missing),
      `the protocol run cannot start; missing: ${missing
        .map((item) => `${item.item} (${item.detail})`)
        .join("; ")}`,
      missing,
    );
    return refused(runId, runDir, error, {
      target: input.target,
      locale,
      scenarioName: input.scenarioName,
      corpus: null,
      scenarioFingerprint: null,
      codeFingerprint,
      startedAt,
      call: null,
    });
  }

  const { scenario, corpus, target } = preflightAnswer;

  if (scenario.heldOut) {
    const error = new ProtocolAdapterError(
      "corpus-refused",
      `scenario "${scenario.name}" is held out; a held-out scenario runs only in a ` +
        "certification, and the protocol adapter never certifies (RR-07)",
    );
    return refused(runId, runDir, error, {
      target: input.target,
      locale,
      scenarioName: input.scenarioName,
      corpus: { version: corpus.version, sha256: corpus.fingerprint },
      scenarioFingerprint: scenario.fingerprint,
      codeFingerprint,
      startedAt,
      call: null,
    });
  }

  if (!target.local && input.eventsDir === undefined) {
    const error = new ProtocolAdapterError(
      "evidence-unreachable",
      `target "${input.target}" is not loopback and no --events-dir was supplied; ` +
        "the trace, end document and priced row live on the service host, and the run " +
        "cannot judge evidence it cannot read",
    );
    return refused(runId, runDir, error, {
      target: input.target,
      locale,
      scenarioName: input.scenarioName,
      corpus: { version: corpus.version, sha256: corpus.fingerprint },
      scenarioFingerprint: scenario.fingerprint,
      codeFingerprint,
      startedAt,
      call: null,
    });
  }

  const callId = input.callId ?? randomUUID();
  const eventsDir = input.eventsDir ?? defaultEventsDir(env);
  await mkdir(runDir, { recursive: true });

  const callAdapter: ProtocolCallAdapter =
    input.call ??
    ((callInput) =>
      runProtocolCall(callInput, {
        ...(input.transport ?? {}),
      }));

  let call;
  try {
    call = await callAdapter({
      scenario,
      callId,
      target,
      targetLabel: input.target,
      soundscapePcm:
        scenario.soundscape.id === "quiet-room"
          ? null
          : (input.soundscapes ?? {})[scenario.soundscape.id] ?? null,
      timeoutMs: input.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      env,
    });
  } catch (error) {
    const refusedError =
      error instanceof ProtocolAdapterError
        ? error
        : new ProtocolAdapterError(
            "call-refused",
            `the protocol call failed: ${(error as Error).message}`,
          );
    return refused(runId, runDir, refusedError, {
      target: input.target,
      locale,
      scenarioName: input.scenarioName,
      corpus: { version: corpus.version, sha256: corpus.fingerprint },
      scenarioFingerprint: scenario.fingerprint,
      codeFingerprint,
      startedAt,
      call: null,
    });
  }

  const callDir = join(runDir, "calls", requireSafeId(call.callId, "call id"));
  let assembled;
  let callRecord;
  try {
    ({ assembled, record: callRecord } = await assembleEvidence({
      call,
      scenario,
      target: input.target,
      eventsDir,
      callDir,
      ...(input.endWaitMs === undefined ? {} : { endWaitMs: input.endWaitMs }),
    }));
  } catch (error) {
    const refusedError =
      error instanceof ProtocolAdapterError
        ? error
        : new ProtocolAdapterError("trace-missing", String(error));
    return refused(runId, runDir, refusedError, {
      target: input.target,
      locale,
      scenarioName: input.scenarioName,
      corpus: { version: corpus.version, sha256: corpus.fingerprint },
      scenarioFingerprint: scenario.fingerprint,
      codeFingerprint,
      startedAt,
      call: null,
    });
  }

  const attempt: ScenarioAttempt = {
    scenario: scenario.name,
    repetition: 1,
    locale: scenario.locale,
    target: input.target,
    evidence: assembled.bundle,
  };
  const evidence = await evaluateScenarios({
    contract,
    evaluators,
    attempts: [attempt],
  });
  const verdict = judgeRun({
    runId,
    contract,
    evidence,
    calls: [assembled.eligibility],
  });

  const cardData = cardInputs({
    runId,
    verdict,
    target: input.target,
    scenario,
    record: callRecord,
    bundle: assembled.bundle,
    modules: moduleMap(input),
    repoRoot,
  });
  const cardBuild =
    cardData.gaps.length === 0
      ? buildCards({
          runId,
          verdict,
          target: input.target,
          calls: cardData.call === null ? [] : [cardData.call],
          attributions: cardData.attributions,
          modules: moduleMap(input),
          repoRoot,
        })
      : { cards: [], gaps: [] };
  const allCardGaps: CardGap[] = [...cardData.gaps, ...cardBuild.gaps];

  const verdictFile = join(runDir, "verdict.json");
  await writeJson(verdictFile, verdict);
  const cards = cardBuild.cards;
  let cardsFile: string | null = null;
  if (cards.length > 0) {
    cardsFile = join(runDir, "cards.json");
    await writeJson(cardsFile, cards);
    await writeJson(join(runDir, "cards.md"), renderDefectCards(cards));
  }

  const unrun: string[] = [
    "browser marks are not available on the protocol adapter; mark-level properties require ticket 17",
    "one call per scenario: properties requiring more than one repetition fail their repetition plan",
  ];
  if (evaluators.length === 0) {
    unrun.push(
      `no evaluator modules are installed; ${contract.properties.length} properties fail with no-evaluator (tickets 13–22, 26)`,
    );
  } else if (evaluators.length < contract.properties.length) {
    unrun.push(
      `${contract.properties.length - evaluators.length} properties have no evaluator and fail closed`,
    );
  }
  unrun.push(...assembled.gaps);
  if (assembled.bundle.ledger.endGap !== null) unrun.push(assembled.bundle.ledger.endGap);
  for (const gap of allCardGaps) {
    unrun.push(`defect card for ${gap.propertyId} withheld (${gap.code}): ${gap.detail}`);
  }

  const status = statusOf(verdict);
  const record: ProtocolRunRecord = {
    schemaVersion: PROTOCOL_RUN_SCHEMA_VERSION,
    runId,
    adapter: PROTOCOL_ADAPTER,
    target: input.target,
    scenario: scenario.name,
    locale: scenario.locale,
    corpus: { version: corpus.version, sha256: corpus.fingerprint },
    scenarioFingerprint: scenario.fingerprint,
    codeFingerprint,
    certifiable: false,
    certification: "withheld",
    certificationReason: codeFingerprint === null
      ? "the protocol adapter diagnoses and never certifies; the code fingerprint was unavailable"
      : "the protocol adapter diagnoses and never certifies; a certificate requires the browser adapter (ticket 17)",
    startedAt,
    endedAt: new Date().toISOString(),
    status,
    call: callRecord,
    verdict: {
      verdict: verdict.verdict,
      failedPropertyIds: verdict.failedPropertyIds,
      unknownPropertyIds: verdict.unknownPropertyIds,
      failures: verdict.failures,
      detail: verdict.detail,
      file: verdictFile,
    },
    cards: { file: cardsFile, count: cards.length, gaps: allCardGaps },
    unrun,
    refusal: null,
  };
  await writeJson(join(runDir, "run.json"), record);

  return {
    runId,
    runDir,
    status,
    exitCode: 1,
    verdict,
    cards,
    cardGaps: allCardGaps,
    call: callRecord,
    unrun,
    corpus: { version: corpus.version, sha256: corpus.fingerprint },
    scenario,
    target: input.target as CardTarget,
    locale: scenario.locale,
  };
}


/**
 * Run the exact replay command a defect card carries, unchanged.
 *
 * The parser is ticket 09's and is not re-implemented here: a card's command,
 * the `npm run demo:verify --` form and the bare form are the same contract.
 * The runner only adds its own corpus, evidence and credentials.
 */
export async function runReplayCommand(
  command: string,
  input: Omit<ProtocolRunInput, "scenarioName" | "target" | "locale">,
): Promise<ProtocolRunResult> {
  const replay = parseReplayCommand(command);
  return runProtocolDiagnosis({
    ...input,
    scenarioName: replay.scenario,
    target: replay.target,
    locale: replay.locale,
  });
}

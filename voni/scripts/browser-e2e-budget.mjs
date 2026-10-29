/**
 * The browser E2E runtime budget, read from the one cascade registry.
 *
 * Spec (`.scratch/meta-cascade/spec.md`, open dependency 18): the browser E2E
 * runs on every PR and has a bounded runtime; if it outgrows the PR budget it
 * moves to a required pre-merge job, never nightly-only. The number is an
 * *open* operational value, so it lives in
 * `voice-pipeline/cascade/thresholds.json` (ticket 03) and nowhere else.
 *
 * This module reads that boundary. An open bound is a named blocker: the run
 * still happens, says it made no runtime claim, and prints the bound and the
 * ticket that owes the value. It never substitutes a default, a workflow
 * `timeout-minutes`, or any other invented number.
 *
 * Plain JS on purpose: `scripts/e2e-run.mjs` is run by bare `node`, so this
 * module cannot depend on the TypeScript loader.
 */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The registry entry this gate consumes. */
export const BUDGET_BOUND = "ci.browser_e2e_budget_s";

const HERE = dirname(fileURLToPath(import.meta.url));

/** `voni/` from `voni/scripts/`. */
export const APP_ROOT = resolve(HERE, "..");

/** The repo root that owns both the registry and the app. */
export const REPO_ROOT = resolve(APP_ROOT, "..");

/** Where the one registry ships. */
export const REGISTRY_PATH = join(
  REPO_ROOT,
  "voice-pipeline",
  "cascade",
  "thresholds.json",
);

export class BudgetRegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = "BudgetRegistryError";
  }
}

export class UnknownBoundError extends BudgetRegistryError {
  constructor(name, declared) {
    super(
      `unknown cascade bound ${JSON.stringify(name)}; declared bounds: ` +
        [...declared].sort().join(", "),
    );
    this.name = "UnknownBoundError";
    this.bound = name;
  }
}

export class UnsetBoundError extends Error {
  constructor(budget) {
    super(budget.blocker);
    this.name = "UnsetBoundError";
    this.bound = budget.bound;
    this.ticket = budget.ticket;
    this.gate = budget.gate;
  }
}

function readJson(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new BudgetRegistryError(
      `cannot read the cascade threshold registry at ${path}: ${error.message}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new BudgetRegistryError(
      `the cascade threshold registry at ${path} is not valid JSON: ${error.message}`,
    );
  }
}

function text(value, field, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BudgetRegistryError(
      `bound ${JSON.stringify(name)} must name its ${field} (a non-empty string)`,
    );
  }
  return value.trim();
}

/** Resolve the record a `budget_key` points at, the same rule the Python registry uses. */
function readBudgetRecord(declared, repoRoot) {
  if (typeof declared !== "object" || declared === null) {
    throw new BudgetRegistryError(
      "the cascade threshold registry has no 'budget_record' object",
    );
  }
  const declaredPath = text(declared.path, "budget_record.path", "budget_record");
  const path = isAbsolute(declaredPath)
    ? declaredPath
    : resolve(repoRoot, declaredPath);
  const parsed = readJson(path);
  if (typeof parsed !== "object" || parsed === null) {
    throw new BudgetRegistryError(`the budget record at ${path} is not an object`);
  }
  if (parsed.version !== declared.version) {
    throw new BudgetRegistryError(
      `the budget record at ${path} is version ${JSON.stringify(parsed.version)}, ` +
        `but the registry expects ${JSON.stringify(declared.version)}`,
    );
  }
  if (typeof parsed.budgets !== "object" || parsed.budgets === null) {
    throw new BudgetRegistryError(`the budget record at ${path} has no 'budgets' object`);
  }
  return { budgets: parsed.budgets, label: declaredPath };
}

function measured(unit, gate, ticket, value, source) {
  if (unit !== "s") {
    throw new BudgetRegistryError(
      `bound ${JSON.stringify(BUDGET_BOUND)} has unit ${JSON.stringify(unit)}; ` +
        "the browser E2E runner measures seconds",
    );
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new BudgetRegistryError(
      `bound ${JSON.stringify(BUDGET_BOUND)} must be a positive number of seconds, ` +
        `got ${JSON.stringify(value)}`,
    );
  }
  return {
    bound: BUDGET_BOUND,
    unit: "s",
    gate,
    ticket,
    status: "measured",
    budgetS: value,
    source,
    blocker: null,
  };
}

/**
 * Read `ci.browser_e2e_budget_s`.
 *
 * A measured bound must be a finite number of seconds. An absent `value` (and
 * no `budget_key`) is the registry's *open* shape: it is returned as a named
 * blocker, not thrown, so the PR job can still run and report that it made no
 * runtime claim.
 */
export function readBrowserE2eBudget(options = {}) {
  const registryPath = options.registryPath ?? REGISTRY_PATH;
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const data = readJson(registryPath);
  if (typeof data !== "object" || data === null) {
    throw new BudgetRegistryError(
      `the cascade threshold registry at ${registryPath} is not an object`,
    );
  }
  if (typeof data.bounds !== "object" || data.bounds === null) {
    throw new BudgetRegistryError(
      `the cascade threshold registry at ${registryPath} declares no bounds`,
    );
  }
  const entry = data.bounds[BUDGET_BOUND];
  if (entry === undefined) {
    throw new UnknownBoundError(BUDGET_BOUND, Object.keys(data.bounds));
  }

  const unit = text(entry.unit, "unit", BUDGET_BOUND);
  const gate = text(entry.gate, "gate", BUDGET_BOUND);
  const ticket = text(entry.ticket, "ticket", BUDGET_BOUND);

  if (entry.budget_key !== undefined) {
    if (entry.value !== undefined) {
      throw new BudgetRegistryError(
        `bound ${JSON.stringify(BUDGET_BOUND)} names budget_key ` +
          `${JSON.stringify(entry.budget_key)} and also carries a literal value; ` +
          "the frozen budget is read from the record, never copied",
      );
    }
    const key = text(entry.budget_key, "budget_key", BUDGET_BOUND);
    const record = readBudgetRecord(data.budget_record, repoRoot);
    if (!(key in record.budgets)) {
      throw new BudgetRegistryError(
        `bound ${JSON.stringify(BUDGET_BOUND)} names budget_key ${JSON.stringify(key)}, ` +
          `absent from the budget record ${record.label}`,
      );
    }
    return measured(unit, gate, ticket, record.budgets[key], `${record.label}#${key}`);
  }

  if (entry.value === undefined) {
    if (unit !== "s") {
      throw new BudgetRegistryError(
        `bound ${JSON.stringify(BUDGET_BOUND)} has unit ${JSON.stringify(unit)}; ` +
          "the browser E2E runner measures seconds",
      );
    }
    const blocker =
      `bound ${JSON.stringify(BUDGET_BOUND)} is unset: ticket ${ticket} must supply a ` +
      `value with a stated source and date (gate ${JSON.stringify(gate)}); ` +
      "no default is substituted";
    return {
      bound: BUDGET_BOUND,
      unit: "s",
      gate,
      ticket,
      status: "open",
      budgetS: null,
      source: "",
      blocker,
    };
  }

  const source = text(entry.source, "source", BUDGET_BOUND);
  return measured(unit, gate, ticket, entry.value, source);
}

/**
 * Compare a measured runtime with the recorded budget.
 *
 * `ok` says whether the run may be reported green. `claimed` says whether an
 * actual within-budget claim was made: an open bound never makes one.
 */
export function budgetVerdict(input) {
  const budget = input.budget;
  if (budget.status === "open") {
    return {
      ok: true,
      claimed: false,
      line:
        `budget ${budget.bound}: UNMEASURED — ${budget.blocker}. ` +
        `This run took ${(input.elapsedMs / 1000).toFixed(1)}s but makes no ` +
        "runtime claim until the bound is recorded.",
    };
  }
  const elapsedS = input.elapsedMs / 1000;
  const budgetS = budget.budgetS;
  const elapsed = `${elapsedS.toFixed(1)}s`;
  if (elapsedS <= budgetS) {
    return {
      ok: true,
      claimed: true,
      line: `budget ${budget.bound}: ${elapsed} within ${budgetS}s (${budget.source})`,
    };
  }
  return {
    ok: false,
    claimed: true,
    line:
      `budget ${budget.bound}: ${elapsed} over budget ${budgetS}s (${budget.source}); ` +
      "move the browser E2E to a required pre-merge job, never nightly-only",
  };
}

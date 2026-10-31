import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CONTRACT_BARS_PATH,
  CONTRACT_SCHEMA_VERSION,
  ContractRegistryError,
  EVIDENCE_SOURCES,
  FAMILIES,
  FAMILIES_DIR,
  buildContract,
  buildContractBarRecord,
  checkContractBars,
  contractDocument,
  loadContract,
  loadContractFamilies,
  loadThresholdTables,
  readContractBarRecord,
  repetitionsFor,
  requireProperty,
  type ContractFamily,
  type ContractProperty,
  type ContractBarRecord,
  type ResolvedThreshold,
  type ThresholdTables,
} from "./index";

/**
 * Ticket 06's acceptance is the spec's contract table: 82 ids in ten families,
 * each bar traceable to one frozen threshold record. These expectations are the
 * hand-pinned literals from `.scratch/demo-verification/spec.md`, never a
 * re-derivation from the table under test.
 */
const EXPECTED_FAMILY_COUNTS = {
  lifecycle: 11,
  "turn-taking": 10,
  conduct: 10,
  comprehension: 8,
  tools: 10,
  audio: 8,
  resilience: 8,
  security: 6,
  economics: 4,
  human: 7,
} as const;

const EXPECTED_IDS = [
  ...Array.from({ length: 11 }, (_, index) => `L${index + 1}`),
  ...Array.from({ length: 10 }, (_, index) => `T${index + 1}`),
  ...Array.from({ length: 10 }, (_, index) => `C${index + 1}`),
  ...Array.from({ length: 8 }, (_, index) => `K${index + 1}`),
  ...Array.from({ length: 10 }, (_, index) => `X${index + 1}`),
  ...Array.from({ length: 8 }, (_, index) => `A${index + 1}`),
  ...Array.from({ length: 8 }, (_, index) => `R${index + 1}`),
  ...Array.from({ length: 6 }, (_, index) => `S${index + 1}`),
  ...Array.from({ length: 4 }, (_, index) => `E${index + 1}`),
  ...Array.from({ length: 7 }, (_, index) => `H${index + 1}`),
];

/** Bars whose number the spec states in words; the record must carry exactly that. */
const SPEC_BARS: Record<string, Record<string, number>> = {
  T1: { dvFirstResponseP50Ms: 350, dvFirstResponseP95Ms: 700, dvFirstResponseMaxMs: 1200 },
  T2: { dvSubstantiveResponseP50Ms: 900, dvSubstantiveResponseP95Ms: 1800, dvSubstantiveResponseMaxMs: 2500 },
  T3: { dvBargeInStopP95Ms: 300, dvBargeInStopMaxMs: 500 },
  L9: { dvGoodbyePlayedRatioMin: 1, dvDropAfterLastSampleMaxMs: 300 },
  X2: { dvToolBridgeMaxMs: 700 },
  A1: { floorBreakupSeconds: 0.02 },
  E2: { dvCostPerCallMaxUsd: 0.15 },
  E3: {
    dvCostFastRunMaxUsd: 2,
    dvCostNightlyRunMaxUsd: 10,
    dvCostFullRunMaxUsd: 30,
  },
  H1: { dvStayOnCallYesMinRatio: 0.8, dvStayOnCallLocaleMinRatio: 0.7 },
  H2: {
    dvHumanDetectionMinRatio: 0.4,
    dvHumanDetectionMaxRatio: 0.6,
    dvHumanDetectionMinJudgments: 40,
  },
  H6: { dvJudgeKappaMin: 0.65 },
};

function property(overrides: Partial<ContractProperty> = {}): ContractProperty {
  return {
    id: "L1",
    statement: "a statement",
    bar: { text: "a bar", numeric: false },
    evidence: "ledger",
    kind: "deterministic",
    thresholds: [],
    ...overrides,
  };
}

function family(overrides: Partial<ContractFamily> = {}): ContractFamily {
  return { family: "lifecycle", title: "probe", properties: [property()], ...overrides };
}

function assertRefusal(
  run: () => unknown,
  code: string,
  pattern: RegExp,
): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ContractRegistryError, `expected ContractRegistryError, got ${String(error)}`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    assert.match(error.message, pattern);
    return true;
  });
}

test("the contract holds the spec's 82 properties in ten families", async () => {
  const contract = await loadContract();
  const counts = Object.fromEntries(contract.families.map((entry) => [entry.id, entry.propertyCount]));
  assert.deepEqual(counts, EXPECTED_FAMILY_COUNTS);
  assert.equal(contract.properties.length, 82);
  assert.deepEqual(
    contract.properties.map((entry) => entry.id),
    EXPECTED_IDS,
    "ids are present exactly once, in spec order",
  );
  assert.deepEqual(
    contract.families.map((entry) => entry.id),
    [...FAMILIES],
    "families are canonical, not file-system order",
  );
});

test("every property names a statement, a bar, one evidence source and its sample plan", async () => {
  const contract = await loadContract();
  const sources = new Set<string>(EVIDENCE_SOURCES);
  for (const entry of contract.properties) {
    assert.ok(entry.statement.trim().length > 0, `${entry.id} names its statement`);
    assert.ok(entry.bar.text.trim().length > 0, `${entry.id} names its bar`);
    assert.ok(sources.has(entry.evidence), `${entry.id} names a known evidence source`);
    assert.ok(["timing", "behaviour", "deterministic"].includes(entry.kind), `${entry.id} names its kind`);
    assert.equal(
      entry.repetitions,
      repetitionsFor(entry.kind),
      `${entry.id} derives repetitions from its kind, never a second number`,
    );
  }
  assert.equal(repetitionsFor("timing"), 3);
  assert.equal(repetitionsFor("behaviour"), 3);
  assert.equal(repetitionsFor("deterministic"), 1);
});

test("every numeric bar resolves to a frozen threshold and no property restates one", async () => {
  const contract = await loadContract();
  const numeric = contract.properties.filter((entry) => entry.bar.numeric);
  assert.ok(numeric.length > 0, "the contract has numeric bars");
  for (const entry of numeric) {
    assert.ok(entry.thresholds.length >= 1, `${entry.id} has a numeric bar with no threshold key`);
    for (const threshold of entry.thresholds) {
      assert.ok(["budget-record", "cascade-thresholds"].includes(threshold.source));
      assert.equal(typeof threshold.value, "number", `${entry.id}#${threshold.key} resolves to a number`);
      assert.ok(threshold.unit.length > 0, `${entry.id}#${threshold.key} resolves to a unit`);
    }
  }
  for (const entry of contract.properties.filter((item) => !item.bar.numeric)) {
    assert.equal(entry.thresholds.length, 0, `${entry.id} is categorical but names a threshold`);
  }
  // The property shape has no slot for a literal number: a second copy of a
  // bar cannot exist in a family file without failing this.
  const allowed = new Set([
    "id",
    "family",
    "statement",
    "bar",
    "evidence",
    "kind",
    "repetitions",
    "thresholds",
    "unresolved",
    "gaps",
  ]);
  for (const entry of contract.properties) {
    for (const key of Object.keys(entry)) {
      assert.ok(allowed.has(key), `${entry.id} carries unexpected field ${key}`);
    }
    assert.deepEqual(Object.keys(entry.bar).sort(), ["numeric", "text"]);
    assert.ok(!("value" in entry.bar), `${entry.id} bar is words plus a numeric flag, never a number`);
  }
});

test("a bar moves only when its frozen record moves", async () => {
  const tables = loadThresholdTables();
  const editedTables: ThresholdTables = {
    ...tables,
    values: {
      ...tables.values,
      "budget-record": {
        ...tables.values["budget-record"],
        dvFirstResponseP50Ms: { value: 999, unit: "ms" },
      },
    },
  };
  const edited = await loadContract({ tables: editedTables });
  const resolved = requireProperty(edited, "T1").thresholds.find(
    (threshold) => threshold.key === "dvFirstResponseP50Ms",
  );
  assert.equal(resolved?.value, 999, "the property has no local copy of the bar");
});

test("the spec's numbers come from the frozen records, not from this module", async () => {
  const contract = await loadContract();
  const byId = new Map(contract.properties.map((entry) => [entry.id, entry]));
  for (const [id, bars] of Object.entries(SPEC_BARS)) {
    const entry = byId.get(id);
    assert.ok(entry, `${id} exists`);
    for (const [key, value] of Object.entries(bars)) {
      const resolved: ResolvedThreshold | undefined = entry.thresholds.find(
        (threshold) => threshold.key === key,
      );
      assert.ok(resolved, `${id} names ${key}`);
      assert.equal(resolved.value, value, `${id}#${key} is the spec's bar`);
    }
  }
  // S3's tool cap is the cascade's own bound, so the registry hangs a key off
  // that record instead of growing a second copy.
  const s3 = byId.get("S3");
  assert.ok(s3);
  const loopCap = s3.thresholds.find((threshold) => threshold.source === "cascade-thresholds");
  assert.ok(loopCap, "S3 reads the cascade tool loop cap");
  assert.equal(loopCap.key, "tool.loop_cap");
  assert.equal(loopCap.value, 3);
});

test("the loader refuses a duplicate id by name", async () => {
  const tables = loadThresholdTables();
  assertRefusal(
    () =>
      buildContract(
        [
          family({ properties: [property({ id: "L1" })] }),
          family({ family: "turn-taking", properties: [property({ id: "L1", evidence: "trace" })] }),
        ],
        tables,
      ),
    "duplicate-property",
    /L1/,
  );
});

test("the loader refuses an unknown family by name", async () => {
  const tables = loadThresholdTables();
  assertRefusal(
    () => buildContract([family({ family: "marketing" as ContractFamily["family"] })], tables),
    "unknown-family",
    /marketing/,
  );
});

test("the loader refuses a missing bar by name", async () => {
  const tables = loadThresholdTables();
  assertRefusal(
    () => buildContract([family({ properties: [property({ bar: { text: "  ", numeric: false } })] })], tables),
    "missing-bar",
    /L1/,
  );
});

test("the loader refuses an unknown evidence source by name", async () => {
  const tables = loadThresholdTables();
  assertRefusal(
    () =>
      buildContract(
        [family({ properties: [property({ evidence: "video" as ContractProperty["evidence"] })] })],
        tables,
      ),
    "unknown-evidence",
    /video/,
  );
});

test("the loader refuses a numeric bar with no threshold key", async () => {
  const tables = loadThresholdTables();
  assertRefusal(
    () => buildContract([family({ properties: [property({ bar: { text: "<= 1 s", numeric: true } })] })], tables),
    "numeric-bar-without-threshold",
    /L1/,
  );
});

test("the loader refuses a threshold on a categorical bar by name", async () => {
  const tables = loadThresholdTables();
  assertRefusal(
    () =>
      buildContract(
        [
          family({
            properties: [
              property({
                bar: { text: "pass", numeric: false },
                thresholds: [{ source: "budget-record", key: "dvFirstResponseP50Ms" }],
              }),
            ],
          }),
        ],
        tables,
      ),
    "threshold-on-categorical-bar",
    /L1/,
  );
});

test("the loader refuses a threshold that the frozen records do not carry", async () => {
  const tables = loadThresholdTables();
  assertRefusal(
    () =>
      buildContract(
        [
          family({
            properties: [
              property({
                bar: { text: "<= 1 s", numeric: true },
                thresholds: [{ source: "budget-record", key: "inventedBarMs" }],
              }),
            ],
          }),
        ],
        tables,
      ),
    "unrecorded-threshold",
    /inventedBarMs/,
  );
});

test("the loader refuses an unknown threshold source by name", async () => {
  const tables = loadThresholdTables();
  assertRefusal(
    () =>
      buildContract(
        [
          family({
            properties: [
              property({
                bar: { text: "<= 1 s", numeric: true },
                thresholds: [{ source: "spreadsheet" as "budget-record", key: "dvFirstResponseP50Ms" }],
              }),
            ],
          }),
        ],
        tables,
      ),
    "unknown-threshold-source",
    /spreadsheet/,
  );
});

test("the table is discovered from family files, so a new family needs no central edit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "voni-contract-"));
  writeFileSync(
    join(dir, "probe.family.ts"),
    [
      "export default {",
      '  family: "lifecycle",',
      '  title: "probe",',
      "  properties: [",
      "    {",
      '      id: "L99",',
      '      statement: "a probe property",',
      '      bar: { text: "a categorical bar", numeric: false },',
      '      evidence: "ledger",',
      '      kind: "deterministic",',
      "      thresholds: [],",
      "    },",
      "  ],",
      "};",
      "",
    ].join("\n"),
  );
  const contract = await loadContract({ familiesDir: pathToFileURL(dir) });
  assert.deepEqual(
    contract.properties.map((entry) => entry.id),
    ["L99"],
    "the loader read the directory, not a checked-in index",
  );
});

test("the contract exports one machine-readable document", async () => {
  const contract = await loadContract();
  const document = contractDocument(contract);
  assert.equal(document.schemaVersion, CONTRACT_SCHEMA_VERSION);
  assert.equal(document.propertyCount, 82);
  assert.equal(document.families.length, 10);
  assert.deepEqual(JSON.parse(JSON.stringify(document)), document, "the document is JSON-safe");
  const h6 = document.properties.find((entry) => entry.id === "H6");
  assert.ok(h6, "H6 is present");
  assert.equal(h6.evidence, "judge", "H6 is wired to the judge/panel evidence");
  assert.equal(h6.unresolved, true, "H6 has no owning evaluator and fails closed");
  assert.match(h6.unresolvedReason ?? "", /ticket 27|unresolved|kappa/i);
  const k8 = document.properties.find((entry) => entry.id === "K8");
  assert.ok(k8);
  assert.ok((k8.gaps ?? []).some((gap) => /word error/i.test(gap)), "K8's unstated word-error bar is recorded");
  const t1 = document.properties.find((entry) => entry.id === "T1");
  assert.ok(t1);
  assert.equal(t1.repetitions, 3);
  assert.deepEqual(
    t1.thresholds.map((threshold) => [threshold.source, threshold.key, threshold.value]),
    [
      ["budget-record", "dvFirstResponseP50Ms", 350],
      ["budget-record", "dvFirstResponseP95Ms", 700],
      ["budget-record", "dvFirstResponseMaxMs", 1200],
    ],
  );
});

test("the committed bar record matches the live contract and its frozen sources", async () => {
  const contract = await loadContract();
  const tables = loadThresholdTables();
  const live = buildContractBarRecord(contract, tables);
  const committed = readContractBarRecord();
  assert.deepEqual(checkContractBars(live, committed), [], "no drift today");
  assert.deepEqual(committed, live, "the committed record is the live record");
  assert.equal(committed.version, 1);
  assert.match(committed.note, /threshold edit/i);
  assert.match(CONTRACT_BARS_PATH.pathname, /contract-bars\.json$/);
  for (const source of ["budget-record", "cascade-thresholds"] as const) {
    assert.match(committed.sources[source].sha256, /^[0-9a-f]{64}$/);
    assert.ok(committed.sources[source].path.length > 0);
  }
});

test("a hand-edited threshold fails the drift test, naming the property and key", async () => {
  const tables = loadThresholdTables();
  const committed = readContractBarRecord();
  const editedTables: ThresholdTables = {
    ...tables,
    values: {
      ...tables.values,
      "budget-record": {
        ...tables.values["budget-record"],
        dvFirstResponseP50Ms: { value: 400, unit: "ms" },
      },
    },
  };
  const editedContract = await loadContract({ tables: editedTables });
  const live = buildContractBarRecord(editedContract, editedTables);
  const drift = checkContractBars(live, committed);
  assert.ok(drift.length >= 1, "a hand edit is drift");
  const changed = drift.find((entry) => entry.key === "dvFirstResponseP50Ms");
  assert.ok(changed, `drift names the key: ${JSON.stringify(drift)}`);
  assert.equal(changed.reason, "value-changed");
  assert.equal(changed.live, 400);
  assert.equal(changed.record, 350);
  assert.equal(changed.propertyId, "T1");
});

test("a record edit not paired with a contract record move is drift", async () => {
  const contract = await loadContract();
  const tables = loadThresholdTables();
  const live = buildContractBarRecord(contract, tables);
  const edited: ContractBarRecord = {
    ...live,
    properties: {
      ...live.properties,
      T2: {
        ...live.properties.T2,
        thresholds: live.properties.T2.thresholds.map((threshold) =>
          threshold.key === "dvSubstantiveResponseP50Ms" ? { ...threshold, value: 1 } : threshold,
        ),
      },
    },
  };
  const drift = checkContractBars(live, edited);
  const changed = drift.find((entry) => entry.key === "dvSubstantiveResponseP50Ms");
  assert.ok(changed, JSON.stringify(drift));
  assert.equal(changed.reason, "value-changed");
  assert.equal(changed.propertyId, "T2");
});

test("a changed source record that the bar record did not move fails the drift test", async () => {
  const contract = await loadContract();
  const tables = loadThresholdTables();
  const live = buildContractBarRecord(contract, tables);
  const edited: ContractBarRecord = {
    ...live,
    sources: {
      ...live.sources,
      "cascade-thresholds": { ...live.sources["cascade-thresholds"], sha256: "0".repeat(64) },
    },
  };
  const drift = checkContractBars(edited, live);
  assert.ok(
    drift.some((entry) => entry.reason === "source-digest-changed" && entry.source === "cascade-thresholds"),
    JSON.stringify(drift),
  );
});

test("one file per family, named for the family it declares", async () => {
  // Guard the discovery claim: the family directory holds exactly the ten
  // modules, each declares the family its filename names, and no checked-in
  // list could disagree with them.
  const files = readdirSync(fileURLToPath(FAMILIES_DIR))
    .filter((name) => name.endsWith(".family.ts"))
    .sort();
  assert.deepEqual(
    files,
    [...FAMILIES].sort().map((family) => `${family}.family.ts`),
  );
  const families = await loadContractFamilies();
  assert.equal(families.length, 10);
  for (const declared of families) {
    assert.ok(files.includes(`${declared.family}.family.ts`), `file names its family`);
  }
});

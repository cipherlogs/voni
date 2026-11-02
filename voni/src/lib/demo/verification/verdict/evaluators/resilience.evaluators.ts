/**
 * R1–R8 evaluators: resilience from the call's own evidence.
 *
 * R1 counts a caller turn that never got a reply and a reply that was heard
 * twice, from the turn ledger the pipeline wrote while the scenario's jitter or
 * loss was applied at the microphone edge. R2–R7 read the browser edge's own
 * record — the rejoin, the hold and its clock, the denial, the device change,
 * the drain — plus the trace and marks that prove what the visitor saw. R8 is
 * the contamination gate: any `provider_fallback` row on the call fails it, and
 * the run gate reports the whole run `ineligible`.
 *
 * No evaluator invents a condition. A scenario that did not apply the edge
 * condition, or a call whose evidence does not carry it, is `unmeasured`, which
 * the verdict engine fails closed.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Resilience" R1–R8.
 */

import type {
  EvaluatorContext,
  EvaluatorModule,
  Evaluation,
  PropertyEvaluator,
} from "../types";

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowOf(value: unknown): Row | null {
  return isRow(value) ? value : null;
}

function rowsIn(value: unknown): Row[] {
  if (Array.isArray(value)) return value.filter(isRow);
  const record = rowOf(value);
  if (record === null) return [];
  if (Array.isArray(record.rows)) return record.rows.filter(isRow);
  return [];
}

function traceRows(context: EvaluatorContext): Row[] {
  return rowsIn(context.evidence.trace);
}

function ledger(context: EvaluatorContext): Row | null {
  return rowOf(context.evidence.ledger);
}

function browserEdge(context: EvaluatorContext): Row | null {
  const browser = rowOf(context.evidence.browser);
  return rowOf(browser?.edge);
}

/**
 * The client's own marks (`browser.marks`, the artifact the adapter copies
 * beside the delivered WAV). The artifact nests its entries under `marks`; a
 * fixture may hand the array directly.
 */
function browserMarkRows(context: EvaluatorContext): Row[] {
  const browser = rowOf(context.evidence.browser);
  const artifact = rowOf(browser?.marks);
  const entries = Array.isArray(browser?.marks) ? browser.marks : artifact?.marks;
  return Array.isArray(entries) ? entries.filter(isRow) : [];
}

function markTime(row: Row): number | null {
  return number(row.tMs) ?? number(row.epochMs);
}

function markDetail(row: Row): Row | null {
  return rowOf(row.detail);
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function turnRows(rows: readonly Row[], type: string): Row[] {
  return rows.filter((row) => row.type === type);
}

function turnId(row: Row): string {
  return text(row.turn);
}

function greetingStarts(rows: readonly Row[]): number {
  return rows.filter((row) => row.type === "greeting.start").length;
}

function categorical(context: EvaluatorContext, passed: boolean, detail: string, citations: string[] = []): Evaluation {
  return { kind: "measured", passed, detail, citations };
}

function unmeasured(reason: string): Evaluation {
  return { kind: "unmeasured", reason };
}

// ── R1: jitter and loss ─────────────────────────────────────────────────────

const JITTER_KEYS = ["dvJitterLostTurnMaxCount", "dvJitterDoubledAudioMaxCount"] as const;

const R1: PropertyEvaluator = {
  propertyId: "R1",
  bars: [
    { key: JITTER_KEYS[0], statistic: "max", comparison: "at-most" },
    { key: JITTER_KEYS[1], statistic: "max", comparison: "at-most" },
  ],
  evaluate(context) {
    const browser = rowOf(context.evidence.browser);
    const faults = Array.isArray(browser?.faultsApplied) ? browser.faultsApplied : [];
    if (faults.length === 0) {
      return unmeasured(
        "the scenario applied no media fault; R1 measures a jitter or loss call, never a clean one",
      );
    }
    const rows = traceRows(context);
    const expectedTurns = context.facts?.takes.length ?? null;
    const userFinals = turnRows(rows, "turn.user_final");
    const replyStarts = turnRows(rows, "turn.reply_start");
    // The ledger's logical turn id is `<epoch>:<providerTurnId>`; the caller
    // final and its reply are two rows under the same epoch, not one id. A
    // final with no reply in the same epoch is a lost reply, never a pass.
    const epochsWithFinal = new Set(userFinals.map((row) => turnId(row).split(":", 1)[0]));
    const epochsWithReply = new Set(replyStarts.map((row) => turnId(row).split(":", 1)[0]));
    const missingReply = [...epochsWithFinal].filter((epoch) => !epochsWithReply.has(epoch));
    const lostBeforeFinal =
      expectedTurns === null ? 0 : Math.max(0, expectedTurns - userFinals.length);
    const lostTurns = missingReply.length + lostBeforeFinal;

    const firstAudio = new Map<string, number>();
    for (const row of turnRows(rows, "turn.first_audio")) {
      const id = turnId(row);
      firstAudio.set(id, (firstAudio.get(id) ?? 0) + 1);
    }
    const doubledAudio = [...firstAudio.values()].reduce(
      (sum, count) => sum + Math.max(0, count - 1),
      0,
    );

    const citations = [
      ...missingReply.map((epoch) => `turn:${epoch}`),
      ...turnRows(rows, "turn.first_audio").map((row) => `turn:${turnId(row)}`),
    ];
    return {
      kind: "measured",
      samples: [lostTurns, doubledAudio],
      citations: [...new Set(citations)],
      detail:
        `${faults.map((fault) => String((fault as Row).kind)).join(", ")}: ` +
        `${lostTurns} lost turn(s), ${doubledAudio} doubled first-audio row(s)` +
        (expectedTurns === null ? " (no authored take count)" : ` of ${expectedTurns} expected`),
    };
  },
  source: "resilience.evaluators",
};

// ── R2: reconnect ───────────────────────────────────────────────────────────

const R2: PropertyEvaluator = {
  propertyId: "R2",
  bars: [],
  evaluate(context) {
    const rows = traceRows(context);
    const edge = browserEdge(context);
    const hold = rowOf(edge?.hold);
    const reconnectRows = turnRows(rows, "reconnect");
    const rejoined =
      hold !== null &&
      (Array.isArray(edge?.conditions)
        ? edge.conditions.some(
            (condition) =>
              isRow(condition) &&
              condition.applied === true &&
              (condition.kind === "page-freeze" || condition.kind === "page-hidden"),
          )
        : false);
    // A transport-level reconnect is the client's, not a pipeline leg's: it is
    // recorded as a `reconnect` mark. The claim only holds when a later
    // `admitted` mark proves the replacement socket reached the service.
    const markRows = browserMarkRows(context);
    const reconnectMarks = markRows.filter((mark) => mark.name === "reconnect");
    const failedMarks = markRows.filter((mark) => mark.name === "reconnect_failed");
    const admittedMarks = markRows.filter((mark) => mark.name === "admitted");
    const lastReconnect = reconnectMarks[reconnectMarks.length - 1] ?? null;
    const reconnectAt = lastReconnect === null ? null : markTime(lastReconnect);
    const reAdmitted =
      reconnectAt !== null &&
      admittedMarks.some((mark) => {
        const at = markTime(mark);
        return at !== null && at > reconnectAt;
      });
    const clientClaim = reconnectMarks.length > 0;
    if (reconnectRows.length === 0 && !rejoined && !clientClaim) {
      return unmeasured(
        "the call recorded no reconnect and applied no freeze/rejoin edge condition; " +
          "R2 cannot be claimed from a call that never reconnected",
      );
    }

    // One row per (type, turn) is the ledger's own contract: a second
    // `turn.reply_start` for the same turn is the duplicate a reconnect must
    // not create. Different row types legitimately share a turn.
    const ids = rows.map(turnId).filter((id) => id !== "");
    const keyed = rows
      .filter((row) => turnId(row) !== "")
      .map((row) => `${text(row.type)}:${turnId(row)}`);
    const duplicateIds = keyed.length - new Set(keyed).size;
    const epochs = ids
      .map((id) => Number(id.split(":", 1)[0]))
      .filter((value) => Number.isInteger(value));
    const outOfOrder = epochs.some((value, index) => index > 0 && value < epochs[index - 1]!);
    const greetings = greetingStarts(rows);
    const failedCause =
      failedMarks.length === 0
        ? ""
        : text(markDetail(failedMarks[failedMarks.length - 1]!)?.cause) || "unknown";
    const reconnected = reconnectRows.length > 0 || rejoined || reAdmitted;
    // The client's reconnect mark never relaxes the ledger's own checks: a
    // duplicate turn, a backwards epoch, a second greeting or a failed
    // reconnect still fails R2.
    const passed =
      duplicateIds === 0 && !outOfOrder && greetings <= 1 && failedCause === "" && reconnected;
    return categorical(
      context,
      passed,
      `reconnect rows ${reconnectRows.length}; turn ids ${ids.length} with ` +
        `${duplicateIds} duplicate(s); ${greetings} greeting start(s)` +
        `${outOfOrder ? "; turn epochs went backwards" : ""}` +
        (clientClaim
          ? `; client reconnect ${reAdmitted ? "re-admitted" : "not re-admitted"}`
          : "") +
        (failedCause === "" ? "" : `; reconnect failed: ${failedCause}`),
      [
        ...new Set(ids.map((id) => `turn:${id}`)),
        ...reconnectRows.map(() => "trace:reconnect"),
        ...(clientClaim ? ["browser:reconnect"] : []),
      ],
    );
  },
  source: "resilience.evaluators",
};

// ── R3: hold return ─────────────────────────────────────────────────────────

const R3: PropertyEvaluator = {
  propertyId: "R3",
  bars: [],
  evaluate(context) {
    const edge = browserEdge(context);
    const hold = rowOf(edge?.hold);
    if (hold === null) {
      return unmeasured("the call recorded no hold/return; R3 measures the return");
    }
    const rows = traceRows(context);
    const ledgerRow = ledger(context);
    const end = rowOf(ledgerRow?.end);
    const turns = number(end?.turns) ?? turnRows(rows, "turn.user_final").length;
    const greetings = greetingStarts(rows);
    const holding = hold.holdingObserved === true;
    const ringback = hold.ringbackObserved === true;
    const enter = number(hold.talkClockAtEnterS) ?? 0;
    const back = number(hold.talkClockAtReturnS);
    const memoryKept = turns > 0 && back !== null && back >= enter;
    const passed = holding && !ringback && greetings <= 1 && memoryKept;
    return categorical(
      context,
      passed,
      `holding ${holding}; ringback on return ${ringback}; greeting starts ${greetings}; ` +
        `turns kept ${turns}; talk clock ${enter}s → ${back ?? "unread"}s`,
      ["trace:greeting.start", "ledger:end"],
    );
  },
  source: "resilience.evaluators",
};

// ── R4: hidden page holds and the clock stops ───────────────────────────────

const R4: PropertyEvaluator = {
  propertyId: "R4",
  bars: [],
  evaluate(context) {
    const edge = browserEdge(context);
    const hold = rowOf(edge?.hold);
    if (hold === null) {
      return unmeasured("the call recorded no hidden/frozen page; R4 measures the hold");
    }
    const enter = number(hold.talkClockAtEnterS);
    const back = number(hold.talkClockAtReturnS);
    if (enter === null || back === null) {
      return unmeasured("the hold recorded no readable talk clock on both sides");
    }
    const held = hold.holdingObserved === true;
    const stopped = back - enter <= 1;
    return categorical(
      context,
      held && stopped,
      `holding ${held}; clock ${enter}s → ${back}s (${stopped ? "stopped" : "kept running"})`,
      ["browser:hold"],
    );
  },
  source: "resilience.evaluators",
};

// ── R5: microphone denial ───────────────────────────────────────────────────

const R5: PropertyEvaluator = {
  propertyId: "R5",
  bars: [],
  evaluate(context) {
    const edge = browserEdge(context);
    const denial = rowOf(edge?.micDenied);
    if (denial === null) {
      return unmeasured("the call recorded no microphone denial; R5 measures the refused mic");
    }
    const named =
      text(denial.namedState) !== "" ||
      /microphone|allow mic|mic access/i.test(text(denial.errorText));
    const openSockets = number(denial.openSockets) ?? 0;
    const teardown = denial.teardownObserved === true;
    const passed = named && (openSockets === 0 || teardown);
    return categorical(
      context,
      passed,
      `named ${named} (${text(denial.namedState) || "no status line"}); ` +
        `${openSockets} open socket(s); teardown ${teardown}`,
      ["browser:micDenied", "marks:start_failed"],
    );
  },
  source: "resilience.evaluators",
};

// ── R6: device switch ───────────────────────────────────────────────────────

const R6: PropertyEvaluator = {
  propertyId: "R6",
  bars: [],
  evaluate(context) {
    const edge = browserEdge(context);
    const device = rowOf(edge?.deviceSwitch);
    if (device === null) {
      return unmeasured("the call recorded no input device switch; R6 measures the change");
    }
    const reacquired = device.reacquired === true;
    const endedHonestly = device.endedHonestly === true;
    const state = text(device.state);
    return categorical(
      context,
      reacquired || endedHonestly,
      reacquired
        ? "a fresh microphone was acquired after the switch"
        : endedHonestly
          ? `the call ended honestly after the switch (state "${state}")`
          : `the call stayed live with no reacquisition (state "${state}")`,
      ["browser:deviceSwitch"],
    );
  },
  source: "resilience.evaluators",
};

// ── R7: deploy drain ────────────────────────────────────────────────────────

const R7: PropertyEvaluator = {
  propertyId: "R7",
  bars: [],
  evaluate(context) {
    const edge = browserEdge(context);
    const drain = rowOf(edge?.drain);
    if (drain === null) {
      return unmeasured(
        "the run recorded no deploy drain; R7 needs a draining service with a live call",
      );
    }
    const finished = drain.liveCallFinished === true;
    const attempted = drain.newCallAttempted === true;
    const refused = drain.newCallRefused === true;
    const code = text(drain.refusalCode);
    const named = text(drain.refusalText) !== "";
    if (!attempted) {
      return unmeasured(
        `the drain trial attempted no second call (${text(drain.refusalText) || "no reason"})`,
      );
    }
    return categorical(
      context,
      finished && refused && code === "draining" && named,
      `live call finished ${finished}; new call refused ${refused}` +
        `${code === "" ? "" : ` (${code})`}; named ${named}`,
      ["browser:drain"],
    );
  },
  source: "resilience.evaluators",
};

// ── R8: provider fallback contamination ─────────────────────────────────────

const R8: PropertyEvaluator = {
  propertyId: "R8",
  bars: [],
  evaluate(context) {
    const rows = traceRows(context);
    const fallbacks = rows.filter((row) => row.type === "provider_fallback");
    const ledgerRow = ledger(context);
    const end = rowOf(ledgerRow?.end);
    const eligibility = rowOf(end?.eligibility);
    const endSaysIneligible =
      eligibility?.eligible === false || strings(eligibility?.reasons).length > 0;
    if (fallbacks.length > 0 || endSaysIneligible) {
      return categorical(
        context,
        false,
        fallbacks.length > 0
          ? `${fallbacks.length} provider_fallback row(s) on the call; a fallback-contaminated ` +
            "run is ineligible, never a softer pass"
          : "the end message reports the call ineligible; the run cannot be certified",
        fallbacks.map(
          (row) =>
            `fallback:${text(row.leg) || "vendor"}@${text(row.phase) || "turn"}→${text(row.to) || "other"}`,
        ),
      );
    }
    return categorical(
      context,
      true,
      "no provider_fallback row and no ineligible end; R8 is clean only when nothing fell back",
      ["trace:provider_fallback", "ledger:end"],
    );
  },
  source: "resilience.evaluators",
};

const resilienceModule: EvaluatorModule = {
  family: "resilience",
  evaluators: [R1, R2, R3, R4, R5, R6, R7, R8],
};

export default resilienceModule;

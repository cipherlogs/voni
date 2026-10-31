/**
 * The evidence a turn-taking or conduct evaluator reads, without trusting it.
 *
 * The persisted ledger is the end document plus the turn rows the pipeline
 * wrote beside it; the browser's marks and captions are the visitor's own
 * record. Every field is `unknown` here: a malformed bundle is a named
 * refusal, and the evaluator turns that into `unmeasured` so the verdict
 * engine fails closed.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Ground truth comes first".
 */

import { TurnConductError } from "./errors";

export type LedgerMark = {
  readonly name: string;
  readonly tMs: number;
  readonly epochMs: number;
  readonly detail: Readonly<Record<string, unknown>> | null;
};

export type LedgerMarks = {
  readonly callId: string;
  readonly startedAt: string;
  readonly marks: readonly LedgerMark[];
};

export type TurnRow = {
  readonly type: string;
  readonly turn: string;
  readonly atMs: number;
  readonly [key: string]: unknown;
};

export type Ledger = {
  readonly file: string | null;
  readonly end: Readonly<Record<string, unknown>>;
  readonly turns: readonly TurnRow[];
  readonly marks: LedgerMarks | null;
};

export type BrowserEvidence = {
  readonly file: string | null;
  readonly captions: readonly { readonly role: "caller" | "agent"; readonly text: string }[];
  readonly syntheticMic: {
    readonly takesPlayed: readonly {
      readonly step: number;
      readonly take: string;
      readonly atMs: number;
      readonly durationMs: number;
      readonly epochMs: number | null;
    }[];
  } | null;
};

function recordOf(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TurnConductError(
      "malformed-evidence",
      `${what} must be an object, got ${Array.isArray(value) ? "array" : typeof value}`,
    );
  }
  return value as Record<string, unknown>;
}

function textOf(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TurnConductError("malformed-evidence", `${what} must be a non-empty string`);
  }
  return value;
}

function numberOf(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TurnConductError("malformed-evidence", `${what} must be a finite number`);
  }
  return value;
}

/** The persisted end message and turn rows. A missing end is a named refusal. */
export function readLedger(source: unknown): Ledger {
  const ledger = recordOf(source, "the ledger evidence");
  const end = recordOf(ledger.end, "the ledger's end document");
  if (end.type !== "end") {
    throw new TurnConductError(
      "malformed-evidence",
      `the ledger's end document has type ${JSON.stringify(end.type)}, not "end"`,
    );
  }
  const rows = ledger.turns;
  if (!Array.isArray(rows)) {
    throw new TurnConductError(
      "missing-evidence",
      "the ledger carries no turn rows; a call with no ledger has no turn evidence",
    );
  }
  const turns: TurnRow[] = rows.map((raw, index) => {
    const row = recordOf(raw, `the ledger's turn row ${index + 1}`);
    return {
      ...row,
      type: textOf(row.type, `the ledger's turn row ${index + 1}.type`),
      turn: textOf(row.turn, `the ledger's turn row ${index + 1}.turn`),
      atMs: numberOf(row.atMs, `the ledger's turn row ${index + 1}.atMs`),
    };
  });
  const marks = ledger.marks === undefined || ledger.marks === null ? null : readMarks(ledger.marks);
  return {
    file: typeof ledger.file === "string" ? ledger.file : null,
    end,
    turns,
    marks,
  };
}

/** The browser's marks artifact, read from the ledger bundle it travels in. */
export function readMarks(source: unknown): LedgerMarks {
  const marks = recordOf(source, "the browser marks");
  const startedAt = textOf(marks.startedAt, "the browser marks' startedAt");
  if (!Array.isArray(marks.marks)) {
    throw new TurnConductError("missing-evidence", "the browser marks carry no mark rows");
  }
  return {
    callId: typeof marks.callId === "string" ? marks.callId : "",
    startedAt,
    marks: marks.marks.map((raw, index) => {
      const mark = recordOf(raw, `the browser marks' row ${index + 1}`);
      return {
        name: textOf(mark.name, `the browser marks' row ${index + 1}.name`),
        tMs: numberOf(mark.tMs, `the browser marks' row ${index + 1}.tMs`),
        epochMs: numberOf(mark.epochMs, `the browser marks' row ${index + 1}.epochMs`),
        detail:
          mark.detail === undefined || mark.detail === null
            ? null
            : (recordOf(mark.detail, `the browser marks' row ${index + 1}.detail`) as Record<
                string,
                unknown
              >),
      };
    }),
  };
}

/** The last mark with this name; a repeated mark is a later fact. */
export function lastMark(marks: LedgerMarks | null, name: string): LedgerMark | null {
  if (marks === null) return null;
  for (let index = marks.marks.length - 1; index >= 0; index -= 1) {
    if (marks.marks[index]!.name === name) return marks.marks[index]!;
  }
  return null;
}

export function firstMark(marks: LedgerMarks | null, name: string): LedgerMark | null {
  if (marks === null) return null;
  return marks.marks.find((mark) => mark.name === name) ?? null;
}

export function rowsOfType(ledger: Ledger, type: string): TurnRow[] {
  return ledger.turns.filter((row) => row.type === type);
}

/** Rows grouped by their logical turn, in first-seen order. */
export function turnsById(ledger: Ledger): Map<string, TurnRow[]> {
  const byId = new Map<string, TurnRow[]>();
  for (const row of ledger.turns) {
    const list = byId.get(row.turn);
    if (list === undefined) byId.set(row.turn, [row]);
    else list.push(row);
  }
  return byId;
}

export function firstRowOf(rows: readonly TurnRow[], type: string): TurnRow | null {
  return rows.find((row) => row.type === type) ?? null;
}

/** The browser's own artifact: marks travel in the ledger, captions here. */
export function readBrowser(source: unknown): BrowserEvidence {
  const browser = recordOf(source, "the browser evidence");
  const captionsRaw = browser.captions;
  const captions: { role: "caller" | "agent"; text: string }[] = [];
  if (captionsRaw !== undefined && captionsRaw !== null) {
    if (!Array.isArray(captionsRaw)) {
      throw new TurnConductError(
        "malformed-evidence",
        "the browser evidence's captions must be a list",
      );
    }
    for (const [index, raw] of captionsRaw.entries()) {
      const caption = recordOf(raw, `the browser caption ${index + 1}`);
      const role = caption.role;
      if (role !== "caller" && role !== "agent") {
        throw new TurnConductError(
          "malformed-evidence",
          `the browser caption ${index + 1} has role ${JSON.stringify(role)}, not caller/agent`,
        );
      }
      captions.push({ role, text: textOf(caption.text, `the browser caption ${index + 1}.text`) });
    }
  }

  let syntheticMic: BrowserEvidence["syntheticMic"] = null;
  if (browser.syntheticMic !== undefined && browser.syntheticMic !== null) {
    const mic = recordOf(browser.syntheticMic, "the synthetic microphone report");
    if (Array.isArray(mic.takesPlayed)) {
      syntheticMic = {
        takesPlayed: mic.takesPlayed.map((raw, index) => {
          const play = recordOf(raw, `the synthetic microphone's take ${index + 1}`);
          return {
            step: numberOf(play.step, `the synthetic microphone's take ${index + 1}.step`),
            take: textOf(play.take, `the synthetic microphone's take ${index + 1}.take`),
            atMs: numberOf(play.atMs, `the synthetic microphone's take ${index + 1}.atMs`),
            durationMs: numberOf(
              play.durationMs,
              `the synthetic microphone's take ${index + 1}.durationMs`,
            ),
            epochMs:
              typeof play.epochMs === "number" && Number.isFinite(play.epochMs)
                ? play.epochMs
                : null,
          };
        }),
      };
    }
  }

  return {
    file: typeof browser.file === "string" ? browser.file : null,
    captions,
    syntheticMic,
  };
}

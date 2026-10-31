/**
 * Evidence shapes the security scans read and the findings they return.
 *
 * The shapes are the call evidence the adapters already assemble — trace rows,
 * tool rows, the persisted end message and the received WAV's facts — plus one
 * judge record for the injection test. A scanner never fabricates a value: a
 * missing reply, a missing call identity or a single-call bundle is a named
 * refusal that the evaluator turns into `unmeasured`, never a pass.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Security and abuse" S1-S6.
 */

export type SecurityRow = Record<string, unknown>;

/** One call's trace rows, as `ProtocolEvidenceBundle.trace` carries them. */
export type SecurityTraceEvidence = {
  readonly file?: string;
  readonly rows?: readonly SecurityRow[];
  readonly lineCount?: number;
  /** Caller values a scenario knows are private; a trace may never carry them. */
  readonly callerPii?: readonly string[];
  /** Live secret values, when a caller supplies them for an exact-match scan. */
  readonly secrets?: readonly string[];
  /** Two calls, when S6 is provable. The protocol adapter writes one. */
  readonly calls?: readonly CrossCallTrace[];
  readonly interleaved?: boolean;
};

export type CrossCallTrace = {
  readonly callId?: string;
  readonly subject?: string;
  readonly rows?: readonly SecurityRow[];
  readonly facts?: readonly string[];
};

/** The tool rows `ProtocolEvidenceBundle.tool` carries. */
export type SecurityToolEvidence = {
  readonly callId?: string;
  readonly subject?: string;
  readonly calls?: readonly SecurityRow[];
  readonly results?: readonly SecurityRow[];
};

/** The injection test's judge record: the caller line and the agent's reply. */
export type SecurityJudgeEvidence = {
  readonly callerLine?: string;
  readonly agentReply?: string;
  /** Phrases from the system prompt that must never appear in a reply. */
  readonly promptMarkers?: readonly string[];
  /** Secret values that must never appear in a reply or a log. */
  readonly secrets?: readonly string[];
};

export type SecurityFindingCode =
  | "prompt-leak"
  | "cross-subject-tool"
  | "cross-call-tool"
  | "tool-cap"
  | "pii-beyond-contract"
  | "credential-leak"
  | "cross-call-memory";

export type SecurityFinding = {
  readonly code: SecurityFindingCode;
  /** The dotted field path a defect card cites, e.g. `trace.rows[3].reason`. */
  readonly field: string;
  /** The same path, in the citation vocabulary the verdict carries. */
  readonly citation: string;
  /** The logical turn the offending row belongs to, when it names one. */
  readonly turn?: string;
  /** What matched, without echoing a secret. */
  readonly detail: string;
};

export type ScanResult = {
  readonly findings: readonly SecurityFinding[];
  /** How many values the scanner judged; zero means it proved nothing. */
  readonly inspected: number;
  readonly gaps: readonly string[];
};

export class SecurityScanError extends Error {
  readonly code:
    | "missing-reply"
    | "missing-prompt-markers"
    | "missing-call-identity"
    | "missing-trace"
    | "missing-tool-cap"
    | "single-call"
    | "not-interleaved";

  constructor(code: SecurityScanError["code"], message: string) {
    super(message);
    this.name = "SecurityScanError";
    this.code = code;
  }
}

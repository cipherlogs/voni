/**
 * Versioned voice proposals with independently observed confirmation.
 *
 * The load-bearing rule: a proposal ID never proves consent. Confirmation
 * counts only as an Apply tap or a finalized user turn that unambiguously
 * affirms the armed proposal — recorded by the UI layer, consumed once here.
 * The model asserting "the user said yes" authorizes nothing on its own.
 */

export type ProposalStatus =
  | "pending"
  | "armed"
  | "executing"
  | "applied"
  | "unknown"
  | "failed"
  | "dismissed"
  | "expired"
  | "conflicted";

export type ProposalTarget = { kind: string; id: string };

export type Proposal = {
  id: string;
  userId: string;
  organizationId: string;
  sessionId: string;
  route: string;
  /** Route registration generation: navigation bumps it and orphans old proposals. */
  registration: number;
  target: ProposalTarget;
  /** Value/version the proposer saw. Revalidated at apply; mismatch conflicts. */
  expected: { value: unknown; version: number | string };
  /** Immutable (deep-frozen) — what will execute, byte for byte. */
  payload: unknown;
  /** Which registered executor runs the payload on confirm. */
  executor: string;
  summary: string;
  /** Canonical phrases the spoken readback must contain before arming. */
  keyPhrases: string[];
  inverse: { summary: string; payload: unknown } | null;
  status: ProposalStatus;
  createdAt: number;
  expiresAt: number;
  readbackTurnId: string | null;
  armedAt: number | null;
  /** Event watermark: only assent from later user turns counts. */
  armedAfterEvent: number | null;
  assent: { kind: "tap" | "voice"; turnId: string | null; at: number } | null;
  assentConsumed: boolean;
  result: unknown | null;
  resultingVersion: number | string | null;
  lastError: string | null;
};

export type ProposalInput = Pick<
  Proposal,
  | "userId"
  | "organizationId"
  | "sessionId"
  | "route"
  | "registration"
  | "target"
  | "expected"
  | "payload"
  | "executor"
  | "summary"
  | "keyPhrases"
> & {
  inverse?: { summary: string; payload: unknown } | null;
  ttlMs?: number;
};

function deepFreeze(value: unknown): unknown {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .replace(/[''']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Every key phrase must appear in the finalized agent turn. Empty phrase
 * lists never match — a proposal without readback phrases cannot arm.
 */
export function readbackMatches(
  turnText: string,
  keyPhrases: string[],
): boolean {
  if (keyPhrases.length === 0) return false;
  const haystack = ` ${normalizeSpeech(turnText)} `;
  return keyPhrases.every((phrase) => {
    const needle = normalizeSpeech(phrase);
    return needle.length > 0 && haystack.includes(` ${needle} `);
  });
}

export type AssentVerdict = "affirm" | "deny" | "qualified" | "ambiguous";

const AFFIRMATIONS = [
  "yes",
  "yeah",
  "yep",
  "yes please",
  "apply",
  "do it",
  "go ahead",
  "confirmed",
  "confirm",
  "sounds good",
  "looks good",
  "perfect",
  "correct",
  "thats right",
  "ok",
  "okay",
  "sure",
  "please do",
];

const DENY_WORDS = [
  "no",
  "nope",
  "nah",
  "never",
  "cancel",
  "stop",
  "dont",
  "do not",
  "not yet",
  "wrong",
];

/**
 * Classify one finalized user turn. Deliberately strict: bare affirmations
 * only. "Yes, but…" is qualified (new instruction, proposal stays), quoted or
 * hedged text is ambiguous, and partial transcripts must never reach this —
 * the provider only submits finalized turns.
 */
export function classifyAssent(text: string): AssentVerdict {
  const t = normalizeSpeech(text);
  if (!t) return "ambiguous";
  const padded = ` ${t} `;
  if (/\s(but|however|except|although|though|unless)\s/.test(padded)) {
    return "qualified";
  }
  if (DENY_WORDS.some((word) => padded.includes(` ${word} `))) return "deny";
  if (AFFIRMATIONS.includes(t)) return "affirm";
  return "ambiguous";
}

export class ProposalStore {
  private proposals = new Map<string, Proposal>();
  private eventSeq = 0;
  private version = 0;
  private listeners = new Set<() => void>();

  constructor(private now: () => number = Date.now) {}

  /** React subscription (useSyncExternalStore): re-render on any mutation. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  getVersion(): number {
    return this.version;
  }

  private touch(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /** Monotonic event counter shared by user/agent turns for assent ordering. */
  noteEvent(): number {
    this.eventSeq += 1;
    return this.eventSeq;
  }

  create(input: ProposalInput): Proposal {
    if (input.keyPhrases.length === 0) {
      throw new Error("A proposal needs readback key phrases before it can arm.");
    }
    const at = this.now();
    const proposal: Proposal = {
      id: crypto.randomUUID(),
      userId: input.userId,
      organizationId: input.organizationId,
      sessionId: input.sessionId,
      route: input.route,
      registration: input.registration,
      target: input.target,
      expected: input.expected,
      payload: deepFreeze(structuredClone(input.payload)),
      executor: input.executor,
      summary: input.summary,
      keyPhrases: [...input.keyPhrases],
      inverse: input.inverse
        ? {
            summary: input.inverse.summary,
            payload: deepFreeze(structuredClone(input.inverse.payload)),
          }
        : null,
      status: "pending",
      createdAt: at,
      expiresAt: at + (input.ttlMs ?? 10 * 60 * 1000),
      readbackTurnId: null,
      armedAt: null,
      armedAfterEvent: null,
      assent: null,
      assentConsumed: false,
      result: null,
      resultingVersion: null,
      lastError: null,
    };
    this.proposals.set(proposal.id, proposal);
    this.touch();
    return proposal;
  }

  get(id: string): Proposal | null {
    return this.proposals.get(id) ?? null;
  }

  list(status?: ProposalStatus): Proposal[] {
    return [...this.proposals.values()].filter(
      (proposal) => !status || proposal.status === status,
    );
  }

  /** Drop everything past its expiry. Returns the expired ids. */
  purgeExpired(): string[] {
    const at = this.now();
    const expired: string[] = [];
    for (const proposal of this.proposals.values()) {
      if (
        (proposal.status === "pending" || proposal.status === "armed") &&
        proposal.expiresAt <= at
      ) {
        proposal.status = "expired";
        expired.push(proposal.id);
      }
    }
    if (expired.length > 0) this.touch();
    return expired;
  }

  /** Navigation, session end, or replacement: kill one scope's proposals. */
  expireWhere(
    predicate: (proposal: Proposal) => boolean,
  ): string[] {
    const expired: string[] = [];
    for (const proposal of this.proposals.values()) {
      if (
        (proposal.status === "pending" || proposal.status === "armed") &&
        predicate(proposal)
      ) {
        proposal.status = "expired";
        expired.push(proposal.id);
      }
    }
    if (expired.length > 0) this.touch();
    return expired;
  }

  /**
   * Match a finalized agent turn against pending proposals. Pure matching —
   * the caller arms after reply completion + playback drain (see arm()).
   */
  matchReadback(agentTurnId: string, text: string): string[] {
    const matched: string[] = [];
    for (const proposal of this.proposals.values()) {
      if (proposal.status !== "pending") continue;
      if (proposal.readbackTurnId) continue;
      if (readbackMatches(text, proposal.keyPhrases)) {
        proposal.readbackTurnId = agentTurnId;
        matched.push(proposal.id);
      }
    }
    if (matched.length > 0) this.touch();
    return matched;
  }

  /**
   * Arm a read-back proposal: from here an Apply tap or a later affirming
   * user turn counts as assent. Interrupted/failed readback never calls this,
   * which is what keeps Apply disabled on the card.
   */
  arm(id: string): { ok: true } | { ok: false; reason: string } {
    const proposal = this.proposals.get(id);
    if (!proposal) return { ok: false, reason: "Unknown proposal." };
    if (proposal.status !== "pending") {
      return { ok: false, reason: `Proposal is ${proposal.status}.` };
    }
    if (!proposal.readbackTurnId) {
      return { ok: false, reason: "Readback not observed yet." };
    }
    if (proposal.expiresAt <= this.now()) {
      proposal.status = "expired";
      return { ok: false, reason: "Proposal expired." };
    }
    proposal.status = "armed";
    proposal.armedAt = this.now();
    proposal.armedAfterEvent = this.eventSeq;
    this.touch();
    return { ok: true };
  }

  attachTapAssent(id: string): boolean {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.status !== "armed" || proposal.assent) {
      return false;
    }
    proposal.assent = { kind: "tap", turnId: null, at: this.now() };
    this.touch();
    return true;
  }

  attachVoiceAssent(id: string, turnId: string, eventSeq: number): boolean {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.status !== "armed" || proposal.assent) {
      return false;
    }
    if (
      proposal.armedAfterEvent === null ||
      eventSeq <= proposal.armedAfterEvent
    ) {
      // Pre-arming speech — including the turn that prompted the proposal.
      return false;
    }
    proposal.assent = { kind: "voice", turnId, at: this.now() };
    this.touch();
    return true;
  }

  /**
   * Atomic single-use claim before execution. Duplicates (double tool.call,
   * voice+tap race) return the same outcome instead of running twice.
   */
  claim(id: string): { ok: true } | { ok: false; reason: string } {
    const proposal = this.proposals.get(id);
    if (!proposal) return { ok: false, reason: "Unknown proposal." };
    if (proposal.status === "applied") {
      return { ok: false, reason: "Already applied." };
    }
    if (proposal.status !== "armed") {
      return { ok: false, reason: `Proposal is ${proposal.status}.` };
    }
    if (!proposal.assent || proposal.assentConsumed) {
      return { ok: false, reason: "No unspent confirmation for this proposal." };
    }
    proposal.assentConsumed = true;
    proposal.status = "executing";
    this.touch();
    return { ok: true };
  }

  markApplied(id: string, result: unknown, resultingVersion: number | string | null): void {
    const proposal = this.proposals.get(id);
    if (!proposal) return;
    proposal.status = "applied";
    proposal.result = result;
    proposal.resultingVersion = resultingVersion;
    proposal.lastError = null;
    this.touch();
  }

  markUnknown(id: string, error: string): void {
    const proposal = this.proposals.get(id);
    if (!proposal) return;
    // Sent but outcome unknown: do NOT roll back to armed (assent is spent)
    // and do NOT claim success. Reconciliation decides the next step.
    proposal.status = "unknown";
    proposal.lastError = error;
    this.touch();
  }

  /**
   * Definitive remote failure (validation, refused action): known outcome,
   * not unknown. Assent is spent; only a fresh proposal may try again.
   */
  markFailed(id: string, error: string): void {
    const proposal = this.proposals.get(id);
    if (!proposal) return;
    proposal.status = "failed";
    proposal.lastError = error;
    this.touch();
  }

  markDismissed(id: string): boolean {
    const proposal = this.proposals.get(id);
    if (
      !proposal ||
      (proposal.status !== "pending" && proposal.status !== "armed")
    ) {
      return false;
    }
    proposal.status = "dismissed";
    this.touch();
    return true;
  }

  markConflicted(id: string, error: string): void {
    const proposal = this.proposals.get(id);
    if (!proposal) return;
    proposal.status = "conflicted";
    proposal.lastError = error;
    this.touch();
  }
}

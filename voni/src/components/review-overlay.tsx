"use client";

import { useMemo, useState } from "react";
import {
  canSaveFixGate,
  createFixGate,
  type FixVerdict,
} from "@/lib/demo/fix-gate";
import {
  REVIEW_TAGS,
  createReviewRatings,
  type LatencySplitSummary,
  type ReviewTag,
  type ReviewVerdict,
} from "@/lib/demo/review-ratings";

/**
 * Ticket 07 review overlay: the owner hears each fix on the working build
 * through the same landing demo and rates it while replaying what was heard.
 *
 * Props-driven: the host passes the call's transcript rows (with the
 * per-turn audio replay URL, the per-turn split and the acknowledgement line
 * used). Rating controls write into the append-only store keyed by call id
 * and turn id; the artifact serializes beside marks + delivered capture.
 */

export type ReviewOverlayTurn = {
  turnId: string;
  speaker: "caller" | "agent";
  text: string;
  /** Per-turn audio replay; null when the turn has no capture yet. */
  audioUrl: string | null;
  split: LatencySplitSummary | null;
  /** The spoken acknowledgement used on this turn; null for silence/none. */
  fillerLine: string | null;
};

export function formatSplit(split: LatencySplitSummary | null): string {
  if (!split) return "no sample";
  return (
    `endpointing ${split.endpointingMs}ms · ` +
    `generation ${split.generationMs}ms · ` +
    `delivery ${split.deliveryMs}ms · ` +
    `perceived ${split.perceivedMs}ms`
  );
}

function TagPicker({
  value,
  onPick,
  label,
}: {
  value: ReviewTag | null;
  onPick: (tag: ReviewTag) => void;
  label: string;
}) {
  return (
    <label>
      {label}{" "}
      <select
        aria-label={label}
        value={value ?? ""}
        onChange={(event) => {
          const next = event.target.value;
          if (next !== "") onPick(next as ReviewTag);
        }}
      >
        <option value="">pick a tag</option>
        {REVIEW_TAGS.map((tag) => (
          <option key={tag} value={tag}>
            {tag}
          </option>
        ))}
      </select>
    </label>
  );
}

function VerdictButtons({
  value,
  onRate,
  label,
}: {
  value: ReviewVerdict | null;
  onRate: (verdict: ReviewVerdict) => void;
  label: string;
}) {
  return (
    <span role="group" aria-label={label}>
      {(["good", "bad"] as const).map((verdict) => (
        <button
          key={verdict}
          type="button"
          aria-pressed={value === verdict}
          onClick={() => onRate(verdict)}
        >
          {verdict}
        </button>
      ))}
    </span>
  );
}

/**
 * Ticket 08 per-fix gate: the owner marks the fix under review fixed or
 * not-fixed. A not-fixed mark requires the still-broken feeling to be named;
 * it stays open and blocks the next fix, while an unrated fix does not
 * advance. The retry reads the named feeling plus the reviewed call's
 * unaddressed bad records as its repro.
 */
export function FixGateSection({ fixId, callId }: { fixId: string; callId: string }) {
  const gate = useMemo(() => createFixGate(), []);
  const [verdict, setVerdict] = useState<FixVerdict | null>(null);
  const [stillBroken, setStillBroken] = useState("");
  const [saved, setSaved] = useState(false);
  const savedRecord = saved ? gate.getFix(fixId) : null;

  return (
    <div>
      <h3>Fix gate: {fixId}</h3>
      <p>One fixed-or-not-fixed mark per fix. Not-fixed names what is still broken and blocks the next fix.</p>
      <span role="group" aria-label={`Fix gate for ${fixId}`}>
        {(["fixed", "not-fixed"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={verdict === option}
            onClick={() => setVerdict(option)}
          >
            {option}
          </button>
        ))}
      </span>
      <label>
        Still broken (required when not-fixed){" "}
        <input
          aria-label={`Still broken for ${fixId}`}
          value={stillBroken}
          onChange={(event) => setStillBroken(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={!canSaveFixGate(verdict, stillBroken) || saved}
        onClick={() => {
          if (verdict === null || saved) return;
          gate.recordFix({ fixId, verdict, stillBroken, callId });
          setSaved(true);
        }}
      >
        Save fix mark
      </button>
      {savedRecord?.verdict === "not-fixed" ? (
        <p>Not-fixed stays open and blocks the next fix: {savedRecord.stillBroken}</p>
      ) : null}
      {savedRecord?.verdict === "fixed" ? <p>Fixed: the next fix may proceed.</p> : null}
    </div>
  );
}

export function ReviewOverlay({
  callId,
  turns,
  fixId,
}: {
  callId: string;
  turns: ReviewOverlayTurn[];
  /** The fix under review; when null the gate section stays hidden. */
  fixId?: string | null;
}) {
  const store = useMemo(() => createReviewRatings(), []);
  const [startVerdict, setStartVerdict] = useState<ReviewVerdict | null>(null);
  const [startNote, setStartNote] = useState("");
  const [startSaved, setStartSaved] = useState(false);
  const [drafts, setDrafts] = useState<
    Record<string, { verdict: ReviewVerdict | null; tag: ReviewTag | null; note: string; saved: boolean }>
  >({});

  const draftFor = (turnId: string) =>
    drafts[turnId] ?? { verdict: null, tag: null, note: "", saved: false };

  const setDraft = (
    turnId: string,
    patch: Partial<{ verdict: ReviewVerdict | null; tag: ReviewTag | null; note: string; saved: boolean }>,
  ) => setDrafts((prev) => ({ ...prev, [turnId]: { ...draftFor(turnId), ...patch } }));

  return (
    <section aria-label="Review overlay">
      <h2>Review: {callId}</h2>

      {fixId ? <FixGateSection fixId={fixId} callId={callId} /> : null}

      <div>
        <h3>Start rating</h3>
        <p>One rating per call covering the wait and the chime.</p>
        <VerdictButtons value={startVerdict} onRate={setStartVerdict} label="Start rating" />
        <label>
          Note (optional){" "}
          <input
            aria-label="Start note"
            value={startNote}
            onChange={(event) => setStartNote(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={startVerdict === null || startSaved}
          onClick={() => {
            if (startVerdict === null) return;
            store.recordStart({ callId, verdict: startVerdict, note: startNote });
            setStartSaved(true);
          }}
        >
          Save start rating
        </button>
      </div>

      <ol>
        {turns
          .filter((turn) => turn.speaker === "agent")
          .map((turn) => {
            const draft = draftFor(turn.turnId);
            const canSave = draft.verdict !== null && draft.tag !== null && !draft.saved;
            return (
              <li key={turn.turnId}>
                <p>{turn.text}</p>
                <p>Cover: {turn.fillerLine ?? "silence"}</p>
                <p>Split: {formatSplit(turn.split)}</p>
                {turn.audioUrl ? (
                  <audio controls src={turn.audioUrl} aria-label={`Replay ${turn.turnId}`} />
                ) : (
                  <p>No audio capture yet.</p>
                )}
                <VerdictButtons
                  value={draft.verdict}
                  onRate={(verdict) => setDraft(turn.turnId, { verdict })}
                  label={`Rating for ${turn.turnId}`}
                />
                <TagPicker
                  value={draft.tag}
                  onPick={(tag) => setDraft(turn.turnId, { tag })}
                  label="Filler tag"
                />
                <label>
                  Note (optional){" "}
                  <input
                    aria-label={`Note for ${turn.turnId}`}
                    value={draft.note}
                    onChange={(event) => setDraft(turn.turnId, { note: event.target.value })}
                  />
                </label>
                <button
                  type="button"
                  disabled={!canSave}
                  onClick={() => {
                    if (draft.verdict === null || draft.tag === null) return;
                    store.recordTurn({
                      callId,
                      turnId: turn.turnId,
                      verdict: draft.verdict,
                      tag: draft.tag,
                      note: draft.note,
                      fillerLine: turn.fillerLine,
                      split: turn.split,
                    });
                    setDraft(turn.turnId, { saved: true });
                  }}
                >
                  Save rating
                </button>
              </li>
            );
          })}
      </ol>
    </section>
  );
}

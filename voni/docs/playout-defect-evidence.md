# The playout defect, measured (ticket 07)

Evidence for the W1 claim that the playout reshapes the voice from how much audio is left
in the buffer, and inserts a fixed hole after a dry-out. Measured on
`feat/voice-parity` @ `be18e642` (ticket 07 branch), 2026-10-29, before ticket 25 changes
the worklet.

This is a **characterisation of today's defect**, not a quality gate. It stays in the tree
until ticket 28 turns the absence of both artefacts into gating assertions; it then fails,
which is the point. The checked-in test is
`voni/src/lib/voice/playout-defect.test.ts`.

## How it was measured

The real `voni/public/playout-processor.js` runs unmodified in a `vm` with
`AudioWorkletProcessor`, `sampleRate`, `currentTime` and `registerProcessor` stubbed — the
same seam as `voni/src/lib/voice/worklets.test.ts` (loader copied into the test file so the
two stay independent). No part of the worklet is reimplemented.

- Source: 24 kHz, 220 Hz sine at amplitude 0.5, delivered in **10 ms chunks**, rendered at
  48 kHz. The chunk rate is therefore **100 Hz** — the rate the owner hears as robotic or
  phased.
- One trace shape, three arrival patterns. The stream is always 2.2 s of the same audio and
  always accumulates the 500 ms pre-roll in real time (playback starts at 0.491 s). Only the
  second half's arrival is moved:

  | trace | second half arrives | what the buffer does |
  | --- | --- | --- |
  | healthy | on time | holds ~500 ms |
  | starving | **487 ms late** | never dries; cushion bottoms at **1.3 ms** |
  | dry-out | **510 ms late** | empties at 0.991 s; waits for a new pre-roll |

- Metrics: `measureEnvelopeModulation` (`voni/src/lib/audio/envelope-modulation.ts`, ticket
  05) on the rendered reply with its lead-in and tail trimmed; `detectBreakups`
  (`voni/src/lib/audio/breakups.ts`, ticket 06) on the whole rendered buffer.

Reproduce:

```
cd voni && node --import tsx --test src/lib/voice/playout-defect.test.ts
```

## The numbers

| trace | modulation rate | depth | depth (dB) | inserted silence | longest hole |
| --- | --- | --- | --- | --- | --- |
| healthy | **0 Hz** | 0 | 0 | none | — |
| starving | **100.000 Hz** | **0.212** (21%) | **3.75 dB** | none | — |
| dry-out | dominated by the hole (1 Hz) | — | — | 1 | **0.511 s**, at 0.991 s |

- **Chunk-rate modulation.** The starving trace reports **100.000 Hz at depth 0.212
  (3.75 dB)**. That is the chunk rate exactly: one gain cycle per arriving chunk, because
  `next()` sets `gain = min(queued / (EDGE_S * rate), 1, …)` and the queued count sawtooths
  once per 10 ms chunk. The healthy control renders the identical stream at the same chunk
  size and reads **0 Hz / depth 0** — so the modulation is the buffer's state, not the
  chunking itself. Depth 0.212 is a peak-to-trough swing of ±21% around the mean envelope:
  audibly pumped, not a subtle tilt.
- **The fixed hole.** The dry-out inserts **0.511 s of exact digital silence** starting at
  0.991 s (the reply otherwise continues to 2.69 s). The network stall is 510 ms, so a jitter
  buffer that resumes on arrival would have left ~20 ms of silence; instead the worklet
  resumes **0.491 s after the first post-stall chunk arrives**, i.e. it waits for a whole new
  `PREROLL_S = 0.5` cushion. The half second is the worklet's own, not the network's.

## Finding for the gate: the breakup analyser cannot see this hole

`detectBreakups` with its **default options reports 0 breakups** for the dry-out. The
worklet fades over `EDGE_S = 5 ms` before it goes idle; a 5 ms fade lands inside one 10 ms
frame and can leave that frame just above the `-60 dBFS` silence floor, so the analyser's
`-12 dB` abrupt-edge rule reads the cut as a natural decay. With
`silenceFloorDb: -30` (21 dB below the tone) it reports **1 breakup, 0.51 s**, which agrees
with the exact-zero run to 1 ms. The test asserts both readings and pins the hole length
against the zeros, so the floor is not fudging the number.

Ticket 28 cannot gate the hole through `detectBreakups`' default edge rule as it stands. It
needs either a floor/edge rule that resolves a deliberately faded cut, or a separate
inserted-silence check over the zero run. That is recorded here rather than silently
changing ticket 06's metric.

## Proof the characterisation can fail

A copy of the worklet with the buffer-occupancy envelope replaced by unity gain and the
pre-roll restart removed (`if (this.queued > 0) this.start()`) was run against the same
test file:

- starving trace: rate falls to **1 Hz**, not 100 Hz → the modulation assertion fails;
- dry-out trace: no 0.51 s hole (the reply resumes on the next chunk) → the hole assertion
  fails.

The healthy trace is a control, not a defect assertion: it must keep passing on a fixed
worklet, so it only asserts a held cushion is flat and the reply never breaks up.

## Artifacts

Everything above is synthetic and rendered in memory; there are no binary artifacts to
check in. A rendered buffer would go in a gitignored working directory (`voni/scoreboard-runs/`
or `.eval-clips/`) if one were kept.

## After ticket 27: the fixed hole is gone

Ticket 27 removes the last half of the defect: a dry-out no longer waits for a fresh
target cushion. The per-sample envelope was already gone (ticket 25); the hole is what
remained. Measured on `ticket/27-boundary-fades` with the same trace, the same 10 ms
chunks and the same 48 kHz render:

| trace | inserted silence | hole | resume wait after the first post-stall chunk |
| --- | --- | --- | --- |
| dry-out, before 27 | 1 | **0.511 s** at 0.991 s | **0.491 s** (a whole new cushion) |
| dry-out, after 27 | 1 | **0.015 s** at 0.996 s | **0.001 s** (the next audio resumes it) |

The residual 15 ms is the network's, not the worklet's: the stall is 510 ms against a
~500 ms cushion, so the buffer is empty for about one chunk before the next one arrives,
bounded by the 5 ms edge fade at each end. The replay is
`voni/src/lib/voice/playout-boundary.test.ts`, which prints the row:

```
cd voni && node --import tsx --test src/lib/voice/playout-boundary.test.ts
# dry-out: hole 0.015 s at 0.996 s, refill wait 0.001 s
```

**The resume policy.** A reply that has started and runs dry stays open: audio arriving
within `RESUME_WINDOW_S = 1` second of the dry-out continues it at once, on whatever
short cushion that audio provides, and the drift corrector (ticket 26) plays it slower to
refill. A gap longer than the window is a new turn, not a resume, so the next audio waits
for the target cushion like any reply start; the jitter budget is not spent on a gap that
is really a new reply. The boundary fades remain: a 5 ms ramp in at a reply start, a 5 ms
fade at the dry-out, and the main thread's fade on a deliberate `flush`.

**For ticket 28.** The 07 characterisation (`playout-defect.test.ts`) is still skipped.
The gate it replaces can assert, on the 510 ms dry-out trace: at most one interior
silence, shorter than 0.1 s, and a resume less than 50 ms after the first post-stall
chunk arrives (the fixed hole would fail both at ~0.5 s). `detectBreakups` at its default
-60 dBFS floor still does not see a deliberately faded cut (see above), so gate the zero
run or the resume latency rather than the default breakup edge rule. Keep the stall
inside cushion + 1 s or it is a new turn by design.

# Demo streak: triple green plus the candidate behavior suite

The Demo call is only claimable as "the best possible" after three consecutive
all-required-PASS artifacts on the gate voice with **no code change between
greens**, plus a green candidate behavior run on a built bundle.

## 1. Three greens (one at a time)

Timing runs go one at a time; the scoreboard takes an exclusive timing lock.

```sh
cd voni
npm run scoreboard:demo -- --scenario <scenario> [evidence flags]
# repeat with the same code until scoreboard-runs/ holds three gate-voice
# artifacts whose required gates are all PASS
```

Every artifact records `codeFingerprint` (git HEAD + a sha256 of
`git status --porcelain` and `git diff HEAD`). Editing any tracked or untracked
file changes that hash, so a streak cannot survive a code change. A run where
git cannot report HEAD records no fingerprint and cannot join a streak.

Manual review rows stay informational and never block: `accent-human`,
`phone-checklist`, `talk-hold-pinned`. `email-invite` may be INFO **only** for
unmeasured prospect-capture memory (ticket 27); any other INFO/FAIL on a
required gate fails the streak. `measurements` must be PASS or the non-dry
`INFO — measured evidence present`; a run with no measurements can never
green a streak.

## 2. Candidate behavior run (built bundle)

```sh
cd voni
npm run test:e2e:behavior -- --evidence /tmp/voni-behavior.json
```

`scripts/e2e-run.mjs behavior` copies a temp candidate, runs `npm ci`,
`next build`, starts the built app on port 3100, runs the behavior Playwright
specs, then tears everything down. It never touches a running dev server. The
`--evidence` file is written on green and red with the runner's exit code and
the same `codeFingerprint` shape as the artifacts. This environment has no
browser, so the command cannot be run here; a missing evidence file fails the
streak rather than being skipped.

## 3. The verdict

```sh
cd voni
npm run scoreboard:streak -- --dir scoreboard-runs \
  --behavior /tmp/voni-behavior.json
# exit 0 only when the claim holds; 1 names the differing run/gate
```

The command reads the last three gate-voice artifacts (oldest→newest) and
asserts the same voice, the current schema version, strictly increasing
`recordedAt`, one identical code fingerprint across all three, every required
gate PASS, and a green behavior run on that same code. It prints which run or
gate differs. Artifacts are working files and stay gitignored; never commit
them.

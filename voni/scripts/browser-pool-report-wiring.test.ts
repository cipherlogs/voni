/**
 * The one step that carries the runner's pool report to the app.
 *
 * The report is written by `browser-pool-gate.mjs` and read by
 * `src/app/api/email/pool/report/route.ts`; the workflow is the only thing
 * between them, and a missing or reordered step would leave the `/email` card
 * showing a report nobody can refresh. These assertions read the workflow as
 * text and fail by name when the step, its URL, its header or its position
 * drifts — none of that is observable from a unit test of either end.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(import.meta.url), "../../..");
const WORKFLOW = readFileSync(
  resolve(REPO, ".github/workflows/browser-check.yml"),
  "utf8",
);

const SEND = "Send the pool report";
const FINAL = "Final pool report";
const STOP = "Stop the exit pool";
const ARTIFACT = "Pool report";
const SCREENSHOTS = "Failure screenshots";

/** The lines of one named step, so a comment elsewhere cannot satisfy a check. */
function step(name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = WORKFLOW.indexOf(marker);
  assert.notEqual(start, -1, `browser-check.yml has no step named ${name}`);
  const rest = WORKFLOW.slice(start + marker.length);
  const ends = [
    rest.indexOf("\n      - name: "),
    rest.indexOf("\n      - uses: "),
  ].filter((index) => index !== -1);
  return ends.length === 0 ? rest : rest.slice(0, Math.min(...ends));
}

/** The shell script only: comments and `env:` lines are not the command. */
function runBlock(stepText: string): string {
  const marker = "\n        run: |\n";
  const start = stepText.indexOf(marker);
  assert.notEqual(start, -1, "the step runs a script");
  return stepText.slice(start + marker.length);
}

test("the report is sent after the final snapshot and before the client stops", () => {
  const order = [FINAL, SEND, STOP].map((name) =>
    WORKFLOW.indexOf(`      - name: ${name}\n`),
  );
  for (const index of order) assert.notEqual(index, -1);

  assert.ok(order[0]! < order[1]!, "the final counts are merged in before they are sent");
  assert.ok(
    order[1]! < order[2]!,
    "the client is stopped after the push, not before: the final read needs it alive",
  );
});

test("the send step is gated on the pool flag and fails the job when it fails", () => {
  const send = step(SEND);

  assert.match(
    send,
    /if: always\(\) && env\.TUXLER_ENABLED == 'true'/,
    "a failed gate's report is still pushed; a pool-off run pushes nothing",
  );
  assert.match(
    send,
    /continue-on-error: false/,
    "a report that never landed is a red run, not a silent gap",
  );
  assert.match(
    send,
    /curl -sS -o \/dev\/null -w "%\{http_code\}"/,
    "the status is captured, not the body",
  );
  assert.match(
    send,
    /--max-time 30 --retry 2 --retry-delay 2/,
    "the push can neither hang nor give up on one blip",
  );
  assert.match(send, /--data-binary @pool-report\.json/, "the artifact is sent as bytes");
  assert.match(send, /test "\$status" = "200"/, "a non-200 makes the step fail");
});

test("the final pool read keeps its promise never to fail the run", () => {
  const final = step(FINAL);

  assert.match(
    final,
    /continue-on-error: true/,
    "the comment says it never fails the run; the step must match",
  );
  assert.match(final, /--final/, "it reads the end-of-run counts once the clicks stop");
});

test("the URL is the app's pool-report intake, with the production fallback", () => {
  const send = step(SEND);

  assert.match(
    send,
    /VONI_APP_URL: \$\{\{ vars\.VONI_APP_URL \|\| 'https:\/\/voni\.cc' \}\}/,
    "an operator can point a staging run at staging; production is the fallback",
  );
  assert.match(
    runBlock(send),
    /"\$VONI_APP_URL\/api\/email\/pool\/report"/,
    "the path is the route this slice added",
  );
});

test("the OS and the secret are headers, and the secret comes only from secrets", () => {
  const send = step(SEND);
  const script = runBlock(send);

  assert.match(
    send,
    /POOL_REPORT_SECRET: \$\{\{ secrets\.EMAIL_CLICK_REPORT_SECRET \}\}/,
    "the intake checks the same secret the click reports use",
  );
  assert.match(
    send,
    /RUNNER_OS: \$\{\{ inputs\.os \}\}/,
    "the report file carries no OS, so the step names it",
  );
  assert.match(script, /-H "x-voni-click-secret: \$POOL_REPORT_SECRET"/);
  assert.match(script, /-H "x-voni-runner-os: \$RUNNER_OS"/);

  // The script never names the secret source itself: interpolation inside a
  // `run:` block is command text, and this step keeps it in `env:` only.
  assert.doesNotMatch(script, /secrets\./);
  assert.doesNotMatch(script, /x-voni-click-secret:\s*["']?[A-Za-z0-9._~+/=-]{8,}/);
  assert.doesNotMatch(send, /set -x|echo[^\n]*(?:\$POOL_REPORT_SECRET|secrets\.)/);
  assert.doesNotMatch(
    WORKFLOW,
    /EMAIL_CLICK_REPORT_SECRET:\s*["']?[A-Za-z0-9._~+/=-]{8,}/,
    "a literal secret in the workflow is a credential in git",
  );
});

test("the step adds no dispatch input and leaves both artifacts in place", () => {
  // The OS is a dispatch input already; a new input would change the
  // dispatcher's contract, which this slice must not touch.
  assert.doesNotMatch(WORKFLOW, /^ {6}(?:poolReportUrl|poolReportSecret):\s*$/m);

  const artifact = step(ARTIFACT);
  assert.match(artifact, /uses: actions\/upload-artifact@v4/);
  assert.match(artifact, /path: voni\/pool-report\.json/);

  const shots = step(SCREENSHOTS);
  assert.match(shots, /name: browser-check-screenshots-\$\{\{ inputs\.os \}\}/);
  assert.match(shots, /path: voni\/screenshots\//);
});

/**
 * Source guards for the read-only GitHub source card.
 *
 * The card deliberately has no runtime behaviour to test in this repo (it is a
 * server component with no mutations), so what a reviewer must be able to
 * trust is asserted where it is written:
 *
 *   1. honest states are words — a never-run OS and a disabled source cannot
 *      render a measured-looking `0/4`;
 *   2. the card imports no mutation and renders no form;
 *   3. volume comes from `clicksPerDay`, never a second day arithmetic;
 *   4. the worst-OS status follows the fixed order (disabled, never, stale,
 *      live);
 *   5. every read happens in `EmailControlData`, behind `connection()`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const here = new URL(".", import.meta.url);
const card = readFileSync(new URL("./github-source-card.tsx", here), "utf8");
const page = readFileSync(new URL("../app/email/page.tsx", here), "utf8");

/** Index just past a comment or string literal starting at `i`, else `i`. */
function skipNonCode(src: string, i: number): number {
  if (src[i] === "/" && src[i + 1] === "/") {
    const newline = src.indexOf("\n", i);
    return newline < 0 ? src.length : newline + 1;
  }
  if (src[i] === "/" && src[i + 1] === "*") {
    const end = src.indexOf("*/", i + 2);
    return end < 0 ? src.length : end + 2;
  }
  const quote = src[i];
  if (quote === '"' || quote === "'" || quote === "`") {
    let j = i + 1;
    while (j < src.length && src[j] !== quote) {
      j += src[j] === "\\" ? 2 : 1;
    }
    return j + 1;
  }
  return i;
}

/** The body of `function name(...) { ... }`, braces included. */
function functionBody(src: string, name: string): string {
  const declaration = new RegExp(`function\\s+${name}\\s*\\(`);
  const match = declaration.exec(src);
  assert.ok(match, `expected ${name}() in the source`);

  const paramsOpen = src.indexOf("(", match.index);
  let depth = 0;
  let paramsClose = -1;
  for (let i = paramsOpen; i < src.length; i += 1) {
    const skipped = skipNonCode(src, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    if (src[i] === "(") depth += 1;
    if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        paramsClose = i;
        break;
      }
    }
  }
  assert.ok(paramsClose > paramsOpen, `${name} has a parameter list`);

  const bodyOpen = src.indexOf("{", paramsClose);
  depth = 0;
  for (let i = bodyOpen; i < src.length; i += 1) {
    const skipped = skipNonCode(src, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    if (src[i] === "{") depth += 1;
    if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(bodyOpen, i + 1);
    }
  }
  assert.fail(`${name} has a closed body`);
}

test("honest states: a never-run OS and a disabled source are words, not zeroes", () => {
  assert.match(card, /"Never run"/, "a never-run OS says so");
  assert.match(card, /"Not scheduled"/, "a disabled source is not scheduled");
  assert.match(
    card,
    /status === "never"[\s\S]*?"Never run"/,
    "the never branch precedes any numeric coverage",
  );
  assert.match(
    card,
    /!enabled[\s\S]*?"Not scheduled"/,
    "the disabled branch precedes any numeric coverage",
  );
  assert.match(
    card,
    /This source is disabled\. Nothing clicks from GitHub/,
    "the disabled body explains the state in a sentence",
  );
  assert.match(
    card,
    /This source has no configuration row yet/,
    "a missing config row is said in words too",
  );
});

test("controls arrive as props and no server action is imported", () => {
  assert.match(card, /["']use client["']/, "the card is interactive now");
  assert.match(card, /setEnabled:/, "enable/disable arrives as a prop");
  assert.match(card, /saveSchedule:/, "the schedule action arrives as a prop");
  assert.match(card, /dispatchNow:/, "dispatch arrives as a prop too");
  assert.doesNotMatch(card, /from "@\/app\/email\/actions"/);
  assert.doesNotMatch(card, /["']use server["']/);
});

test("volume is the one formula from the schedule domain", () => {
  assert.match(
    card,
    /import\s*\{[^}]*clicksPerDay[^}]*\}\s*from "@\/lib\/email\/sources"/,
    "the card imports the shared clicksPerDay",
  );
  assert.match(card, /clicksPerDay\(/, "the card calls it");
  assert.doesNotMatch(
    card,
    /86_400|86400/,
    "no second seconds-per-day arithmetic in the card",
  );
  assert.doesNotMatch(card, /function clicksPerDay/);
  assert.doesNotMatch(card, /@\/lib\/email\/volume/);
});

test("worst-OS status follows disabled, never, stale, live", () => {
  const worst = functionBody(card, "worstHealth");

  const disabledAt = worst.indexOf("!enabled");
  const neverAt = worst.indexOf('includes("never")');
  const staleAt = worst.indexOf('includes("stale")');
  const liveAt = worst.indexOf('"Live"');

  assert.ok(disabledAt >= 0, "disabled is handled");
  assert.ok(neverAt > disabledAt, "never-run is checked after disabled");
  assert.ok(staleAt > neverAt, "stale is checked after never-run");
  assert.ok(liveAt > staleAt, "live is the fallback");

  assert.match(worst, /label: "Disabled"/);
  assert.match(worst, /label: "Never run"/);
  assert.match(worst, /label: "Stale"/);
  assert.match(worst, /label: "Live"/);
});

test("the GitHub card links only the stable workflow page", () => {
  assert.match(card, /href=\{workflowUrl\}/);
  assert.match(card, /Runs &amp; artifacts/);
  assert.doesNotMatch(
    card,
    /actions\/runs\//,
    "a dispatch has no run id, so no per-run URL is fabricated",
  );
  assert.doesNotMatch(card, /api\.github\.com/);
});

test("every read happens inside EmailControlData, behind the page boundary", () => {
  const data = functionBody(page, "EmailControlData");
  const gate = functionBody(page, "EmailPageGate");

  for (const read of [
    "readSourceConfig(",
    "newestClickByOs(",
    "runnerClicksSince(",
    "summariseRunnerClicks(",
  ]) {
    assert.ok(data.includes(read), `EmailControlData reads ${read}`);
    assert.ok(
      !gate.includes(read),
      `${read} must not run before the page gate`,
    );
  }

  assert.match(page, /await connection\(\);/, "the boundary is connection()");
  assert.match(
    page,
    /<AffiliateControlPanel[\s\S]*?<GithubSourceCard[\s\S]*?<BurstCard/,
    "the GitHub card sits between Grafana and Burst",
  );
  assert.match(page, /workflowUrl=\{BROWSER_CHECK_RUN_URL\}/);
});

test("each write control owns its pending state and its own changed text", () => {
  assert.match(
    card,
    /useActionState\(\s*saveSchedule,\s*INITIAL,?\s*\)/,
    "the schedule form tracks its own submission",
  );
  assert.match(
    card,
    /useActionState\(\s*setEnabled,\s*INITIAL,?\s*\)/,
    "enable/disable tracks a second, independent submission",
  );
  assert.match(card, /pending=\{savingSchedule\}/);
  assert.match(card, /pendingText="Saving…"/);
  assert.match(card, /pending=\{togglingSource\}/);
  assert.match(card, /pendingText=\{enabled \? "Disabling…" : "Enabling…"\}/);
  assert.match(
    card,
    /import \{ LoadingButton \} from "@\/components\/loading-button"/,
    "the house pending button, not a hand-rolled spinner",
  );

  // The two forms are separate: no shared boolean disables both controls.
  assert.doesNotMatch(card, /const \[pending/);
  assert.match(card, /<form action=\{saveScheduleAction\}/);
  assert.match(card, /<form\s+action=\{setEnabledAction\}/);
});

test("the preview is computed from the draft, before anything is saved", () => {
  assert.match(
    card,
    /clicksPerDay\(\s*draftInterval,\s*draftWindow,\s*targetCount,\s*RUNNER_OSES\.length,?\s*\)/,
    "the preview reads the form values, not the saved row",
  );
  assert.match(
    card,
    /data-testid="email-github-preview"[\s\S]*?formatCount\(previewPerDay\)/,
    "the number rendered is the draft's",
  );
  assert.match(
    card,
    /data-testid="email-github-preview"[\s\S]*?clicks\/day with this schedule/,
  );
  // The header stays the saved row's number.
  assert.match(card, /perDay === null \? "—" : formatCount\(perDay\)/);
});

test("success and failure surface an inline alert and a toast, for both controls", () => {
  assert.match(card, /function FeedbackAlert/);
  assert.equal(
    (card.match(/<FeedbackAlert state=\{/g) ?? []).length,
    2,
    "one alert under each control",
  );
  assert.match(card, /state\.error \? <AlertCircle \/> : <CheckCircle2 \/>/);
  assert.match(card, /variant=\{state\.error \? "destructive" : "default"\}/);
  assert.match(card, /type: "error"/);
  assert.match(card, /type: "success"/);
  assert.match(card, /useActionToast\(scheduleState\)/);
  assert.match(card, /useActionToast\(enabledState\)/);
});

test("locked disables every write and says why", () => {
  const disabled = (card.match(/disabled=\{locked/g) ?? []).length;
  assert.ok(disabled >= 5, "three selects, the save button and the toggle");
  assert.match(card, /data-testid="email-github-locked"/);
  assert.match(card, /Controls are locked/);
  assert.match(card, /Unlock the panel above to enable this source or change its/);
  assert.match(
    card,
    /disabled=\{locked \|\| savingSchedule\}/,
    "a save in flight does not disable the enable button",
  );
});

test("the form fields are the actions' contract", () => {
  for (const field of ["interval", "window", "startHour", "enabled"]) {
    assert.match(
      card,
      new RegExp(`name="${field}"`),
      `${field} is posted under the name the action reads`,
    );
  }
  assert.match(card, /name="enabled"[\s\S]*?value=\{enabled \? "false" : "true"\}/);
  assert.match(card, /INTERVAL_SECONDS\.map/);
  assert.match(card, /WINDOW_SECONDS\.map/);
});

test("the page passes the lock and both actions to the card", () => {
  assert.match(
    page,
    /<GithubSourceCard[\s\S]*?locked=\{locked\}[\s\S]*?setEnabled=\{setGithubSourceEnabled\}[\s\S]*?saveSchedule=\{saveGithubSchedule\}[\s\S]*?dispatchNow=\{dispatchGithubNow\}/,
    "the card gets the panel's lock state and all three server actions",
  );
  assert.match(
    page,
    /import \{[^}]*saveGithubSchedule[^}]*\} from "@\/app\/email\/actions"/,
  );
  assert.match(
    page,
    /import \{[^}]*dispatchGithubNow[^}]*\} from "@\/app\/email\/actions"/,
  );
});

test("every OS row carries its own Dispatch now, and each owns its pending state", () => {
  // One control per row: the dispatch form is rendered by the same map that
  // renders the per-OS rows, so a new OS cannot arrive without one.
  assert.match(
    card,
    /RUNNER_OSES\.map\(\(os\) => \{[\s\S]*?<DispatchControl\s+os=\{os\}/,
    "the runs-by-OS list renders one control per row",
  );
  assert.match(card, /name="os" value=\{os\}/, "the form posts the OS it belongs to");
  assert.match(card, /function DispatchControl/);

  const control = functionBody(card, "DispatchControl");
  assert.match(
    control,
    /useActionState\(\s*dispatchNow,\s*INITIAL_DISPATCH,?\s*\)/,
    "the pending flag lives in the row, not on the card",
  );
  assert.match(control, /pending=\{dispatching\}/);
  assert.match(control, /pendingText="Dispatching…"/);
  assert.match(control, /disabled=\{locked\}/, "locked is the only disable reason");
  assert.match(
    card,
    /import \{ LoadingButton \} from "@\/components\/loading-button"/,
  );

  // Nothing on the card shares that flag, so dispatching Ubuntu cannot disable
  // Windows or macOS — and the other two controls keep their own flags.
  assert.doesNotMatch(card, /const \[pending/);
  assert.doesNotMatch(card, /dispatching \|\|/);
  assert.doesNotMatch(card, /disabled=\{dispatching\}/);
  assert.equal((card.match(/useActionState\(/g) ?? []).length, 3);
});

test("a dispatched run links to the workflow, and an error is said in words", () => {
  const result = functionBody(card, "DispatchResult");
  assert.match(result, /if \(state\.error\)/);
  assert.match(result, /<AlertTitle>Browser check not dispatched<\/AlertTitle>/);
  assert.match(result, /<AlertDescription>\{state\.error\}<\/AlertDescription>/);
  assert.match(result, /if \(state\.runUrl\)/);
  assert.match(result, /href=\{state\.runUrl\}/);
  assert.match(result, /data-testid=\{`email-github-dispatch-\$\{os\}-run`\}/);
  assert.match(result, /View the run on GitHub/);
  assert.doesNotMatch(result, /api\.github\.com|authorization/);
});

test("a manual dispatch shows the exact command, copyable, like the burst fallback", () => {
  const result = functionBody(card, "DispatchResult");
  assert.match(
    result,
    /state\.mode === "manual" && state\.fallback/,
    "manual is a normal outcome, not an error",
  );
  const fallback = functionBody(card, "DispatchFallback");
  assert.match(fallback, /<pre[\s\S]*?<code>\{command\}<\/code>/, "the command is exact and selectable");
  assert.match(fallback, /navigator\.clipboard\.writeText\(command\)/);
  assert.match(fallback, /data-testid=\{`email-github-dispatch-\$\{os\}-copy`\}/);
  assert.match(fallback, /dispatch-\$\{os\}-fallback/);
  assert.match(fallback, /Run it yourself — no dispatch token configured\./);
  // The token's name is the only credential the copy mentions; neither the
  // token nor any dispatch result is echoed into the command block.
  assert.doesNotMatch(fallback, /Bearer|authorization/i);
});

test("a dispatch result surfaces an inline alert and a toast", () => {
  assert.match(card, /function useDispatchToast/);
  assert.match(card, /useDispatchToast\(state\)/);
  assert.match(card, /title: "Could not dispatch"/);
  assert.match(card, /type: "error"/);
  assert.match(card, /type: "success"/);
  assert.match(card, /title: state\.mode === "manual" \? "Run it yourself" : "Dispatched"/);
});

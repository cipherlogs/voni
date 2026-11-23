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
import { summariseRunnerClicks } from "@/lib/email/clicks";

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

test("honest states: a never-run pass and a disabled source are words, not zeroes", () => {
  assert.match(card, /"Never run"/, "a never-run pass says so");
  assert.match(card, /"Not scheduled"/, "a disabled source is not scheduled");
  assert.match(
    card,
    /!osStats\.pass[\s\S]*?"Never run"/,
    "the no-pass branch precedes any numeric coverage",
  );
  assert.match(
    card,
    /!enabled[\s\S]*?"Not scheduled"/,
    "the disabled branch precedes any numeric coverage",
  );
  assert.match(
    card,
    /osStats\.pass\.total === 0[\s\S]*?"No active targets"/,
    "an all-paused list is not a 0/0 pass",
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
  // Only the result types may cross the boundary, with `import type`: a value
  // import would let the card bypass the props the page passes.
  assert.match(
    card,
    /import type \{[^}]*ControlState[^}]*GithubDispatchState[^}]*\} from "@\/app\/email\/actions"/,
    "the action result types are imported, not restated",
  );
  assert.doesNotMatch(
    card,
    /import \{(?![^}]*\btype\b)[^}]*\} from "@\/app\/email\/actions"/,
    "no value is imported from the action module",
  );
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

test("worst-OS status follows disabled, outside, never, stale, live", () => {
  const worst = functionBody(card, "worstHealth");

  const disabledAt = worst.indexOf("!enabled");
  const outsideAt = worst.indexOf("outsideWindow");
  const neverAt = worst.indexOf('includes("never")');
  const staleAt = worst.indexOf('includes("stale")');
  const liveAt = worst.indexOf('"Live"');

  assert.ok(disabledAt >= 0, "disabled is handled");
  assert.ok(outsideAt > disabledAt, "outside hours is checked after disabled");
  assert.ok(neverAt > outsideAt, "never-run is checked after outside hours");
  assert.ok(staleAt > neverAt, "stale is checked after never-run");
  assert.ok(liveAt > staleAt, "live is the fallback");

  assert.match(worst, /label: "Disabled"/);
  assert.match(worst, /label: "Outside active hours"/);
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

test("success and failure surface the shared inline alert and toast, for both controls", () => {
  assert.match(
    card,
    /import \{[^}]*FeedbackAlert[^}]*useActionToast[^}]*\} from "@\/components\/action-feedback"/,
    "the feedback pieces live in one module",
  );
  assert.doesNotMatch(card, /function FeedbackAlert/, "not restated here");
  assert.equal(
    (card.match(/<FeedbackAlert/g) ?? []).length,
    2,
    "one alert under each control",
  );
  assert.match(card, /testId="email-github-feedback"/);
  assert.match(
    card,
    /useActionToast\(scheduleState, SOURCE_ERROR_TITLE\)/,
  );
  assert.match(
    card,
    /useActionToast\(enabledState, SOURCE_ERROR_TITLE\)/,
  );
});

test("targets x/x is the most recent pass, not a rolling window", () => {
  assert.match(
    card,
    /const PASS_BASIS = "most recent pass"/,
    "the basis is stated in words",
  );
  assert.match(card, /\(\{PASS_BASIS\}\)/, "and rendered beside the number");
  assert.match(
    card,
    /\$\{osStats\.pass\.hits\}\/\$\{osStats\.pass\.total\}/,
    "the numerator is the pass's hits, the denominator its active list",
  );
  assert.match(card, /const statsByOs = new Map\(/, "OS stats are keyed, not searched");
  assert.doesNotMatch(card, /byOs\.find\(/, "no linear lookup with a non-null assertion");

  const conclusion = functionBody(card, "passConclusionLabel");
  assert.match(conclusion, /"Complete"/);
  assert.match(conclusion, /"Partial"/);
  assert.match(conclusion, /"Failed"/);
  assert.match(conclusion, /"Never run"/);
  assert.match(
    conclusion,
    /complete[\s\S]*?partial[\s\S]*?Failed/,
    "the fixed conclusion order survives",
  );
});

test("a failed response is visible in words and never reads as unqualified Complete", () => {
  // A hit is any non-null status, so `targets x/x` can be full while every
  // response was a 500. The row therefore keeps the failed count in words.
  assert.match(
    card,
    /\$\{formatCount\(osStats\.failed\)\} of \$\{formatCount\(osStats\.clicks\)\} clicks failed/,
    "the failed count is spelled out in the row",
  );
  assert.match(
    card,
    /data-testid=\{`email-github-os-\$\{os\}-failures`\}/,
    "and rendered per OS, not only in aggregate",
  );
  assert.match(card, /clicks, none failed/, "a clean window still says so");

  // The word beside that count is the pass conclusion from the shared fold,
  // where Complete requires a delivered response on every shared target.
  assert.match(
    functionBody(card, "passConclusionLabel"),
    /pass\.conclusion === "complete"\) return "Complete"/,
    "the card's word is the fold's conclusion, never a second count",
  );

  const at = new Date("2026-11-23T08:00:00.000Z");
  const shared = ["https://a.example/one", "https://b.example/two"];
  const allError = summariseRunnerClicks(
    shared.map((target) => ({
      runnerOs: "ubuntu" as const,
      target,
      status: 500,
      passId: "pass-1",
      ranAt: at,
    })),
    shared,
  ).byOs.find((row) => row.os === "ubuntu");

  assert.equal(allError?.pass?.hits, 2, "x/x stays the response count");
  assert.equal(
    allError?.pass?.conclusion,
    "failed",
    "a pass of 500s is failed, never Complete",
  );

  const mixed = summariseRunnerClicks(
    [
      { runnerOs: "ubuntu", target: shared[0]!, status: 200, passId: "pass-2", ranAt: at },
      { runnerOs: "ubuntu", target: shared[1]!, status: 500, passId: "pass-2", ranAt: at },
    ],
    shared,
  ).byOs.find((row) => row.os === "ubuntu");
  assert.equal(
    mixed?.pass?.conclusion,
    "partial",
    "one delivered target among failures is partial",
  );
});

test("outside the active window the card says so instead of Stale", () => {
  assert.match(
    card,
    /import \{[^}]*insideWindow[^}]*\} from "@\/lib\/email\/sources"/,
    "the same window predicate the ticker uses",
  );
  assert.match(
    card,
    /const outsideWindow =[\s\S]*?enabled[\s\S]*?!insideWindow\(now, config\.windowSeconds, config\.windowStartHour\)/,
    "only an enabled source outside its own window",
  );
  const status = functionBody(card, "osStatus");
  assert.match(status, /if \(outsideWindow\) return "outside"/);
  assert.match(card, /if \(status === "outside"\) return "outline"/, "not destructive");
  assert.match(card, /"Outside active hours"/);
});

test("time selects show their labels closed, and the three windows are a radio group", () => {
  assert.match(card, /items=\{INTERVAL_ITEMS\}/, "the interval trigger shows 'Every 1 min'");
  assert.match(card, /items=\{START_HOUR_ITEMS\}/, "the start hour trigger shows '07:00 UTC'");
  assert.match(
    card,
    /const INTERVAL_ITEMS[\s\S]*?every|intervalOptionLabel/,
    "the label map is the same formatter the options render",
  );
  assert.match(
    card,
    /<RadioGroup[\s\S]*?WINDOW_SECONDS\.map[\s\S]*?<RadioGroupItem/,
    "three exclusive choices are a RadioGroup, not a Select",
  );
  assert.match(card, /name="window" value=\{draftWindow\}/, "the form still posts a window");
  assert.doesNotMatch(
    card,
    /<Select[\s\S]{0,200}WINDOW_SECONDS\.map/,
    "no window Select remains",
  );
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
  assert.match(fallback, /<ManualRunFallback/, "the shared copyable block");
  assert.match(fallback, /command=\{command\}/, "the command is exact");
  assert.match(fallback, /dispatch-\$\{os\}-copy/);
  assert.match(fallback, /dispatch-\$\{os\}-fallback/);
  assert.match(fallback, /GITHUB_BURST_TOKEN/);
  // The token's name is the only credential the copy mentions; neither the
  // token nor any dispatch result is echoed into the command block.
  assert.doesNotMatch(fallback, /Bearer|authorization/i);

  const shared = readFileSync(
    new URL("./action-feedback.tsx", here),
    "utf8",
  );
  const block = functionBody(shared, "ManualRunFallback");
  assert.match(block, /<pre[\s\S]*?<code>\{command\}<\/code>/);
  assert.match(block, /navigator\.clipboard\.writeText\(command\)/);
  assert.match(block, /Run it yourself — no dispatch token configured\./);
});

test("a dispatch result surfaces an inline alert and a toast", () => {
  assert.match(card, /function useDispatchToast/);
  assert.match(card, /useDispatchToast\(state\)/);
  assert.match(card, /title: "Could not dispatch"/);
  assert.match(card, /type: "error"/);
  assert.match(card, /type: "success"/);
  assert.match(card, /title: state\.mode === "manual" \? "Run it yourself" : "Dispatched"/);
});

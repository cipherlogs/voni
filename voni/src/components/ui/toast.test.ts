import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * The one surface /email's action results share, asserted where it is written:
 * the viewport is centred at the bottom on every breakpoint, and the outcome
 * toasts carry their artifact action and their urgency correctly.
 */

const viewport = readFileSync(new URL("./toast.tsx", import.meta.url), "utf8");
const feedback = readFileSync(
  new URL("../action-feedback.tsx", import.meta.url),
  "utf8",
);
const burstCard = readFileSync(
  new URL("../burst-card.tsx", import.meta.url),
  "utf8",
);
const githubCard = readFileSync(
  new URL("../github-source-card.tsx", import.meta.url),
  "utf8",
);
const noticeToast = readFileSync(
  new URL("../control-notice-toast.tsx", import.meta.url),
  "utf8",
);
const emailPage = readFileSync(
  new URL("../../app/email/page.tsx", import.meta.url),
  "utf8",
);

test("the toast viewport is bottom-centred on every breakpoint", () => {
  const start = viewport.indexOf("function ToastViewport");
  const block = viewport.slice(start, viewport.indexOf("function Toast(", start));

  assert.match(block, /fixed inset-x-4 bottom-4/);
  assert.match(block, /mx-auto/, "centred in the width it is given");
  assert.match(block, /max-w-sm/, "keeps the width constraint");
  assert.doesNotMatch(block, /sm:right-4|sm:left-auto|sm:mx-0/, "no right-aligned override");
});

test("an error toast is announced urgently, with the server's sentence", () => {
  assert.match(
    feedback,
    /if \(state\.error\) \{[\s\S]*?type: "error",[\s\S]*?priority: "high",/,
  );
  assert.match(
    feedback,
    /if \(state\.error\) \{[\s\S]*?description: state\.error,/,
    "the error text reaches the toast description",
  );
});

test("a success toast carries its text, timeout and artifact action", () => {
  assert.match(
    feedback,
    /toast\.add\(\{[\s\S]*?type: "success",[\s\S]*?timeout,[\s\S]*?actionProps: actionPropsFor\(action\),/,
  );
  assert.match(
    feedback,
    /toast\.add\(\{\s*title: successTitle,\s*description: description \?\? state\.message,/,
    "the success message reaches the toast description",
  );
  assert.match(
    feedback,
    /window\.open\(action\.href, "_blank", "noopener,noreferrer"\)/,
    "a run action opens the workflow in a new tab",
  );
  assert.match(
    feedback,
    /`\$\{action\.label\} \(opens in a new tab\)`/,
    "a link action says it leaves the page",
  );
  assert.match(
    feedback,
    /clipboard\.writeText\(command\)/,
    "a command action copies the exact line",
  );
});

test("a command toast keeps the long timeout and the copy action", () => {
  for (const [name, card] of [
    ["burst", burstCard],
    ["browser check", githubCard],
  ] as const) {
    assert.match(
      card,
      /\{ label: "Copy", onClick: \(\) => copyCommand\(command\) \}/,
      `${name}: the toast action copies the command`,
    );
    assert.match(
      card,
      /timeout: command \? 12_000 : undefined/,
      `${name}: long enough to read and copy`,
    );
    assert.doesNotMatch(
      card,
      /Bearer|authorization/i,
      `${name}: the token is never echoed`,
    );
  }
  assert.match(burstCard, /successTitle: command \? "Run it yourself"/);
  assert.match(
    githubCard,
    /successTitle: manual \? "Run it yourself" : "Dispatched"/,
    "the title follows the mode, not whether a command came back",
  );
  // The credential the manual line expects is named, never its value.
  assert.match(burstCard, /It needs <code className="font-mono">K6_CLOUD_TOKEN<\/code>/);
  assert.match(
    githubCard,
    /It needs <code className="font-mono">GITHUB_BURST_TOKEN<\/code> with\s*Actions write access/,
  );
});

test("a manual dispatch with no command is an error, never a dispatch", () => {
  assert.match(
    githubCard,
    /manual && !command[\s\S]*?error:\s*"No dispatch token is configured, and no command was returned\."/,
    "a missing command is worded as a failure",
  );
  assert.doesNotMatch(
    githubCard,
    /successTitle: command \?/,
    "a manual result never falls back to the dispatched title",
  );
});

test("an error toast is persistent, so the only copy of it cannot vanish", () => {
  for (const block of [
    /if \(state\.error\) \{[\s\S]*?type: "error",[\s\S]*?priority: "high",[\s\S]*?timeout: 0,/,
    /title: "Could not copy",[\s\S]*?type: "error",[\s\S]*?priority: "high",[\s\S]*?timeout: 0,/,
  ]) {
    assert.match(feedback, block, "every error toast sets timeout 0");
  }
});


test("a refused clipboard is a toast too, not an unhandled rejection", () => {
  assert.match(feedback, /try \{[\s\S]*?navigator\.clipboard;[\s\S]*?\} catch \{/);
  assert.match(feedback, /if \(!clipboard\) \{\s*failed\(\);/);
  assert.match(feedback, /description: "Select the command and copy it by hand\."/);
});

test("the control notice is a toast once, then the URL is cleaned", () => {
  assert.match(
    noticeToast,
    /toast\.add\(\{[\s\S]*?title,[\s\S]*?description,[\s\S]*?timeout: 6_000,/,
  );
  assert.match(noticeToast, /router\.replace\("\/email", \{ scroll: false \}\)/);
  assert.match(noticeToast, /announced\.current = true/);
  assert.match(noticeToast, /Controls locked\. This panel is read-only again\./);
  assert.match(emailPage, /<ControlNoticeToast notice=\{notice\} \/>/);
  assert.doesNotMatch(
    emailPage,
    /<Alert[\s>]/,
    "no inline result Alert survives on /email",
  );
});

test("the inline Alert and manual block are gone from the shared module", () => {
  assert.doesNotMatch(feedback, /export function FeedbackAlert|ManualRunFallback/);
  assert.doesNotMatch(feedback, /<Alert|<pre/);
});

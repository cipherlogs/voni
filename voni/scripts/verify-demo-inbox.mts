/**
 * Live check of the demo email test against the real inbox (layer 4 of the
 * ticket 03 follow-up): issues a real Test tag in the dev database, waits
 * while you send emails with it, and runs the same Gmail + Jev path the call
 * uses. Reads the inbox only; the tag row it writes expires in a day.
 *
 *   node --env-file=.dev.vars --env-file=.env.local --import tsx scripts/verify-demo-inbox.mts [--language en]
 *
 * 1. Send an email with the printed tag from a WORK address → expect "found".
 * 2. Then send one with the same tag from a gmail address → expect "free".
 */
import { checkResultFromData, DEMO_INBOX_ADDRESS, type CheckEmailResult } from "../src/lib/demo/email-test";
import { runCheckEmail } from "../src/lib/demo/inbox";
import { issueTestTag } from "../src/lib/demo/test-tag-registry";

const language = process.argv.includes("--language") ? process.argv[process.argv.indexOf("--language") + 1] : "en";
const tag = await issueTestTag(language);
// The same check_email path a call's poll takes (runCheckEmail), for a call holding this tag.
const call = { callId: `verify-${tag.id}`, startedAt: Date.now(), tagId: tag.id };
console.log(`Tag: "${tag.tag}". Email ${DEMO_INBOX_ADDRESS} with it in the subject.\n`);

async function waitFor(label: string, pass: (r: CheckEmailResult) => boolean): Promise<CheckEmailResult> {
  console.log(`… waiting for: ${label} (up to 5 min)`);
  const started = Date.now();
  let last: CheckEmailResult = { status: "not_arrived", address: null, name: null };
  while (Date.now() - started < 5 * 60_000) {
    const response = await runCheckEmail(call, {});
    if (!response.ok) throw new Error(`check_email failed: ${response.error}`);
    last = checkResultFromData(response.data);
    if (pass(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 8000));
  }
  throw new Error(`timed out; last result: ${JSON.stringify(last)}`);
}

const found = await waitFor("an email from a work address", (r) => r.status === "found");
if (found.status !== "found") throw new Error("unreachable");
console.log(`✓ found: ${found.address}, name ${found.name ?? "(none)"}, returning ${found.returning === true}`);

const free = await waitFor("a second email, from a gmail address", (r) => r.status === "free");
console.log(`✓ gate: ${JSON.stringify(free)}`);
console.log("\nAll live inbox checks passed.");
process.exit(0);

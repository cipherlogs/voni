/**
 * Live check of the demo test inbox — the real path X4/X5/X8 read.
 *
 * It only reads the shared inbox: its profile proves the refresh token works,
 * and `--tag <tag> --issued-at <iso>` re-finds one call's email by the same
 * query the app uses. It never sends mail and never accepts a customer address.
 *
 *   npm run demo:inbox:probe
 *   npm run demo:inbox:probe -- --tag "Lime 42" --issued-at 2026-10-31T10:00:00Z
 *
 * Exit 0 when the inbox answers (and, with a tag, the message is there), 2 on a
 * named refusal. A refusal is unrun evidence, never a green.
 */

import {
  findTaggedMessage,
  InboxError,
  probeInbox,
} from "../src/lib/demo/verification/tools/inbox";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new InboxError("inbox-malformed", `${name} needs a value`);
  }
  return value;
}

async function main(): Promise<void> {
  const env = process.env;
  const deps = { fetch };
  const probe = await probeInbox(env, deps);
  console.log(`✓ demo inbox reachable: ${probe.emailAddress} (${probe.messagesTotal} messages)`);

  const tag = argument("--tag");
  if (tag === null) return;
  const issued = argument("--issued-at");
  if (issued === null) {
    throw new InboxError("inbox-malformed", "--tag needs --issued-at <iso>");
  }
  const issuedAt = new Date(issued);
  if (Number.isNaN(issuedAt.getTime())) {
    throw new InboxError("inbox-malformed", `--issued-at "${issued}" is not an ISO date`);
  }
  const found = await findTaggedMessage({ tag, issuedAt, env, deps });
  if (!found.found) {
    throw new InboxError(
      "tag-not-delivered",
      `no message carrying tag "${tag}" is in the inbox since ${issuedAt.toISOString()}`,
    );
  }
  console.log(
    `✓ tag "${tag}" delivered: message ${found.messageId} in ${found.threadId} ` +
      `(${found.senderKind} sender)`,
  );
}

main().catch((error: unknown) => {
  if (error instanceof InboxError) {
    console.error(`✗ refused (${error.code}): ${error.message}`);
    process.exit(error.exitCode);
  }
  console.error(`✗ failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});

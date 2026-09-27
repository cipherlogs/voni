import { expect, test, type Page } from "@playwright/test";
import { DEMO_TEST_USE, TAG, fakeServer, mockApis, startCall, type Frame } from "./demo-fakes";

/**
 * The owner's laptop call (sess_aacaf0224d0441cdb…, 2026-09-27), replayed
 * against the real call component with a fake platform: the go-ahead, the
 * chip's tool call mid-reply, tab switches while sending, a personal
 * address, the email landing, the reply, the code read back, the reveal.
 * That call repeated lines, spoke two invites, and lost the reveal to a
 * note sent while `check_code` ran. Here every `reply.create` the page
 * sends is checked against the platform's state at that moment: never
 * while a reply plays, a tool call is open, or the caller is speaking.
 *
 *   PLAYWRIGHT_BASE_URL=https://localhost:3000 npx playwright test tests/e2e/demo-races.spec.ts
 */

test.use(DEMO_TEST_USE);

const AUDIO = Buffer.alloc(9600).toString("base64"); // 200ms

async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", { value: h ? "hidden" : "visible", configurable: true });
    Object.defineProperty(document, "hidden", { value: h, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

/** A fake platform: plays replies, answers our reply.create and tool results, and records violations. */
async function platform(page: Page) {
  let n = 0;
  let active: string | null = null;
  const openTools = new Set<string>();
  let callerSpeaking = false;
  const violations: string[] = [];
  const spoken: string[] = [];
  /** Lines the platform speaks after each tool's result, by call id. */
  const afterResult = new Map<string, string>();
  let say: (msg: Record<string, unknown>) => void = () => undefined;

  const reply = async (
    text: string,
    opts: { tool?: { name: string; args?: Record<string, unknown>; then?: string }; ms?: number; after?: number } = {},
  ) => {
    if (opts.after) await page.waitForTimeout(opts.after);
    const id = `p${(n += 1)}`;
    active = id;
    callerSpeaking = false;
    say({ type: "reply.started", reply_id: id });
    if (text) say({ type: "transcript.agent.delta", reply_id: id, text });
    if (text) say({ type: "reply.audio", reply_id: id, data: AUDIO });
    if (opts.tool) {
      const callId = `c${id}`;
      openTools.add(callId);
      if (opts.tool.then) afterResult.set(callId, opts.tool.then);
      say({ type: "tool.call", call_id: callId, name: opts.tool.name, arguments: opts.tool.args ?? {} });
    }
    await page.waitForTimeout(opts.ms ?? 400);
    if (text) {
      say({ type: "transcript.agent", reply_id: id, text });
      spoken.push(text);
    }
    say({ type: "reply.done", reply_id: id, status: "completed" });
    if (active === id) active = null;
  };

  const server = await fakeServer(page, (msg: Frame) => {
    if (msg.type === "reply.create") {
      const why = [active && "a reply is playing", openTools.size > 0 && "a tool call is open", callerSpeaking && "the caller is speaking"].filter(Boolean);
      if (why.length) violations.push(`${why.join(", ")}: ${String(msg.instructions).slice(0, 80)}`);
      void reply(`(line for: ${String(msg.instructions).slice(0, 40)})`);
    }
    if (msg.type === "tool.result") {
      const callId = String(msg.call_id);
      openTools.delete(callId);
      const then = afterResult.get(callId);
      if (then) setTimeout(() => void reply(then), 300);
    }
  });
  say = server.say;

  /** The caller talks for `speakMs`: speech start, sparse partials, speech stop, the final. */
  const caller = async (text: string, speakMs = 300) => {
    callerSpeaking = true;
    say({ type: "input.speech.started" });
    const words = text.split(" ");
    for (let t = 0, i = 1; t < speakMs; t += 4000, i += 3) {
      say({ type: "transcript.user.delta", item_id: `u${n}`, text: words.slice(0, i).join(" ") });
      await page.waitForTimeout(Math.min(4000, speakMs - t));
    }
    say({ type: "input.speech.stopped" });
    say({ type: "transcript.user", item_id: `u${n}`, text });
  };

  return { server, reply, caller, violations, spoken, idle: () => !active && openTools.size === 0 };
}

test("the laptop call, replayed: nothing we send lands on a reply, a tool or the caller; one invite; no repeats", async ({ page }) => {
  test.setTimeout(150_000);
  let inbox: "none" | "gmail" | "work" = "none";
  const api = await mockApis(page, {
    check: (args) => {
      if (typeof args.code === "string") return { ok: true, data: { status: "correct", triesLeft: 1, instructions: "Reveal it." } };
      if ("warm_line" in args) return { ok: true, data: { sent: true, instructions: "Say only: Just sent!" } };
      if (inbox === "gmail") return { ok: true, data: { status: "free", address: "nedal@gmail.com", instructions: "Gate." } };
      if (inbox === "work") {
        return { ok: true, data: { status: "found", address: "nedal@acme.com", name: "Nedal", exact: true, instructions: "Found." } };
      }
      return { ok: true, data: { status: "not_arrived", instructions: "Not yet." } };
    },
  });
  const p = await platform(page);
  await startCall(page, p.server);

  await p.reply("Hi, I'm Voni! Let's try something cool: I'll show you what I can do while we talk. Ready?");
  await p.caller("I am ready. First of all,");
  // Voni acknowledges and puts the chip up in the same turn; its result's
  // reply is the one invite.
  await p.reply("Great!", {
    tool: { name: "show_test_address", then: `Send me an email from your work address with ${TAG} in the subject.` },
  });
  await expect(page.getByTestId("demo-address-chip").filter({ visible: true })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1500);

  // Off to the mail app and back, several times, while sending.
  // (Short of the 15s silence check-in: a caller starting in the same
  // instant it goes out is a network race no client can close; the
  // platform's barge-in cuts it, and a check-in is never retried.)
  for (const ms of [6000, 700, 3000]) {
    await setHidden(page, true);
    await page.waitForTimeout(ms);
    await setHidden(page, false);
    await page.waitForTimeout(300);
  }
  // Off-track: the heuristic judge's nudge is ready while the platform is
  // still answering them; it must wait for that answer to finish.
  await p.caller("lol lol lol lol", 1500);
  await p.reply("Ha! So, is the email on its way?", { after: 400, ms: 3000 });
  // The personal address lands while Voni is mid-way through a long line
  // (longer than the 8s inbox poll): the gate note waits for it to end.
  inbox = "gmail";
  await p.reply("While you do that, I can tell you a little about how I handle a busy inbox for teams like yours.", { ms: 10_000 });
  await expect.poll(() => p.server.replyCreates().some((i) => /personal address/.test(i)), { timeout: 12_000 }).toBe(true);
  await page.waitForTimeout(1000);
  await p.caller("Is it a must?");
  await p.reply("It helps me find it faster.");
  inbox = "work";
  // The caller is talking when it lands: the note waits for them and the answer.
  await p.caller("Okay I'm sending it from my work address now, give me a second, it's taking a moment", 9000);
  await p.reply("Sure, take your time.", { after: 300, ms: 1500 });
  await expect.poll(() => p.server.replyCreates().some((i) => /just landed/.test(i)), { timeout: 12_000 }).toBe(true);
  await page.waitForTimeout(1500);
  // Voni's line for the landed email sends the reply (a tool mid-reply).
  await p.reply("Found it, Nedal. I'm sending you a quick reply… sending.", {
    tool: { name: "send_code_reply", args: { warm_line: "Hi!" }, then: "Just sent! Read me the code in it." },
  });
  await page.waitForTimeout(2500);
  await p.caller("8703.");
  // A silent tool-call reply: the result's reply is the reveal (the one that was lost).
  await p.reply("", { tool: { name: "check_code", args: { code: "8703" }, then: "That was actually an OTP, a security check." } });
  await expect.poll(() => p.spoken.some((l) => /OTP/.test(l)), { timeout: 10_000 }).toBe(true);
  await page.waitForTimeout(2000);

  expect(p.violations, "a line was sent into a busy floor").toEqual([]);
  const invites = p.spoken.filter((l) => /Send me an email/.test(l));
  expect(invites, "one invite").toHaveLength(1);
  expect(p.server.replyCreates().filter((i) => /welcome/i.test(i)), "no welcome-back").toEqual([]);
  expect(p.server.replyCreates().filter((i) => /invite/i.test(i)), "no invite note of ours").toEqual([]);
  const repeated = p.spoken.filter((l, i) => p.spoken.indexOf(l) !== i);
  expect(repeated, "no line said twice").toEqual([]);
  expect(api.toolCalls.some((c) => c.name === "check_code")).toBe(true);
});

test("15s of silence: one check-in, and never over a caller who starts talking", async ({ page }) => {
  test.setTimeout(90_000);
  await mockApis(page, { check: () => ({ ok: true, data: { status: "not_arrived", instructions: "Not yet." } }) });
  const p = await platform(page);
  await startCall(page, p.server);
  await p.reply("Hi, I'm Voni! Let's try something cool: I'll show you what I can do while we talk. Ready?");
  const checkIns = () => p.server.replyCreates().filter((i) => /Still with me/.test(i));
  await page.waitForTimeout(14_000);
  await p.caller("Hmm, let me think about it."); // just before 15s
  await page.waitForTimeout(3000);
  expect(checkIns(), "the caller spoke: the clock restarts").toHaveLength(0);
  await p.reply("Take your time.");
  await expect.poll(() => checkIns().length, { timeout: 20_000 }).toBe(1);
  await page.waitForTimeout(20_000);
  expect(checkIns(), "once per silent stretch").toHaveLength(1);
  expect(p.violations).toEqual([]);
});

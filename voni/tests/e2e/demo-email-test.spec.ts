import { expect, test, type Page, type Route, type WebSocketRoute } from "@playwright/test";

/**
 * Demo email test with the Test tag (ticket 03 + follow-up, ADR 0004), end
 * to end against the real call component: AssemblyAI is a fake socket that
 * issues the agent's tool calls with the timings of the owner's first real
 * call (sess_c477d8f8), and the call-scoped routes are mocked per test (the
 * Gmail + Jev half is unit-tested in src/lib/demo/*.test.ts and checked live
 * by scripts/verify-demo-inbox.mts).
 *
 *   PLAYWRIGHT_BASE_URL=https://localhost:3000 npx playwright test tests/e2e/demo-email-test.spec.ts
 */

test.use({
  permissions: ["microphone", "clipboard-read", "clipboard-write"],
  ignoreHTTPSErrors: true,
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  },
});

type Frame = Record<string, unknown> & { type: string };
const TAG = "Lime 42";

async function fakeServer(page: Page) {
  const frames: Frame[] = [];
  let ws: WebSocketRoute | null = null;
  await page.routeWebSocket(/agents\.assemblyai\.com/, (socket) => {
    ws = socket;
    socket.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as Frame;
      if (msg.type === "input.audio") return;
      frames.push(msg);
      if (msg.type === "session.update") {
        const session = msg.session as Record<string, unknown>;
        socket.send(JSON.stringify(session.agent_id ? { type: "session.ready", session_id: "sess_1" } : { type: "session.updated" }));
      }
    });
  });
  let reply = 0;
  const say = (msg: Record<string, unknown>) => ws?.send(JSON.stringify(msg));
  return {
    frames,
    say,
    ready: () => ws !== null && frames.some((f) => f.type === "session.update"),
    replyCreates: () => frames.filter((f) => f.type === "reply.create").map((f) => String(f.instructions)),
    toolResults: () =>
      frames.filter((f) => f.type === "tool.result").map((f) => ({ callId: String(f.call_id), result: JSON.parse(String(f.result)) })),
    /** One agent reply that calls a tool and speaks for `speakMs` (results go back at once, ADR 0005). */
    toolCall: async (name: string, args: Record<string, unknown> = {}, speakMs = 0) => {
      const id = `r${(reply += 1)}`;
      say({ type: "reply.started", reply_id: id });
      say({ type: "tool.call", call_id: `call_${id}`, name, arguments: args });
      say({ type: "transcript.agent", reply_id: id, text: "Let's try something real." });
      if (speakMs) await new Promise((resolve) => setTimeout(resolve, speakMs));
      say({ type: "reply.done", reply_id: id, status: "completed" });
      return `call_${id}`;
    },
  };
}

type Mocks = {
  /** Answer for a check_email request (the poll or the model's own call). */
  check: (args: Record<string, unknown>) => Record<string, unknown>;
  carried?: boolean;
};

async function mockApis(page: Page, mocks: Mocks) {
  const toolCalls: { name: string; args: Record<string, unknown>; toolCallId: string }[] = [];
  const tokenBodies: Record<string, unknown>[] = [];
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, json: { error: "offline in e2e" } }));
  await page.route("**/api/demo/token", (route) => {
    tokenBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({
      json: { token: "tok", agentId: "agent_demo", callToken: "call-tok", testTag: TAG, tagToken: "tag-tok", tagCarried: mocks.carried === true },
    });
  });
  await page.route("**/api/demo/tools/*", (route: Route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
    const body = route.request().postDataJSON() as { toolCallId: string; arguments: Record<string, unknown> };
    toolCalls.push({ name, args: body.arguments, toolCallId: body.toolCallId });
    if (name === "show_test_address") {
      return route.fulfill({
        json: { ok: true, data: { shown: true, address: "hi@pilotxstudio.com", testTag: TAG, instructions: `Say "${TAG}".` } },
      });
    }
    return route.fulfill({ json: mocks.check(body.arguments) });
  });
  return { toolCalls, tokenBodies, polls: () => toolCalls.filter((c) => c.toolCallId === "inbox-poll") };
}

const notArrived = { ok: true, data: { status: "not_arrived", instructions: "Not yet." } };
const found = (extra: Record<string, unknown> = {}) => ({
  ok: true,
  data: { status: "found", address: "andres@casaverde.pt", name: "Andres", exact: true, instructions: "Found it.", ...extra },
});
const free = { ok: true, data: { status: "free", address: "nidal@gmail.com", instructions: "Gate." } };

async function startCall(page: Page, server: Awaited<ReturnType<typeof fakeServer>>) {
  await page.goto("/");
  // A click that lands before hydration does nothing: click again, as a person would.
  const start = page.getByRole("button", { name: /^start call$/i }).filter({ visible: true }).first();
  await expect(async () => {
    if (!server.ready()) await start.click({ timeout: 1000 }).catch(() => undefined);
    await expect.poll(server.ready, { timeout: 3000 }).toBe(true);
  }).toPass({ timeout: 20_000 });
}

const chip = (page: Page) => page.getByTestId("demo-address-chip").filter({ visible: true });

test("a 10s invite reply still gets the address and tag to the model, and the chip shows both", async ({ page }, testInfo) => {
  const api = await mockApis(page, { check: () => notArrived });
  const server = await fakeServer(page);
  await startCall(page, server);
  await expect(chip(page)).toHaveCount(0);
  // Voni knows the call's tag from the start (a hidden context message).
  await expect
    .poll(() => server.frames.some((f) => f.type === "conversation.message" && /test tag is "Lime 42"/.test(String(f.content))))
    .toBe(true);

  // sess_c477d8f8: the invite reply ran ~10s after the tool call, and the
  // platform holds that reply open until the result arrives: the result must
  // go back mid-reply, not at reply.done (that deadlocked until the timeout).
  const replying = server.toolCall("show_test_address", {}, 10_000);
  await expect
    .poll(() => server.toolResults().find((r) => r.callId === "call_r1")?.result.data?.testTag, { timeout: 2000 })
    .toBe(TAG);
  await replying;
  await expect(chip(page)).toBeVisible();
  await expect(chip(page)).toContainText("hi@pilotxstudio.com");
  await expect(chip(page)).toContainText(TAG);

  await chip(page).getByRole("button", { name: /copy address/i }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("hi@pilotxstudio.com");
  await chip(page).getByRole("button", { name: /copy tag/i }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(TAG);
  await expect(page.getByRole("status").filter({ hasText: "Tag copied" })).toHaveCount(1);

  const mail = chip(page).getByRole("link", { name: /email hi@pilotxstudio\.com/i });
  if (testInfo.project.name === "mobile") {
    await expect(mail).toBeVisible();
    await expect(mail).toHaveAttribute("href", "mailto:hi@pilotxstudio.com?subject=Lime%2042");
  } else {
    await expect(mail).toBeHidden();
  }
  expect(api.tokenBodies[0]).not.toHaveProperty("tagToken");
  expect(await page.evaluate(() => localStorage.getItem("voni:test-tag"))).toBe("tag-tok");
});

test("after the invite the tag is polled with no address, found once, and polling stops", async ({ page }) => {
  test.setTimeout(90_000);
  let landed = false;
  const api = await mockApis(page, { check: () => (landed ? found() : notArrived) });
  const server = await fakeServer(page);
  await startCall(page, server);
  await page.waitForTimeout(9000);
  expect(api.polls(), "no polling before the invite").toHaveLength(0);

  await server.toolCall("show_test_address");
  await expect.poll(() => api.polls().length, { timeout: 12_000 }).toBeGreaterThan(0);
  expect(api.polls()[0].args, "the tag finds it: no address").toEqual({});

  landed = true;
  await expect.poll(() => server.replyCreates().filter((i) => /just landed/i.test(i)).length, { timeout: 15_000 }).toBe(1);
  expect(server.replyCreates().find((i) => /just landed/i.test(i))).toMatch(/Andres/);
  const polls = api.polls().length;
  await page.waitForTimeout(9000);
  expect(api.polls().length, "found: polling stops").toBe(polls);
});

test("a tagged email from a personal address gets the gate once and no extension", async ({ page }) => {
  test.setTimeout(60_000);
  const api = await mockApis(page, { check: () => free });
  const server = await fakeServer(page);
  await startCall(page, server);
  await server.toolCall("show_test_address");
  const gate = () => server.replyCreates().filter((i) => /nidal@gmail\.com, a personal address[\s\S]*Do you have a work email/.test(i));
  await expect.poll(() => gate().length, { timeout: 12_000 }).toBe(1);
  await page.waitForTimeout(9000);
  expect(gate(), "said once per sender").toHaveLength(1);
  expect(api.polls().length).toBeGreaterThan(1);
});

test("a callback carries its tag: the email sent after the last call is found at once, no invite", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("voni:test-tag", "tag-tok"));
  const api = await mockApis(page, { check: () => found(), carried: true });
  const server = await fakeServer(page);
  await startCall(page, server);
  expect(api.tokenBodies[0]).toMatchObject({ tagToken: "tag-tok" });
  await expect.poll(() => api.polls().length, { timeout: 3000, message: "checked at connect, not 8s later" }).toBeGreaterThan(0);
  await expect.poll(() => server.replyCreates().find((i) => /from an earlier call/i.test(i)), { timeout: 5000 }).toMatch(
    /Don't invite the email test again/,
  );
});

test("a returning sender (earlier tag, other device) is greeted as returning", async ({ page }) => {
  await mockApis(page, { check: () => found({ returning: true, instructions: "Found it, returning." }) });
  const server = await fakeServer(page);
  await startCall(page, server);
  await server.toolCall("show_test_address");
  await expect.poll(() => server.replyCreates().find((i) => /just landed/i.test(i)), { timeout: 15_000 }).toMatch(
    /good to hear from them again/,
  );
});

test.describe("talk clock", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install();
  });

  test("4 minutes without an email, then the time-up goodbye", async ({ page }) => {
    await mockApis(page, { check: () => notArrived });
    const server = await fakeServer(page);
    await startCall(page, server);
    await page.clock.fastForward("03:50");
    await page.clock.runFor(5000);
    expect(server.replyCreates().some((i) => /time is up/i.test(i))).toBe(false);
    // The talk clock starts at connect, a few (fake) seconds after load under load.
    await page.clock.runFor(25_000);
    await expect.poll(() => server.replyCreates().some((i) => /time is up/i.test(i))).toBe(true);
  });

  test("an arrived business email extends to 6 minutes", async ({ page }) => {
    let landed = false;
    await mockApis(page, { check: () => (landed ? found() : notArrived) });
    const server = await fakeServer(page);
    await startCall(page, server);
    await server.toolCall("show_test_address");
    await expect(chip(page)).toBeVisible();
    landed = true;
    await page.clock.runFor(10_000);
    await expect.poll(async () => {
      await page.clock.runFor(1000);
      return server.replyCreates().some((i) => /just landed/i.test(i));
    }).toBe(true);
    await page.clock.fastForward("03:40");
    await page.clock.runFor(15_000);
    expect(server.replyCreates().some((i) => /time is up/i.test(i)), "still live past 4:00").toBe(false);
    await page.clock.fastForward("01:45");
    await page.clock.runFor(30_000); // past 6:00 of talk, which starts at connect
    await expect.poll(() => server.replyCreates().some((i) => /time is up/i.test(i))).toBe(true);
  });

  test("invited but nothing landed: 'I'll reply the moment it lands', and the tag is kept", async ({ page }) => {
    await mockApis(page, { check: () => notArrived });
    const server = await fakeServer(page);
    await startCall(page, server);
    await server.toolCall("show_test_address");
    await expect(chip(page)).toBeVisible(); // the invite registered before the jump
    await page.clock.fastForward("03:55");
    await page.clock.runFor(25_000); // past 4:00 of talk, which starts at connect
    await expect.poll(() => server.replyCreates().some((i) => /reply the moment it lands/i.test(i))).toBe(true);
    expect(server.replyCreates().some((i) => /^Time is up on this demo\. Wrap up/i.test(i))).toBe(false);
    expect(await page.evaluate(() => localStorage.getItem("voni:test-tag"))).toBe("tag-tok");
  });
});

test.describe("the invite comes from the call, with the exact tag", () => {
  test("Voni says 'on your screen' but never calls the tool: the call puts the test up itself", async ({ page }) => {
    await mockApis(page, { check: () => notArrived });
    const server = await fakeServer(page);
    await startCall(page, server);
    server.say({ type: "reply.started", reply_id: "lead" });
    server.say({ type: "transcript.agent", reply_id: "lead", text: "I could pick those up for you. Let me put something on your screen." });
    server.say({ type: "reply.done", reply_id: "lead", status: "completed" });
    await expect(chip(page)).toBeVisible();
    await expect.poll(() => server.replyCreates().filter((i) => /Invite them now/.test(i)).length, { timeout: 4000 }).toBe(1);
    expect(server.replyCreates().find((i) => /Invite them now/.test(i))).toContain("with Lime 42 in the subject");
    await page.waitForTimeout(2000);
    expect(server.replyCreates().filter((i) => /Invite them now/.test(i)), "once").toHaveLength(1);
  });

  const AUDIO = Buffer.alloc(4800).toString("base64");

  test("after the chip, the platform's own reply is replaced by one invite carrying the tag", async ({ page }) => {
    await mockApis(page, { check: () => notArrived });
    const server = await fakeServer(page);
    await startCall(page, server);
    // The lead-in reply issues the tool call (result back at once).
    server.say({ type: "reply.started", reply_id: "lead" });
    server.say({ type: "reply.audio", reply_id: "lead", data: AUDIO });
    server.say({ type: "tool.call", call_id: "c1", name: "show_test_address", arguments: {} });
    await expect.poll(() => server.toolResults().length).toBe(1);
    await page.waitForTimeout(800);
    expect(server.replyCreates(), "never mid-reply").toHaveLength(0);
    server.say({ type: "reply.done", reply_id: "lead", status: "completed" });
    // The platform's own reply to the result starts: it is replaced at once.
    server.say({ type: "reply.started", reply_id: "auto" });
    await expect.poll(() => server.replyCreates().filter((i) => /Invite them now/.test(i)).length, { timeout: 2000 }).toBe(1);
    expect(server.replyCreates().find((i) => /Invite them now/.test(i))).toContain("with Lime 42 in the subject");
    // Its words never reach the transcript.
    server.say({ type: "transcript.agent", reply_id: "auto", text: "Send me an email with demo 102 in the subject." });
    server.say({ type: "reply.done", reply_id: "auto", status: "completed" });
    server.say({ type: "reply.started", reply_id: "invite" });
    server.say({ type: "transcript.agent", reply_id: "invite", text: "Send me an email with Lime 42 in the subject." });
    server.say({ type: "reply.done", reply_id: "invite", status: "completed" });
    await expect(page.getByText("with Lime 42 in the subject").filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByText("demo 102")).toHaveCount(0);
    await page.waitForTimeout(2000);
    expect(server.replyCreates().filter((i) => /Invite them now/.test(i)), "once").toHaveLength(1);
  });

  test("if the platform starts no reply after the chip, the invite is sent anyway", async ({ page }) => {
    await mockApis(page, { check: () => notArrived });
    const server = await fakeServer(page);
    await startCall(page, server);
    server.say({ type: "reply.started", reply_id: "lead" });
    server.say({ type: "tool.call", call_id: "c1", name: "show_test_address", arguments: {} });
    await expect.poll(() => server.toolResults().length).toBe(1);
    server.say({ type: "reply.done", reply_id: "lead", status: "completed" });
    await expect.poll(() => server.replyCreates().filter((i) => /Invite them now/.test(i)).length, { timeout: 4000 }).toBe(1);
  });
});

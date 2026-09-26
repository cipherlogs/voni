import { expect, test, type Page, type Route, type WebSocketRoute } from "@playwright/test";

/**
 * Demo email test (ticket 03), end to end against the real call component:
 * AssemblyAI is a fake socket that issues the agent's tool calls, and the
 * call-scoped tool route is mocked per test (the Gmail + Jev half is
 * unit-tested in src/lib/demo/email-test.test.ts and inbox.test.ts).
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
    ready: () => ws !== null && frames.some((f) => f.type === "session.update"),
    replyCreates: () => frames.filter((f) => f.type === "reply.create").map((f) => String(f.instructions)),
    toolResults: () => frames.filter((f) => f.type === "tool.result").map((f) => JSON.parse(String(f.result))),
    /** One agent reply that calls a tool; interactive results flush on reply.done. */
    toolCall: (name: string, args: Record<string, unknown> = {}) => {
      const id = `r${(reply += 1)}`;
      say({ type: "reply.started", reply_id: id });
      say({ type: "tool.call", call_id: `call_${id}`, name, arguments: args });
      say({ type: "transcript.agent", reply_id: id, text: "One moment." });
      say({ type: "reply.done", reply_id: id, status: "completed" });
    },
  };
}

type ToolHandler = (name: string, args: Record<string, unknown>, toolCallId: string) => Record<string, unknown>;

async function mockApis(page: Page, tool: ToolHandler) {
  const calls: { name: string; args: Record<string, unknown>; toolCallId: string }[] = [];
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, json: { error: "offline in e2e" } }));
  await page.route("**/api/demo/token", (route) =>
    route.fulfill({ json: { token: "tok", agentId: "agent_demo", callToken: "call-tok" } }),
  );
  await page.route("**/api/demo/tools/*", (route: Route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
    const body = route.request().postDataJSON() as { toolCallId: string; arguments: Record<string, unknown> };
    calls.push({ name, args: body.arguments, toolCallId: body.toolCallId });
    return route.fulfill({ json: tool(name, body.arguments, body.toolCallId) });
  });
  return calls;
}

const showAddress = { ok: true, data: { shown: true, address: "nedalk.js@gmail.com", instructions: "Say it once." } };
const notArrived = { ok: true, data: { status: "not_arrived", address: "andres@acme.com", name: "Andres", instructions: "Not yet." } };
const found = {
  ok: true,
  data: { status: "found", address: "andres@acme.com", from: "andres@acme.com", name: "Andres", exact: true, instructions: "Found it." },
};
const free = { ok: true, data: { status: "free", address: "andres@gmail.com", instructions: "Gate." } };

async function startCall(page: Page, server: Awaited<ReturnType<typeof fakeServer>>) {
  await page.goto("/");
  await page.getByRole("button", { name: /^start call$/i }).filter({ visible: true }).first().click();
  await expect.poll(server.ready).toBe(true);
}

const chip = (page: Page) => page.getByTestId("demo-address-chip").filter({ visible: true });

test("the invite shows the address chip; tapping copies it", async ({ page }, testInfo) => {
  await mockApis(page, (name) => (name === "show_test_address" ? showAddress : notArrived));
  const server = await fakeServer(page);
  await startCall(page, server);
  await expect(chip(page)).toHaveCount(0);

  server.toolCall("show_test_address");
  await expect(chip(page)).toBeVisible();
  await chip(page).getByRole("button", { name: /copy nedalk\.js@gmail\.com/i }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("nedalk.js@gmail.com");
  await expect(page.getByRole("status").filter({ hasText: "Address copied" })).toHaveCount(1);

  const mail = chip(page).getByRole("link", { name: /email nedalk\.js@gmail\.com/i });
  if (testInfo.project.name === "mobile") {
    await expect(mail).toBeVisible();
    await expect(mail).toHaveAttribute("href", "mailto:nedalk.js@gmail.com");
  } else {
    await expect(mail).toBeHidden();
  }
});

test("a business claim that has not landed is polled until found, then Voni is told once", async ({ page }) => {
  let landed = false;
  const calls = await mockApis(page, (name) => (name === "show_test_address" ? showAddress : landed ? found : notArrived));
  const server = await fakeServer(page);
  await startCall(page, server);
  server.toolCall("show_test_address");
  await expect(chip(page)).toBeVisible();

  server.toolCall("check_email", { address: "andres at acme dot com" });
  await expect.poll(() => server.toolResults().some((r) => r.data?.status === "not_arrived")).toBe(true);

  // The client re-checks the claimed address on its own.
  await expect.poll(() => calls.filter((c) => c.toolCallId === "inbox-poll").length, { timeout: 12_000 }).toBeGreaterThan(0);
  expect(calls.find((c) => c.toolCallId === "inbox-poll")?.args).toEqual({ address: "andres@acme.com" });

  landed = true;
  await expect
    .poll(() => server.replyCreates().filter((i) => /just landed/i.test(i)).length, { timeout: 15_000 })
    .toBe(1);
  expect(server.replyCreates().find((i) => /just landed/i.test(i))).toMatch(/Andres/);

  // Found: polling stops.
  const polls = calls.filter((c) => c.toolCallId === "inbox-poll").length;
  await page.waitForTimeout(9000);
  expect(calls.filter((c) => c.toolCallId === "inbox-poll").length).toBe(polls);
});

test("a free-email claim is gated and never polled", async ({ page }) => {
  const calls = await mockApis(page, (name) => (name === "show_test_address" ? showAddress : free));
  const server = await fakeServer(page);
  await startCall(page, server);
  server.toolCall("show_test_address");
  server.toolCall("check_email", { address: "andres@gmail.com" });
  await expect.poll(() => server.toolResults().some((r) => r.data?.status === "free")).toBe(true);
  await page.waitForTimeout(9000);
  expect(calls.filter((c) => c.toolCallId === "inbox-poll")).toHaveLength(0);
});

test.describe("talk clock", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install();
  });

  test("without a claim the base 2 minutes end the call", async ({ page }) => {
    await mockApis(page, () => showAddress);
    const server = await fakeServer(page);
    await startCall(page, server);
    await page.clock.fastForward("02:05");
    await expect.poll(() => server.replyCreates().some((i) => /time is up/i.test(i))).toBe(true);
  });

  test("a business claim extends to ~4 minutes; an email that never lands closes with the reply promise", async ({ page }) => {
    await mockApis(page, (name) => (name === "show_test_address" ? showAddress : notArrived));
    const server = await fakeServer(page);
    await startCall(page, server);
    server.toolCall("show_test_address");
    server.toolCall("check_email", { address: "andres@acme.com" });
    await expect.poll(() => server.toolResults().some((r) => r.data?.status === "not_arrived")).toBe(true);

    await page.clock.fastForward("02:05");
    await page.clock.runFor(2000);
    expect(server.replyCreates().some((i) => /time is up/i.test(i))).toBe(false);

    await page.clock.fastForward("02:00");
    await expect.poll(() => server.replyCreates().some((i) => /reply the moment it lands/i.test(i))).toBe(true);
  });
});

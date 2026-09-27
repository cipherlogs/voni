import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";

/**
 * Demo call hold, end to end against the real component in a real browser.
 * AssemblyAI is a fake socket (`routeWebSocket`), the token route is mocked,
 * the mic is Chrome's fake device. Page lifecycle is driven with the same
 * events a phone fires: `visibilitychange`, `freeze`, a dropped socket, a
 * reload. Runs on the desktop and Pixel 7 projects.
 *
 *   PLAYWRIGHT_BASE_URL=https://localhost:3000 npx playwright test tests/e2e/demo-hold.spec.ts
 */

test.use({
  permissions: ["microphone"],
  // `npm run dev:phone` serves https with a self-signed cert.
  ignoreHTTPSErrors: true,
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  },
});

type Frame = Record<string, unknown> & { type: string };
type Conn = { ws: WebSocketRoute; frames: Frame[] };

/** Fake AssemblyAI: one entry per socket the page opens. */
async function fakeServer(page: Page, opts: { refuseResume?: boolean } = {}) {
  const conns: Conn[] = [];
  let sessions = 0;
  await page.routeWebSocket(/agents\.assemblyai\.com/, (ws) => {
    const conn: Conn = { ws, frames: [] };
    conns.push(conn);
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as Frame;
      if (msg.type === "input.audio") return;
      conn.frames.push(msg);
      if (msg.type === "session.update") {
        const session = msg.session as Record<string, unknown>;
        if (session.agent_id) ws.send(JSON.stringify({ type: "session.ready", session_id: `sess_${(sessions += 1)}` }));
        else ws.send(JSON.stringify({ type: "session.updated" }));
      }
      if (msg.type === "session.resume") {
        if (opts.refuseResume) ws.send(JSON.stringify({ type: "session.error", code: "session_not_found", message: "gone" }));
        else ws.send(JSON.stringify({ type: "session.ready", session_id: msg.session_id }));
      }
    });
  });
  const all = () => conns.flatMap((c) => c.frames);
  return {
    conns,
    all,
    replyCreates: () => all().filter((f) => f.type === "reply.create"),
    contexts: () => all().filter((f) => f.type === "conversation.message").map((f) => String(f.content)),
    /** Server pushes to the newest socket. */
    say: (msg: Record<string, unknown>) => conns.at(-1)?.ws.send(JSON.stringify(msg)),
  };
}

async function mockApis(page: Page) {
  // Judges and tools answer "unavailable": the call falls back to heuristics.
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, json: { error: "offline in e2e" } }));
  await page.route("**/api/demo/token", (route) =>
    route.fulfill({ json: { token: "tok", agentId: "agent_demo", callToken: "call-tok" } }),
  );
}

/** Every token request body: a re-mint must carry the call's token (same call on the server). */
async function tokenBodies(page: Page) {
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/demo/token", (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: { token: "tok", agentId: "agent_demo", callToken: "call-tok" } });
  });
  return bodies;
}

const visible = (page: Page, name: RegExp) => page.getByRole("button", { name }).filter({ visible: true }).first();

/** Start a demo call and land one visitor turn + one agent turn (the call memory). */
async function startCall(page: Page, server: Awaited<ReturnType<typeof fakeServer>>) {
  await page.goto("/");
  // A click that lands before hydration does nothing: click again, as a person would.
  const started = () => server.conns.length >= 1 && server.all().some((f) => f.type === "session.update");
  await expect(async () => {
    if (!started()) await visible(page, /^(start call|continue call)$/i).click({ timeout: 1000 }).catch(() => undefined);
    await expect.poll(started, { timeout: 3000 }).toBe(true);
  }).toPass({ timeout: 20_000 });
  expect(server.conns).toHaveLength(1);
  server.say({ type: "transcript.user", item_id: "u1", text: "We sell solar panels in Lisbon." });
  server.say({ type: "reply.started", reply_id: "r1" });
  server.say({ type: "transcript.agent", reply_id: "r1", text: "Solar in Lisbon, great. How do leads reach you today?" });
  server.say({ type: "reply.done", reply_id: "r1", status: "completed" });
  await expect(page.getByText("We sell solar panels in Lisbon.").filter({ visible: true }).first()).toBeVisible();
}

async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", { value: h ? "hidden" : "visible", configurable: true });
    Object.defineProperty(document, "hidden", { value: h, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

const freeze = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event("freeze")));

/** Welcome-back lines sent, after the reply queue's grace. */
async function welcomes(page: Page, server: Awaited<ReturnType<typeof fakeServer>>) {
  await page.waitForTimeout(1600);
  return server.replyCreates().filter((f) => /welcome them back/i.test(String(f.instructions))).length;
}

test.beforeEach(async ({ page }) => {
  await mockApis(page);
});

test("a fast flap stays live: no hold, no line, no reconnect", async ({ page }) => {
  const server = await fakeServer(page);
  await startCall(page, server);
  await setHidden(page, true);
  await page.waitForTimeout(300);
  await setHidden(page, false);
  expect(await welcomes(page, server)).toBe(0);
  expect(server.replyCreates()).toHaveLength(0);
  expect(server.contexts().some((c) => /on hold/i.test(c))).toBe(false);
  expect(server.conns).toHaveLength(1);
});

test("a long hidden stretch without freeze stays live (Android Chrome)", async ({ page }) => {
  const server = await fakeServer(page);
  await startCall(page, server);
  await setHidden(page, true);
  await page.waitForTimeout(2500);
  await expect(page.getByText(/On hold/).filter({ visible: true })).toHaveCount(0);
  await setHidden(page, false);
  expect(await welcomes(page, server)).toBe(0);
  expect(server.conns).toHaveLength(1);
});

test("a flap of 5s or more gets one welcome-back line on return, still live", async ({ page }) => {
  const server = await fakeServer(page);
  await startCall(page, server);
  await setHidden(page, true);
  await page.waitForTimeout(5200);
  await setHidden(page, false);
  await page.waitForTimeout(1600);
  const lines = server.replyCreates().filter((f) => /"Welcome back!"/.test(String(f.instructions)));
  expect(lines).toHaveLength(1);
  expect(server.contexts().some((c) => /on hold/i.test(c)), "a flap, not a hold").toBe(false);
  expect(server.conns).toHaveLength(1);
});

test("freeze holds silently; the return un-holds and welcomes back once", async ({ page }) => {
  const server = await fakeServer(page);
  await startCall(page, server);
  await setHidden(page, true);
  await freeze(page);
  await expect(page.getByText(/On hold/).filter({ visible: true }).first()).toBeVisible();
  expect(server.contexts().some((c) => /on hold/i.test(c))).toBe(true);
  expect(server.replyCreates()).toHaveLength(0);
  await setHidden(page, false);
  expect(await welcomes(page, server)).toBe(1);
  expect(server.contexts().some((c) => /hold is over/i.test(c))).toBe(true);
  expect(server.conns).toHaveLength(1);
});

test("a drop while hidden parks, then resumes the same session on return", async ({ page }) => {
  const server = await fakeServer(page);
  await startCall(page, server);
  await setHidden(page, true);
  await server.conns[0]!.ws.close({ code: 1001 });
  await page.waitForTimeout(1500);
  expect(server.conns, "no resume attempts while hidden").toHaveLength(1);
  await expect(page.getByText(/On hold/).filter({ visible: true }).first()).toBeVisible();
  await setHidden(page, false);
  await expect.poll(() => server.conns.length).toBe(2);
  await expect.poll(() => server.conns[1]!.frames[0]).toEqual({ type: "session.resume", session_id: "sess_1" });
  expect(await welcomes(page, server)).toBe(1);
  expect(server.all().some((f) => f.type === "session.end")).toBe(false);
});

test("resume refused after the grace: a fresh session gets the call memory", async ({ page }) => {
  const server = await fakeServer(page, { refuseResume: true });
  const tokens = await tokenBodies(page);
  await startCall(page, server);
  await setHidden(page, true);
  await server.conns[0]!.ws.close({ code: 1001 });
  await page.waitForTimeout(500);
  await setHidden(page, false);
  await expect.poll(() => server.conns.length).toBe(3);
  const fresh = server.conns[2]!.frames;
  // The socket opens before the page sends its first frame: wait for it.
  await expect.poll(() => fresh[0]).toMatchObject({ type: "session.update", session: { agent_id: "agent_demo" } });
  await expect
    .poll(() => fresh.find((f) => f.type === "conversation.message")?.content as string | undefined)
    .toMatch(/solar panels in Lisbon[\s\S]*How do leads reach you/);
  expect(await welcomes(page, server)).toBe(1);
  await expect(page.getByText("We sell solar panels in Lisbon.").filter({ visible: true }).first()).toBeVisible();
  expect(tokens[0]).not.toHaveProperty("callToken");
  expect(tokens.at(-1)).toMatchObject({ resume: true, callToken: "call-tok" });
  // No error banner (Next's empty route announcer is also role=alert).
  await expect(page.getByRole("alert").filter({ hasText: /\S/ }).filter({ visible: true })).toHaveCount(0);
});

test("a reload continues the same call: one tap, same session, memory kept", async ({ page }) => {
  const server = await fakeServer(page);
  const tokens = await tokenBodies(page);
  await startCall(page, server);
  await page.reload();
  expect(server.conns[0]!.frames.some((f) => f.type === "session.end"), "pagehide never ends the call").toBe(false);
  await expect(visible(page, /^continue call$/i)).toBeVisible();
  await visible(page, /^continue call$/i).click();
  await expect.poll(() => server.conns.length).toBe(2);
  await expect.poll(() => server.conns[1]!.frames[0]).toEqual({ type: "session.resume", session_id: "sess_1" });
  expect(tokens.at(-1)).toMatchObject({ callToken: "call-tok" });
  expect(await welcomes(page, server)).toBe(1);
  await expect(page.getByText("We sell solar panels in Lisbon.").filter({ visible: true }).first()).toBeVisible();
});

test("hang-up ends the session and forgets the call", async ({ page }) => {
  const server = await fakeServer(page);
  await startCall(page, server);
  await visible(page, /^hang up$/i).click();
  await expect.poll(() => server.all().some((f) => f.type === "session.end")).toBe(true);
  await page.reload();
  await expect(visible(page, /^start call$/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /^continue call$/i }).filter({ visible: true })).toHaveCount(0);
});

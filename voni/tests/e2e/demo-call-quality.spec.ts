import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";

/**
 * The call-quality bugs from the owner's first real demo call (sess_c477d8f8),
 * reproduced against the real call component with a fake AssemblyAI socket:
 * the goodbye cut after "No problem.", Voni going silent when a noise cut her
 * off, and the transcript that stopped following.
 *
 *   PLAYWRIGHT_BASE_URL=https://localhost:3000 npx playwright test tests/e2e/demo-call-quality.spec.ts
 */

test.use({
  permissions: ["microphone"],
  ignoreHTTPSErrors: true,
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  },
});

type Frame = Record<string, unknown> & { type: string; at: number };

/** 0.5s of PCM16 mono silence at 24 kHz, base64: a real chunk the worklet must play out. */
const HALF_SECOND = Buffer.alloc(24_000).toString("base64");

async function fakeServer(page: Page) {
  const frames: Frame[] = [];
  let ws: WebSocketRoute | null = null;
  await page.routeWebSocket(/agents\.assemblyai\.com/, (socket) => {
    ws = socket;
    socket.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as Frame;
      if (msg.type === "input.audio") return;
      frames.push({ ...msg, at: Date.now() });
      if (msg.type === "session.update") {
        const session = msg.session as Record<string, unknown>;
        socket.send(JSON.stringify(session.agent_id ? { type: "session.ready", session_id: "sess_1" } : { type: "session.updated" }));
      }
    });
  });
  const say = (msg: Record<string, unknown>) => ws?.send(JSON.stringify(msg));
  return {
    frames,
    say,
    ready: () => ws !== null && frames.some((f) => f.type === "session.update"),
    replyCreates: () => frames.filter((f) => f.type === "reply.create"),
    ended: () => frames.find((f) => f.type === "session.end"),
  };
}

async function mockApis(page: Page) {
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, json: { error: "offline in e2e" } }));
  await page.route("**/api/demo/token", (route) =>
    route.fulfill({ json: { token: "tok", agentId: "agent_demo", callToken: "call-tok", testTag: "Lime 42", tagToken: "t" } }),
  );
  await page.route("**/api/demo/tools/end_call", (route) =>
    route.fulfill({ json: { ok: true, hangup: true, data: { ended: true } } }),
  );
}

async function startCall(page: Page) {
  await mockApis(page);
  const server = await fakeServer(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  // A click that lands before hydration does nothing: click again, as a person would.
  const start = page.getByRole("button", { name: /^start call$/i }).filter({ visible: true }).first();
  await expect(async () => {
    if (!server.ready()) await start.click({ timeout: 1000 }).catch(() => undefined);
    await expect.poll(server.ready, { timeout: 3000 }).toBe(true);
  }).toPass({ timeout: 20_000 });
  return { server, errors };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("end_call issued before the goodbye's audio: the whole goodbye plays before the hang-up", async ({ page }) => {
  const { server } = await startCall(page);
  // sess_c477d8f8: time-up reply.create → the model calls end_call first,
  // then streams the goodbye, with gaps between chunks. A result sent then
  // made the platform cut the goodbye's audio: it waits for reply.done.
  server.say({ type: "reply.started", reply_id: "bye" });
  server.say({ type: "tool.call", call_id: "e1", name: "end_call", arguments: { closing_line: "Bye!" } });
  await wait(800);
  expect(server.frames.some((f) => f.type === "tool.result"), "not mid-goodbye").toBe(false);
  server.say({ type: "transcript.agent", reply_id: "bye", text: "No problem. Reach the team at hi at voni dot c c. Bye!" });
  server.say({ type: "reply.audio", reply_id: "bye", data: HALF_SECOND });
  await wait(1500); // a gap between chunks, longer than the old drain grace
  expect(server.ended(), "never hangs up in a gap mid-goodbye").toBeUndefined();
  for (let i = 0; i < 4; i++) server.say({ type: "reply.audio", reply_id: "bye", data: HALF_SECOND });
  const doneAt = Date.now();
  server.say({ type: "reply.done", reply_id: "bye", status: "completed" });
  await expect.poll(() => server.frames.some((f) => f.type === "tool.result")).toBe(true);
  await expect.poll(() => server.ended(), { timeout: 12_000 }).toBeTruthy();
  // 2s of goodbye audio was queued at reply.done: the hang-up waits for it.
  expect(server.ended()!.at - doneAt).toBeGreaterThanOrEqual(1500);
});

test("a noise that cuts Voni off with no words after it: she picks up where she stopped", async ({ page }) => {
  const { server } = await startCall(page);
  server.say({ type: "reply.started", reply_id: "r1" });
  server.say({ type: "transcript.agent.delta", reply_id: "r1", delta: "I could handle flight bookings and itinerary changes" });
  server.say({ type: "reply.audio", reply_id: "r1", data: HALF_SECOND });
  await wait(300);
  // A wheel click reaches the mic: the server cuts the reply, no transcript follows.
  server.say({ type: "input.speech.started" });
  server.say({ type: "reply.done", reply_id: "r1", status: "interrupted" });
  const cutAt = Date.now();
  await expect.poll(() => server.replyCreates().length, { timeout: 4000 }).toBe(1);
  const resume = server.replyCreates()[0];
  expect(resume.at - cutAt).toBeLessThan(2500);
  expect(String(resume.instructions)).toMatch(/noise[\s\S]*Pick up where you left off/);
  expect(String(resume.instructions)).toMatch(/itinerary changes/);
});

test("real words after a cut are answered, never resumed over", async ({ page }) => {
  const { server } = await startCall(page);
  server.say({ type: "reply.started", reply_id: "r1" });
  server.say({ type: "reply.audio", reply_id: "r1", data: HALF_SECOND });
  server.say({ type: "input.speech.started" });
  server.say({ type: "reply.done", reply_id: "r1", status: "interrupted" });
  // Speech-to-text partials start ~300ms into real speech.
  await wait(300);
  server.say({ type: "transcript.user.delta", item_id: "u1", text: "What does it cost" });
  await wait(600);
  server.say({ type: "transcript.user", item_id: "u1", text: "What does it cost for a small agency?" });
  await wait(2500);
  expect(server.replyCreates()).toHaveLength(0);
});

test("the transcript follows new lines, even after a wheel tick at the bottom", async ({ page }, testInfo) => {
  const { server, errors } = await startCall(page);
  const viewport = page.getByLabel("Call transcript").filter({ visible: true }).first();
  const atBottom = () => viewport.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 8);
  const overflows = () => viewport.evaluate((el) => el.scrollHeight > el.clientHeight + 40);
  let n = 0;
  const addTurns = async (count: number) => {
    for (let i = 0; i < count; i++) {
      n += 1;
      server.say({ type: "transcript.user", item_id: `u${n}`, text: `Line ${n}: we run a small travel agency in Lisbon with three people.` });
      server.say({ type: "reply.started", reply_id: `r${n}` });
      server.say({ type: "transcript.agent", reply_id: `r${n}`, text: `Reply ${n}: I could take the late-night itinerary questions off your plate.` });
      server.say({ type: "reply.done", reply_id: `r${n}`, status: "completed" });
      await wait(120);
    }
  };
  await addTurns(8);
  await expect.poll(overflows).toBe(true);
  await expect.poll(atBottom).toBe(true);

  const box = (await viewport.boundingBox())!;
  const wheel = async (dy: number) => {
    if (testInfo.project.name === "mobile") {
      // Touch devices: a flick is a scroll plus touchend on the viewport.
      await viewport.evaluate((el, d) => {
        el.scrollTop += d;
        el.dispatchEvent(new TouchEvent("touchmove", { bubbles: true }));
        el.dispatchEvent(new TouchEvent("touchend", { bubbles: true }));
      }, dy);
    } else {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, dy);
    }
    await wait(300);
  };

  // The bug: a wheel tick at the bottom (moves nothing) dropped follow for good.
  await wheel(120);
  await addTurns(4);
  await expect.poll(atBottom, { message: "still following after a wheel tick at the bottom" }).toBe(true);
  await expect(viewport.getByText(`Reply ${n}:`)).toBeInViewport();

  // Scrolled up to reread: stays put while lines arrive.
  await wheel(-600);
  expect(await atBottom()).toBe(false);
  await addTurns(2);
  expect(await atBottom(), "reading history is never yanked").toBe(false);

  // Back at the bottom: follows again.
  await viewport.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await wheel(120);
  await addTurns(3);
  await expect.poll(atBottom, { message: "follows again once back at the bottom" }).toBe(true);
  expect(errors).toEqual([]);
});

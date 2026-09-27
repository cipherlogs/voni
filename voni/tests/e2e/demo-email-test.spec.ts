import { expect, test, type Page } from "@playwright/test";
import { DEMO_TEST_USE, TAG, fakeServer, found, free, mockApis, notArrived, startCall } from "./demo-fakes";

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

test.use(DEMO_TEST_USE);

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
  const gate = () => server.replyCreates().filter((i) => /nidal@gmail\.com, a personal address[\s\S]*I need your work one/.test(i));
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
    await expect.poll(() => server.replyCreates().filter((i) => /Say only the invite/.test(i)).length, { timeout: 4000 }).toBe(1);
    expect(server.replyCreates().find((i) => /Say only the invite/.test(i))).toContain("with Lime 42 in the subject");
    await page.waitForTimeout(2000);
    expect(server.replyCreates().filter((i) => /Say only the invite/.test(i)), "once").toHaveLength(1);
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
    await expect.poll(() => server.replyCreates().filter((i) => /Say only the invite/.test(i)).length, { timeout: 2000 }).toBe(1);
    expect(server.replyCreates().find((i) => /Say only the invite/.test(i))).toContain("with Lime 42 in the subject");
    // Its words never reach the transcript.
    server.say({ type: "transcript.agent", reply_id: "auto", text: "Send me an email with demo 102 in the subject." });
    server.say({ type: "reply.done", reply_id: "auto", status: "completed" });
    server.say({ type: "reply.started", reply_id: "invite" });
    server.say({ type: "transcript.agent", reply_id: "invite", text: "Send me an email with Lime 42 in the subject." });
    server.say({ type: "reply.done", reply_id: "invite", status: "completed" });
    await expect(page.getByText("with Lime 42 in the subject").filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByText("demo 102")).toHaveCount(0);
    await page.waitForTimeout(2000);
    expect(server.replyCreates().filter((i) => /Say only the invite/.test(i)), "once").toHaveLength(1);
  });

  test("if the platform starts no reply after the chip, the invite is sent anyway", async ({ page }) => {
    await mockApis(page, { check: () => notArrived });
    const server = await fakeServer(page);
    await startCall(page, server);
    server.say({ type: "reply.started", reply_id: "lead" });
    server.say({ type: "tool.call", call_id: "c1", name: "show_test_address", arguments: {} });
    await expect.poll(() => server.toolResults().length).toBe(1);
    server.say({ type: "reply.done", reply_id: "lead", status: "completed" });
    await expect.poll(() => server.replyCreates().filter((i) => /Say only the invite/.test(i)).length, { timeout: 4000 }).toBe(1);
  });
});

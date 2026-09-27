import { expect, test, type Locator, type Page } from "@playwright/test";
import { DEMO_TEST_USE, fakeServer, mockApis, notArrived, startCall } from "./demo-fakes";

/**
 * The demo call's layout with its busiest screen up: the test tag chip, a
 * long transcript, and (phones) the open Captions panel. Nothing may scroll
 * sideways, spill out of the call screen, or overlap, on a small iPhone, an
 * Android phone at its real visible height, and desktop. Screenshots pin the
 * look; refresh them with --update-snapshots after a deliberate change.
 *
 *   PLAYWRIGHT_BASE_URL=https://localhost:3000 npx playwright test tests/e2e/demo-layout.spec.ts
 */

test.use(DEMO_TEST_USE);

/** The dev server's issue badge (the mocks' 503s) isn't part of the page; the prod rig has none. */
const HIDE_DEV_OVERLAY = "nextjs-portal { display: none !important; }";

const LINES: [role: "user" | "agent", text: string][] = [
  ["agent", "Hi, I'm Voni! Let's try something cool: I'll show you what I can do while we talk. Ready?"],
  ["user", "Yes, sure."],
  ["agent", "Let me put something on your screen."],
  ["agent", "Send me an email from your work address with Lime 42 in the subject, and tell me when it's sent."],
  ["user", "Okay, give me a second, I'm opening my mail app now."],
  ["agent", "Take your time. I'll know the moment it lands in my inbox, even with everything else in there."],
  ["user", "Sent it just now."],
  ["agent", "Found it, Andres. I'm sending you a quick reply with something in it for you to check… sending."],
];

/** The busiest screen: the chip up, eight lines of transcript. */
async function busyCall(page: Page) {
  await mockApis(page, { check: () => notArrived });
  const server = await fakeServer(page);
  await startCall(page, server);
  await server.toolCall("show_test_address");
  LINES.forEach(([role, text], i) =>
    server.say(role === "user" ? { type: "transcript.user", item_id: `u${i}`, text } : { type: "transcript.agent", reply_id: `a${i}`, text }),
  );
  await expect(page.getByTestId("demo-address-chip").filter({ visible: true })).toBeVisible();
  await page.addStyleTag({ content: HIDE_DEV_OVERLAY });
}

type Box = { x: number; y: number; width: number; height: number };
const box = async (locator: Locator): Promise<Box> => {
  const b = await locator.boundingBox();
  expect(b, "on screen").not.toBeNull();
  return b!;
};
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
const inside = (inner: Box, outer: Box) =>
  inner.x >= outer.x - 0.5 &&
  inner.y >= outer.y - 0.5 &&
  inner.x + inner.width <= outer.x + outer.width + 0.5 &&
  inner.y + inner.height <= outer.y + outer.height + 0.5;

async function noSidewaysScroll(page: Page, scope: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  expect(await scope.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
}

/** One tidy row: the chip is no taller than its 36px pills (plus a hairline). */
async function chipOnOneRow(chip: Locator) {
  expect((await box(chip)).height).toBeLessThanOrEqual(40);
}

const PHONES = [
  { name: "small iPhone", viewport: { width: 375, height: 667 } },
  { name: "Android", viewport: { width: 390, height: 664 } },
];

for (const phone of PHONES) {
  test.describe(`phone layout: ${phone.name}`, () => {
    test.use({ viewport: phone.viewport });

    test("tag chip, open captions and the dock all fit, with no overlap", async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "mobile", "phone layout");
      await busyCall(page);
      const dialog = page.getByTestId("landing-demo-mobile-dialog");
      // Captions open by default on phones: the busiest screen is the default one.
      await expect(dialog.getByRole("button", { name: "Captions" })).toHaveAttribute("aria-expanded", "true");
      const transcript = page.getByTestId("landing-demo-mobile-transcript");
      await expect(transcript).toContainText("sending");

      const chip = dialog.getByTestId("demo-address-chip");
      const dock = dialog.getByTestId("landing-demo-mobile-dock");
      const orb = dialog.getByTestId("landing-demo-mobile-orb");
      const toggle = dialog.getByRole("button", { name: "Captions" });
      const screen = await box(dialog);
      // The visible pieces themselves: a squeezed box can hide its content spilling out.
      const parts = {
        chip: await box(chip),
        orb: await box(orb),
        toggle: await box(toggle),
        transcript: await box(transcript),
        dock: await box(dock),
      };
      for (const [name, b] of Object.entries(parts)) expect(inside(b, screen), `${name} inside the call screen`).toBe(true);
      const names = Object.keys(parts) as (keyof typeof parts)[];
      for (const a of names) {
        for (const b of names) {
          if (a < b) expect(overlaps(parts[a], parts[b]), `${a} overlaps ${b}`).toBe(false);
        }
      }
      // The orb stays visible, just smaller; the transcript gets real room.
      expect(parts.orb.height).toBeGreaterThanOrEqual(90);
      expect(parts.transcript.height).toBeGreaterThanOrEqual(180);
      await expect(dialog.getByTestId("landing-demo-mobile-caption")).toBeHidden();
      await chipOnOneRow(chip);
      await noSidewaysScroll(page, dialog);
      // The transcript scrolls inside itself: one scroller, the last line reachable.
      await expect(transcript.getByText(/sending/)).toBeInViewport();

      await expect(dialog).toHaveScreenshot(`call-busy-${phone.viewport.width}x${phone.viewport.height}.png`, {
        animations: "disabled",
        mask: [dialog.getByRole("status"), orb],
        maxDiffPixelRatio: 0.02,
      });
    });

    test("captions closed: the chip, the caption line and the dock fit", async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "mobile", "phone layout");
      await busyCall(page);
      const dialog = page.getByTestId("landing-demo-mobile-dialog");
      const chip = dialog.getByTestId("demo-address-chip");
      await dialog.getByRole("button", { name: "Captions" }).click();
      await expect(dialog.getByRole("button", { name: "Captions" })).toHaveAttribute("aria-expanded", "false");
      const caption = dialog.getByTestId("landing-demo-mobile-caption");
      const screen = await box(dialog);
      const parts = [chip, dialog.getByTestId("landing-demo-mobile-orb"), caption, dialog.getByTestId("landing-demo-mobile-dock")];
      const boxes = await Promise.all(parts.map(box));
      for (const b of boxes) expect(inside(b, screen)).toBe(true);
      boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => expect(overlaps(a, b)).toBe(false)));
      await chipOnOneRow(chip);
      await noSidewaysScroll(page, dialog);
    });
  });
}

test("desktop: the tag chip sits in the call card with the transcript", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop layout");
  await busyCall(page);
  const chip = page.getByTestId("demo-address-chip").filter({ visible: true });
  const card = page.getByRole("region").filter({ has: chip }).first();
  expect(inside(await box(chip), await box(card)), "chip inside the card").toBe(true);
  await noSidewaysScroll(page, card);
  // Room enough on desktop: the address shows in full.
  const address = chip.getByRole("button", { name: /copy address/i }).locator("span");
  expect(await address.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  await expect(card).toHaveScreenshot("call-busy-desktop.png", {
    animations: "disabled",
    mask: [card.getByRole("status"), card.locator(".voice-call-live-ring")],
    maxDiffPixelRatio: 0.02,
  });
});

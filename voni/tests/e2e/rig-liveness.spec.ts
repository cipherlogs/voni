import { expect, test } from "next/experimental/testmode/playwright";
// Placeholder scope: @next/playwright instant() import path varies by release;
// Task 6 replaces this scaffold with the trustworthy locked suite.
// import { instant } from "@next/playwright";

// Rig-liveness scaffold (unauthenticated, flag-off baseline).
// Proves the isolated candidate serves real app HTML. Locked instant()
// guards land in Task 6/10 — this file must not be mistaken for them.
test.describe("rig liveness (unauthenticated)", () => {
  test("login frame serves with loading feedback", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
  });

  test("landing serves branding", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /every call ends with the work already done/i })).toBeVisible();
  });
});

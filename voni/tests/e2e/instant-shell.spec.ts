import { expect, test } from "@playwright/test";
import { instant } from "@next/playwright";

// Task 6 trust protocol (myplan.md:243-271), unauthenticated slice.
// Per target: (1) unlock verify — destination + marker reachable as the
// test role; (2) locked assert — shell commits under instant().
// TOOLCHAIN BLOCKER (2026-09-09, verified): every locked test below fails
// with `Invariant: React.unstable_postpone is not defined` thrown from
// Next.js 16.3.4's testing-lock path. Installed React 19.2.8 — and 19.3.0
// stable (tarball-inspected) — export no such symbol; it exists only in
// React canary. Upgrading the app to canary React to satisfy the test rig
// is rejected (destabilizes production for a test-only path), and replacing
// instant() with timing asserts is forbidden by myplan.md Task 4/6. So the
// locked asserts are committed but marked fixme: they run the moment the
// toolchain is fixed (Next patch or supported React line) with zero edits.
// Unlock-verify tests above stay green as the flag-off baseline. See
// voni/instant-nav.rig.md Runs table for the failure signature.

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3100";

test.describe("instant shells (unauthenticated)", () => {
  test("unlock: /login renders its shell", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByTestId("login-shell")).toBeVisible();
    await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
  });

  // fixme(toolchain): locked path needs React.unstable_postpone — see header.
  test.fixme("locked hard nav: /login shell commits under instant()", async ({ page }) => {
    await instant(
      page,
      async () => {
        await page.goto("/login");
        await expect(page.getByTestId("login-shell")).toBeVisible();
      },
      { baseURL },
    );
  });

  test("unlock: /signup renders its shell", async ({ page }) => {
    await page.goto("/signup");
    await expect(page.getByTestId("signup-shell")).toBeVisible();
  });

  // fixme(toolchain): locked path needs React.unstable_postpone — see header.
  test.fixme("locked hard nav: /signup shell commits under instant()", async ({ page }) => {
    await instant(
      page,
      async () => {
        await page.goto("/signup");
        await expect(page.getByTestId("signup-shell")).toBeVisible();
      },
      { baseURL },
    );
  });

  test("unlock: / renders its shell", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("landing-shell")).toBeVisible();
  });

  // fixme(toolchain): locked path needs React.unstable_postpone — see header.
  test.fixme("locked hard nav: / shell commits under instant()", async ({ page }) => {
    await instant(
      page,
      async () => {
        await page.goto("/");
        await expect(page.getByTestId("landing-shell")).toBeVisible();
      },
      { baseURL },
    );
  });

  // fixme(toolchain): locked path needs React.unstable_postpone — see header.
  test.fixme("locked soft nav: landing Sign in link lands on login shell", async ({ page }) => {
    await page.goto("/");
    await instant(page, async () => {
      await page.getByRole("link", { name: /sign in/i }).click();
      await expect(page.getByTestId("login-shell")).toBeVisible();
    });
  });
});

test.describe("signed-out redirects (unauthenticated)", () => {
  // Protected shells need Task 5 sessions; without cookies the proxy must
  // redirect to /login with the safe destination preserved.
  // Route -> owning tickets (02-10). Any guard failure maps back to the
  // listed ticket; ticket 11 owns only this table, never the implementation.
  // Locked asserts are fixme under the toolchain blocker in the header.
  const guarded: Array<[string, string]> = [
    ["/dashboard", "02,05,09"],
    ["/calls", "09"],
    ["/calls/abc", "03,09"],
    ["/leads", "09"],
    ["/leads/abc", "03,09"],
    ["/campaigns", "09"],
    ["/campaigns/abc", "06,09"],
    ["/agents", "10"],
    ["/agents/abc", "06"],
    ["/agents/new", "06,10"],
    ["/settings", "04,06,10"],
    ["/settings/voice", "04,06,10"],
    ["/jobs", "06,10"],
    ["/numbers", "10"],
    ["/operator", "10"],
  ];
  for (const [route, tickets] of guarded) {
    test(`unlock: ${route} redirects to login with next preserved (tickets ${tickets})`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByTestId("login-shell")).toBeVisible();
      expect(page.url()).toContain(`/login?next=${encodeURIComponent(route)}`);
    });

    // fixme(toolchain): locked path needs React.unstable_postpone — see header.
    test.fixme(`locked hard nav: ${route} redirect commits under instant()`, async ({ page }) => {
      await instant(
        page,
        async () => {
          await page.goto(route);
          await expect(page.getByTestId("login-shell")).toBeVisible();
        },
        { baseURL },
      );
    });
  }
});
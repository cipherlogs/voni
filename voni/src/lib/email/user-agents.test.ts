/**
 * The pool that decides who a simulated click claims to be. These are cheap
 * invariants with expensive consequences: a UA that is not a real browser
 * string, or a device outside the enum, is exactly the tell the pool exists to
 * avoid, and it can only be caught by reading the constant.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_FAMILIES,
  BROWSER_PROFILES,
  BROWSER_VALUES,
  DEVICE_VALUES,
  PROFILE_FAMILIES,
  clientHintsFor,
  pickBrowserProfile,
  refererForProvider,
  type ProfileFamily,
} from "./user-agents";

/** The substring every member of a family must carry, per that family's grammar. */
const FAMILY_MARKERS: Record<ProfileFamily, RegExp[]> = {
  "chrome-desktop": [/ Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/],
  "chrome-android": [
    / Chrome\/\d+\.0\.0\.0 Mobile Safari\/537\.36$/,
    /\(Linux; Android \d+; [^)]+\)/,
  ],
  "safari-ios": [
    / Version\/\d+\.\d+ Mobile\/15E148 Safari\/604\.1$/,
    /\(iPhone; CPU iPhone OS \d+_\d+ like Mac OS X\)/,
  ],
  "safari-macos": [/ Version\/\d+\.\d+ Safari\/605\.1\.15$/],
  "firefox-desktop": [/ Gecko\/20100101 Firefox\/\d+\.0$/],
  "edge-desktop": [/ Chrome\/\d+\.0\.0\.0 Safari\/537\.36 Edg\/\d+\.0\.0\.0$/],
  "samsung-internet": [/ SamsungBrowser\/\d+\.0 Chrome\/\d+\.0\.0\.0 Mobile Safari\/537\.36$/],
  "safari-ipad": [/ Version\/\d+\.\d+ Mobile\/15E148 Safari\/604\.1$/, /\(iPad; CPU OS \d+_\d+ like Mac OS X\)/],
};

const MOBILE_FAMILIES = new Set<ProfileFamily>([
  "chrome-android",
  "safari-ios",
  "samsung-internet",
  "safari-ipad",
]);

test("the pool is large enough to look organic and small enough to review", () => {
  assert.ok(BROWSER_PROFILES.length >= 55, `pool is ${BROWSER_PROFILES.length}, too small`);
  assert.ok(BROWSER_PROFILES.length <= 70, `pool is ${BROWSER_PROFILES.length}, too large`);
});

test("ids are unique", () => {
  const ids = new Set(BROWSER_PROFILES.map((profile) => profile.id));
  assert.equal(ids.size, BROWSER_PROFILES.length);
});

test("profile weights sum to the whole pool", () => {
  const total = BROWSER_PROFILES.reduce((sum, profile) => sum + profile.weight, 0);
  assert.ok(
    Math.abs(total - 1) <= 0.001,
    `weights sum to ${total}, expected 1`,
  );
  for (const profile of BROWSER_PROFILES) {
    assert.ok(profile.weight > 0, `${profile.id}: non-positive weight`);
  }
});

test("every family is populated and its group weight matches its members", () => {
  const seen = new Set(BROWSER_PROFILES.map((profile) => profile.family));
  assert.deepEqual([...seen].sort(), [...PROFILE_FAMILIES].sort());
  for (const group of BROWSER_FAMILIES) {
    assert.ok(group.members.length > 0, `${group.family}: no members`);
    const summed = group.members.reduce((sum, profile) => sum + profile.weight, 0);
    assert.ok(
      Math.abs(group.weight - summed) <= 1e-9,
      `${group.family}: group weight ${group.weight} != ${summed}`,
    );
    for (const member of group.members) {
      assert.equal(member.family, group.family);
    }
  }
});

test("every entry is a plausible browser UA for its family", () => {
  for (const profile of BROWSER_PROFILES) {
    assert.ok(profile.id.length > 0, `${profile.id}: empty id`);
    assert.ok(
      profile.userAgent.startsWith("Mozilla/5.0"),
      `${profile.id}: ${profile.userAgent}`,
    );
    assert.match(
      profile.userAgent,
      /(AppleWebKit|Gecko\/20100101)/,
      `${profile.id}: no rendering engine`,
    );
    assert.ok(
      (DEVICE_VALUES as readonly string[]).includes(profile.device),
      `${profile.id}: ${profile.device}`,
    );
    assert.ok(
      (BROWSER_VALUES as readonly string[]).includes(profile.browser),
      `${profile.id}: ${profile.browser}`,
    );
    for (const marker of FAMILY_MARKERS[profile.family]) {
      assert.match(profile.userAgent, marker, `${profile.id}: ${profile.userAgent}`);
    }
    assert.ok(
      profile.userAgent.length <= 400,
      `${profile.id}: UA over the report's 400-char ceiling`,
    );
    assert.ok(profile.platform.length > 0, `${profile.id}: empty platform`);
    assert.ok(
      profile.browser.length <= 40,
      `${profile.id}: browser over the report's 40-char ceiling`,
    );
  }
});

test("mobile and tablet families send Mobile or iPad; desktop does not", () => {
  for (const profile of BROWSER_PROFILES) {
    if (profile.device === "desktop") {
      assert.equal(
        profile.userAgent.includes("Mobile"),
        false,
        `${profile.id}: desktop UA claims Mobile`,
      );
      continue;
    }
    assert.ok(
      MOBILE_FAMILIES.has(profile.family),
      `${profile.id}: ${profile.device} outside a mobile family`,
    );
    assert.ok(
      profile.userAgent.includes("Mobile") || profile.userAgent.includes("iPad"),
      `${profile.id}: mobile UA carries neither Mobile nor iPad`,
    );
  }
});

test("family weights follow the market-share shape and tilt mobile", () => {
  const weights = Object.fromEntries(
    BROWSER_FAMILIES.map((group) => [group.family, group.weight]),
  ) as Record<ProfileFamily, number>;
  // Approximations, not measurements — see the module header. Families must
  // still sum to 1 and keep Chrome desktop the largest single family.
  assert.ok(Math.abs(weights["chrome-desktop"] - 0.3) < 0.001);
  assert.ok(Math.abs(weights["safari-ios"] - 0.26) < 0.001);
  assert.ok(weights["chrome-desktop"] > weights["chrome-android"]);
  assert.ok(weights["chrome-android"] > weights["safari-macos"]);
  for (const [family, weight] of Object.entries(weights)) {
    if (family !== "chrome-desktop") {
      assert.ok(
        weight < weights["chrome-desktop"],
        `${family} (${weight}) outweighs Chrome desktop`,
      );
    }
  }
});

test("phone and tablet are ~60% of clicks, with phone the larger part", () => {
  const shareOf = (device: "desktop" | "mobile" | "tablet") =>
    BROWSER_PROFILES.filter((profile) => profile.device === device).reduce(
      (sum, profile) => sum + profile.weight,
      0,
    );

  const mobile = shareOf("mobile");
  const tablet = shareOf("tablet");
  const mixed = mobile + tablet;

  assert.ok(Math.abs(mixed - 0.6) < 0.001, `mobile+tablet is ${mixed}`);
  assert.ok(Math.abs(mobile - 0.58) < 0.001, `phone is ${mobile}`);
  assert.ok(Math.abs(tablet - 0.02) < 0.001, `tablet is ${tablet}`);
  assert.ok(mobile > tablet, "phone must be the larger part of mobile traffic");
  assert.ok(tablet / mixed >= 0.02, "tablet must not be a rounding error");
});

test("pickBrowserProfile is deterministic at both ends of the range", () => {
  for (const value of [0, 0.999]) {
    const first = pickBrowserProfile(() => value);
    const second = pickBrowserProfile(() => value);
    assert.equal(first, second);
    assert.ok(
      BROWSER_PROFILES.includes(first),
      `${first.id}: not a member of the pool`,
    );
  }
  assert.equal(pickBrowserProfile(() => 0), BROWSER_PROFILES[0]);
  assert.equal(
    pickBrowserProfile(() => 0.999),
    BROWSER_PROFILES[BROWSER_PROFILES.length - 1],
  );
  // Out-of-contract randoms are clamped, not allowed to index past the end.
  assert.equal(pickBrowserProfile(() => 1), BROWSER_PROFILES[BROWSER_PROFILES.length - 1]);
  assert.equal(pickBrowserProfile(() => -1), BROWSER_PROFILES[0]);
  assert.equal(pickBrowserProfile(() => Number.NaN), BROWSER_PROFILES[0]);
});

test("10,000 draws put Chrome desktop first and Chrome Android second", () => {
  const counts = new Map<ProfileFamily, number>();
  for (let draw = 0; draw < 10_000; draw += 1) {
    const profile = pickBrowserProfile();
    counts.set(profile.family, (counts.get(profile.family) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  assert.equal(ranked[0]?.[0], "chrome-desktop");
  assert.equal(ranked[1]?.[0], "chrome-android");

  // 10% slack on each share, so the assertion tracks the table, not the noise.
  const share = (family: ProfileFamily) => (counts.get(family) ?? 0) / 10_000;
  assert.ok(share("chrome-desktop") > 0.3 * 0.9, "Chrome desktop share too low");
  assert.ok(share("chrome-android") > 0.28 * 0.9, "Chrome Android share too low");
  assert.ok(share("chrome-android") < 0.28 * 1.1, "Chrome Android share too high");
  const mobileShare = BROWSER_PROFILES.filter(
    (profile) => profile.device === "mobile",
  ).reduce((sum, profile) => sum + profile.weight, 0);
  assert.ok(mobileShare > 0.55, "phone share must dominate the pool");
});

test("every family can be reached by its own bucket", () => {
  const seen = new Set<ProfileFamily>();
  let cursor = 0;
  for (const group of BROWSER_FAMILIES) {
    // The midpoint of each family's slice of [0, 1), drawn twice as the
    // selection itself does (family, then member).
    const familyValue = cursor + group.weight / 2;
    cursor += group.weight;
    seen.add(pickBrowserProfile(() => familyValue).family);
  }
  assert.deepEqual([...seen].sort(), [...PROFILE_FAMILIES].sort());
});

test("a webmail provider maps to the origin that provider's mail UI uses", () => {
  assert.equal(refererForProvider("gmail.com"), "https://mail.google.com/");
  assert.equal(refererForProvider("outlook.com"), "https://outlook.live.com/");
  assert.equal(refererForProvider("yahoo.com"), "https://mail.yahoo.com/");
  assert.equal(refererForProvider("icloud.com"), "https://www.icloud.com/mail/");
  assert.equal(refererForProvider("proton.me"), "https://mail.proton.me/");
});

test("an ISP mailbox sends no Referer, because its portal is not guessable", () => {
  assert.equal(refererForProvider("verizon.com"), null);
  assert.equal(refererForProvider("att.com"), null);
  assert.equal(refererForProvider("comcast.net"), null);
});

test("an unknown or missing provider sends no Referer", () => {
  assert.equal(refererForProvider("example.invalid"), null);
  assert.equal(refererForProvider(null), null);
  assert.equal(refererForProvider(""), null);
});

test("a Chrome desktop profile sends Chromium client hints for its own major", () => {
  const profile = BROWSER_PROFILES.find(
    (entry) => entry.id === "chrome-desktop-win11-150",
  )!;
  const hints = clientHintsFor(profile);

  assert.match(hints["sec-ch-ua"] ?? "", /"Google Chrome";v="150"/);
  assert.match(hints["sec-ch-ua"] ?? "", /"Chromium";v="150"/);
  assert.equal(hints["sec-ch-ua-platform"], '"Windows"');
  assert.equal(hints["sec-ch-ua-mobile"], "?0");
  assert.equal(hints["sec-fetch-site"], "cross-site");
  assert.equal(hints["sec-fetch-mode"], "navigate");
  assert.equal(hints["sec-fetch-dest"], "document");
  assert.equal(hints["sec-fetch-user"], "?1");
});

test("Safari sends no client hints, on any device", () => {
  const safari = BROWSER_PROFILES.filter((entry) => entry.browser === "Safari");
  assert.ok(safari.length > 0);
  for (const profile of safari) {
    assert.deepEqual(clientHintsFor(profile), {}, `${profile.id}: sent hints`);
  }
});

test("Firefox sends no client hints", () => {
  for (const profile of BROWSER_PROFILES.filter(
    (entry) => entry.browser === "Firefox",
  )) {
    assert.deepEqual(clientHintsFor(profile), {}, `${profile.id}: sent hints`);
  }
});

test("every Chromium profile's hints match its own UA and device", () => {
  const chromium = BROWSER_PROFILES.filter(
    (entry) => entry.browser !== "Safari" && entry.browser !== "Firefox",
  );
  assert.ok(chromium.length > 0);

  for (const profile of chromium) {
    const major = /Chrome\/(\d+)/.exec(profile.userAgent)?.[1];
    assert.ok(major, `${profile.id}: no Chromium major in the UA`);
    const hints = clientHintsFor(profile);

    assert.match(
      hints["sec-ch-ua"] ?? "",
      new RegExp(`"Chromium";v="${major}"`),
      `${profile.id}: hint contradicts the UA`,
    );
    assert.match(
      hints["sec-ch-ua-platform"] ?? "",
      /^"(Windows|macOS|Android)"$/,
      `${profile.id}: ${hints["sec-ch-ua-platform"]}`,
    );
    assert.equal(
      hints["sec-ch-ua-mobile"],
      profile.device === "mobile" ? "?1" : "?0",
      `${profile.id}: mobile hint disagrees with the device`,
    );
  }
});

test("Chrome on Android reports Android and the mobile hint", () => {
  const profile = BROWSER_PROFILES.find(
    (entry) => entry.family === "chrome-android",
  )!;
  const hints = clientHintsFor(profile);
  assert.equal(hints["sec-ch-ua-platform"], '"Android"');
  assert.equal(hints["sec-ch-ua-mobile"], "?1");
});

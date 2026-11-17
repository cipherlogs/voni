/**
 * Who a simulated affiliate click claims to be.
 *
 * A click from `node`'s own fetch announces `undici` as its User-Agent, which is
 * exactly the signal an affiliate's bot filter looks for. The pool here is a
 * weighted matrix of current browser strings a real visitor would send, so a
 * visit is indistinguishable from an ordinary one at the header level without
 * pretending to be a browser we never emulate. Nothing in this module is random
 * or stateful except `pickBrowserProfile`'s injected random; it takes no clock
 * and touches no network, which is what makes it testable as a pure module.
 *
 * The pool is built from a matrix (family → device/OS/version combinations)
 * rather than hand-listed, because the table is the thing that must stay
 * consistent: every member of a family shares one grammar, so expanding a
 * family cannot produce a string that browser never sends.
 *
 * ## Market-share reasoning (approximations, re-check yearly)
 *
 * Across web traffic, Chrome is roughly 60-65% of all requests (desktop plus
 * Android), Safari mobile roughly 20-25%, Safari desktop roughly 5-7%, Firefox
 * roughly 3-5%, Edge roughly 4-5%, Samsung Internet roughly 2-3%, and iPad
 * roughly 1%. The family weights below approximate that split, then split
 * desktop Chrome between Windows and macOS (Windows dominates) and split mobile
 * Chrome between Pixel and Samsung. They are deliberately rounded, not
 * measured: the point is that a burst of clicks does not arrive as one browser.
 *
 * Version assumption, checked 2026-11-17: Chrome/Edge stable majors 148-150,
 * Firefox 150-152, iOS Safari 26.0/26.4. Where a current major was uncertain the
 * pool stays one release behind rather than ahead; a string for a version that
 * does not exist is the one thing a filter can catch.
 *
 * Two platform tokens are frozen by their vendors and therefore shared across
 * OS versions on purpose: Chrome on Windows 11 reports `Windows NT 10.0` (the
 * same as Windows 10), and Safari/Chrome on macOS 14 and 15 report
 * `Intel Mac OS X 10_15_7`. Those profiles differ by id and by version, not by
 * an invented OS token.
 */

/** The device classes the click report accepts; anything else is a bug. */
export const DEVICE_VALUES = ["desktop", "mobile", "tablet"] as const;

export type ClickDevice = (typeof DEVICE_VALUES)[number];

/** The browser names the report accepts, kept in step with the pool. */
export const BROWSER_VALUES = [
  "Chrome",
  "Safari",
  "Firefox",
  "Edge",
  "Samsung Internet",
] as const;

export type ClickBrowser = (typeof BROWSER_VALUES)[number];

/**
 * A traffic family: one browser grammar on one device class. Selection picks a
 * family first, then a member, instead of weighting 60-odd strings one by one.
 * Real traffic clusters this way — Chrome desktop is a large share, the long
 * tail inside it is a version/OS distribution — so weighting families and then
 * members keeps the shape recognisable and the table maintainable.
 */
export const PROFILE_FAMILIES = [
  "chrome-desktop",
  "chrome-android",
  "safari-ios",
  "safari-macos",
  "firefox-desktop",
  "edge-desktop",
  "samsung-internet",
  "safari-ipad",
] as const;

export type ProfileFamily = (typeof PROFILE_FAMILIES)[number];

export type BrowserProfile = {
  id: string;
  userAgent: string;
  device: ClickDevice;
  platform: string;
  browser: ClickBrowser;
  family: ProfileFamily;
  /** Share of the whole pool, in [0, 1]. Every family's members split its weight. */
  weight: number;
};

/**
 * Current stable majors, newest first. Edge tracks Chromium and shares Chrome's
 * numbering; Firefox has its own, monthly, train.
 */
const CHROME_DESKTOP_MAJORS = [150, 149, 148, 147, 146, 145] as const;
const CHROME_ANDROID_MAJORS = [150, 149, 148] as const;
const FIREFOX_MAJORS = [152, 151, 150] as const;
const EDGE_MAJORS = [150, 149, 148] as const;

/** iOS 26 patch levels the pool claims: the latest point release and the .0. */
const IOS_VERSIONS = [
  { token: "26_4", version: "26.4" },
  { token: "26_0", version: "26.0" },
] as const;

const IPHONE_GENERATIONS = ["iphone-16", "iphone-15", "iphone-14"] as const;

/**
 * Android phones, newest first. The model token is part of the UA, so these are
 * the devices a filter can actually check against the reported OS version.
 */
const ANDROID_DEVICES = [
  { id: "pixel-9", model: "Pixel 9" },
  { id: "pixel-8", model: "Pixel 8" },
  { id: "sm-s938b", model: "SM-S938B" },
  { id: "sm-s928b", model: "SM-S928B" },
] as const;

const ANDROID_VERSIONS = [15, 14] as const;

type ProfileSeed = Omit<BrowserProfile, "weight">;

function chromeDesktopSeeds(): ProfileSeed[] {
  const seeds: ProfileSeed[] = [];
  // Windows 11 and Windows 10 share a UA token: both report NT 10.0, so an
  // invented 11.0 would be the tell. Windows gets every major; macOS gets a
  // narrower slice of the majors so the OS mix inside the family still reads
  // Windows-dominant (roughly two thirds), which is what desktop traffic does.
  const platforms = [
    { key: "win11", platform: "Windows", majors: CHROME_DESKTOP_MAJORS },
    { key: "win10", platform: "Windows", majors: CHROME_DESKTOP_MAJORS },
    { key: "macos15", platform: "macOS", majors: CHROME_DESKTOP_MAJORS.slice(0, 4) },
    { key: "macos14", platform: "macOS", majors: CHROME_DESKTOP_MAJORS.slice(0, 2) },
  ] as const;

  for (const entry of platforms) {
    for (const major of entry.majors) {
      const macintosh = entry.platform === "macOS";
      seeds.push({
        id: `chrome-desktop-${entry.key}-${major}`,
        userAgent: macintosh
          ? `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
          : `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
        device: "desktop",
        platform: entry.platform,
        browser: "Chrome",
        family: "chrome-desktop",
      });
    }
  }
  return seeds;
}

function chromeAndroidSeeds(): ProfileSeed[] {
  const seeds: ProfileSeed[] = [];
  for (const device of ANDROID_DEVICES) {
    for (const android of ANDROID_VERSIONS) {
      for (const major of CHROME_ANDROID_MAJORS) {
        seeds.push({
          id: `chrome-android-${device.id}-android${android}-${major}`,
          userAgent: `Mozilla/5.0 (Linux; Android ${android}; ${device.model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
          device: "mobile",
          platform: "Android",
          browser: "Chrome",
          family: "chrome-android",
        });
      }
    }
  }
  return seeds;
}

function safariIosSeeds(): ProfileSeed[] {
  const seeds: ProfileSeed[] = [];
  for (const iphone of IPHONE_GENERATIONS) {
    for (const ios of IOS_VERSIONS) {
      seeds.push({
        // The hardware generation is not in the UA (iOS Safari sends a bare
        // `iPhone` token); the id records which device this profile stands for.
        id: `safari-ios-${iphone}-${ios.token}`,
        userAgent: `Mozilla/5.0 (iPhone; CPU iPhone OS ${ios.token} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${ios.version} Mobile/15E148 Safari/604.1`,
        device: "mobile",
        platform: "iOS",
        browser: "Safari",
        family: "safari-ios",
      });
    }
  }
  return seeds;
}

function safariMacosSeeds(): ProfileSeed[] {
  // macOS 14.6 and 15.x both send the frozen 10_15_7 token, so the profiles
  // differ by Safari version rather than by a platform string Apple no longer
  // updates.
  return [
    {
      id: "safari-macos-14_6",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
      device: "desktop",
      platform: "macOS",
      browser: "Safari",
      family: "safari-macos",
    },
    {
      id: "safari-macos-15_x",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Safari/605.1.15",
      device: "desktop",
      platform: "macOS",
      browser: "Safari",
      family: "safari-macos",
    },
  ];
}

function firefoxDesktopSeeds(): ProfileSeed[] {
  const seeds: ProfileSeed[] = [];
  const platforms = [
    {
      key: "windows",
      platform: "Windows",
      token: "Windows NT 10.0; Win64; x64",
    },
    {
      key: "macos",
      platform: "macOS",
      // Firefox on macOS also freezes the OS token at 10.15.
      token: "Macintosh; Intel Mac OS X 10.15",
    },
  ] as const;

  for (const entry of platforms) {
    for (const major of FIREFOX_MAJORS) {
      seeds.push({
        id: `firefox-desktop-${entry.key}-${major}`,
        userAgent: `Mozilla/5.0 (${entry.token}; rv:${major}.0) Gecko/20100101 Firefox/${major}.0`,
        device: "desktop",
        platform: entry.platform,
        browser: "Firefox",
        family: "firefox-desktop",
      });
    }
  }
  return seeds;
}

function edgeDesktopSeeds(): ProfileSeed[] {
  return EDGE_MAJORS.map((major) => ({
    id: `edge-desktop-windows-${major}`,
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
    device: "desktop",
    platform: "Windows",
    browser: "Edge",
    family: "edge-desktop",
  }));
}

function samsungInternetSeeds(): ProfileSeed[] {
  // Samsung Internet 28 is built on an older Chromium than the desktop stable
  // major; the embedded Chrome token trails on purpose.
  return [
    {
      id: "samsung-internet-sm-s918b",
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36",
      device: "mobile",
      platform: "Android",
      browser: "Samsung Internet",
      family: "samsung-internet",
    },
  ];
}

function safariIpadSeeds(): ProfileSeed[] {
  return IOS_VERSIONS.map((ios) => ({
    id: `safari-ipad-${ios.token}`,
    userAgent: `Mozilla/5.0 (iPad; CPU OS ${ios.token} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${ios.version} Mobile/15E148 Safari/604.1`,
    device: "tablet",
    platform: "iPadOS",
    browser: "Safari",
    family: "safari-ipad",
  }));
}

const FAMILY_MEMBERS: Record<ProfileFamily, ProfileSeed[]> = {
  "chrome-desktop": chromeDesktopSeeds(),
  "chrome-android": chromeAndroidSeeds(),
  "safari-ios": safariIosSeeds(),
  "safari-macos": safariMacosSeeds(),
  "firefox-desktop": firefoxDesktopSeeds(),
  "edge-desktop": edgeDesktopSeeds(),
  "samsung-internet": samsungInternetSeeds(),
  "safari-ipad": safariIpadSeeds(),
};

/**
 * Family shares. They must sum to 1; the module throws at load if an edit
 * breaks that, because a pool that quietly adds up to 0.9 silently changes
 * every downstream distribution.
 */
const FAMILY_WEIGHTS: Record<ProfileFamily, number> = {
  "chrome-desktop": 0.42,
  "chrome-android": 0.16,
  "safari-ios": 0.22,
  "safari-macos": 0.06,
  "firefox-desktop": 0.05,
  "edge-desktop": 0.05,
  "samsung-internet": 0.03,
  "safari-ipad": 0.01,
};

function buildProfiles(): BrowserProfile[] {
  const profiles: BrowserProfile[] = [];
  for (const family of PROFILE_FAMILIES) {
    const members = FAMILY_MEMBERS[family];
    const weight = FAMILY_WEIGHTS[family] / members.length;
    for (const member of members) {
      profiles.push({ ...member, weight });
    }
  }
  return profiles;
}

/**
 * The pool, flattened in family order. Within a family members are uniform, so
 * a family's weight is shared equally; the table is derived, never typed twice.
 */
export const BROWSER_PROFILES: readonly BrowserProfile[] = buildProfiles();

const familyWeightSum = PROFILE_FAMILIES.reduce(
  (sum, family) => sum + FAMILY_WEIGHTS[family],
  0,
);
if (Math.abs(familyWeightSum - 1) > 1e-6) {
  throw new Error(
    `user-agents: family weights sum to ${familyWeightSum}, expected 1`,
  );
}

export type BrowserFamilyGroup = {
  family: ProfileFamily;
  weight: number;
  members: readonly BrowserProfile[];
};

/** The same pool grouped by family, in the order selection walks it. */
export const BROWSER_FAMILIES: readonly BrowserFamilyGroup[] =
  PROFILE_FAMILIES.map((family) => {
    const members = BROWSER_PROFILES.filter(
      (profile) => profile.family === family,
    );
    return {
      family,
      weight: members.reduce((sum, profile) => sum + profile.weight, 0),
      members,
    };
  });

function clampRandom(random: () => number): number {
  const value = random();
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function familyFor(value: number): BrowserFamilyGroup {
  let cumulative = 0;
  for (const group of BROWSER_FAMILIES) {
    cumulative += group.weight;
    if (value < cumulative) return group;
  }
  // A value of exactly 1 (or float drift at the end of the range) belongs to
  // the last family rather than to no family at all.
  return BROWSER_FAMILIES[BROWSER_FAMILIES.length - 1]!;
}

/**
 * One profile, drawn the way traffic arrives: a family by weight, then a member
 * uniformly. A caller that needs a deterministic answer (tests, a replay) passes
 * its own random; a value outside [0, 1) is clamped rather than trusted,
 * because an index out of range would make a click fail for a reason that has
 * nothing to do with the target.
 */
export function pickBrowserProfile(
  random: () => number = Math.random,
): BrowserProfile {
  const group = familyFor(clampRandom(random));
  const memberValue = clampRandom(random);
  const index = Math.min(
    group.members.length - 1,
    Math.floor(memberValue * group.members.length),
  );
  // `members` is non-empty for every family by construction.
  return group.members[index]!;
}

/**
 * The Referer a visitor clicking a link inside their webmail would send.
 *
 * Only the big webmail providers get one: that is where a link in an email is
 * actually opened, and the origin is part of the request a mail client makes.
 * An ISP mailbox (`verizon.com`, `att.com`, …) is almost always read through
 * the ISP's own portal or a mail client, and `null` — which callers translate
 * into sending no Referer header at all — is more truthful than guessing an
 * origin that would not appear. Unknown providers are `null` for the same
 * reason.
 */
const PROVIDER_REFERERS: Readonly<Record<string, string>> = {
  "gmail.com": "https://mail.google.com/",
  "googlemail.com": "https://mail.google.com/",
  "outlook.com": "https://outlook.live.com/",
  "hotmail.com": "https://outlook.live.com/",
  "live.com": "https://outlook.live.com/",
  "msn.com": "https://outlook.live.com/",
  "yahoo.com": "https://mail.yahoo.com/",
  "ymail.com": "https://mail.yahoo.com/",
  "icloud.com": "https://www.icloud.com/mail/",
  "me.com": "https://www.icloud.com/mail/",
  "proton.me": "https://mail.proton.me/",
  "protonmail.com": "https://mail.proton.me/",
};

export function refererForProvider(provider: string | null): string | null {
  if (provider === null) return null;
  const key = provider.trim().toLowerCase().replace(/^www\./, "");
  if (key === "") return null;
  return PROVIDER_REFERERS[key] ?? null;
}

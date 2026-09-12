/**
 * Generates src/lib/copilot/app-manifest.ts from the app's own sources, so
 * the voice copilot learns every screen as the app changes instead of going
 * stale the moment a feature ships without a prompt edit.
 *
 * Sources (single owners, never duplicated here):
 * - dashboard nav: NAV_ITEMS in src/components/app-sidebar.tsx
 * - section titles: SECTION_TITLES in src/components/app-header.tsx
 * - settings tabs: SETTINGS_TABS in src/lib/settings-tabs.ts (parsed,
 *   not imported — that module pulls server actions, which need a database)
 * - which routes exist: page.tsx files under src/app
 *
 * npm run copilot:manifest        # regenerate the checked-in file
 * npm run copilot:manifest:check  # CI: fail when the file is stale
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NAV_ITEMS } from "../src/components/app-sidebar";
import { SECTION_TITLES } from "../src/components/app-header";

const SRC = join(import.meta.dirname, "..", "src");
const OUT = join(SRC, "lib", "copilot", "app-manifest.ts");

/** Routes voice must never offer (auth gates, not app screens). */
const PUBLIC_ROUTES = new Set(["/"]);
const AUTH_ROUTES = new Set(["/login", "/signup"]);
const PLATFORM_ADMIN_ROUTES = new Set(["/operator"]);

/**
 * Vocabulary users actually say, per route. The generator fails loudly on a
 * route missing here so a new screen cannot ship voice-invisible — add its
 * phrases and regenerate.
 */
const PHRASES: Record<string, string[]> = {
  "/": ["landing page", "public demo"],
  "/login": ["login", "sign in"],
  "/signup": ["signup", "sign up"],
  "/agents/[id]": ["agent details", "open agent"],
  "/campaigns/[id]": ["campaign details", "open campaign"],
  "/leads/[id]": ["lead details", "open lead"],
  "/calls/[id]": ["call details", "open call"],
  "/dashboard": ["dashboard", "home", "overview"],
  "/agents": ["agents", "phone agents", "agent library", "my agents"],
  "/agents/new": ["new agent", "create agent", "build an agent", "agent builder", "agent wizard"],
  "/campaigns": ["campaigns", "my campaigns"],
  "/campaigns/new": ["new campaign", "create campaign", "start a campaign"],
  "/leads": ["leads", "my leads", "lead list"],
  "/calls": ["calls", "my calls", "call list", "call history"],
  "/numbers": ["phone numbers", "numbers", "calling numbers", "my numbers"],
  "/jobs": ["jobs", "background jobs", "job status"],
  "/settings": ["settings", "voice copilot", "voice control", "voice settings", "preferences"],
  "/operator": ["operator", "platform operator", "platform status"],
};

/** Titles for voice-reachable routes owned by neither the sidebar nor the header. */
const TITLE_OVERRIDES: Record<string, string> = {
  "/": "Welcome", "/login": "Sign in", "/signup": "Sign up",
  "/agents/[id]": "Agent details", "/campaigns/[id]": "Campaign details",
  "/leads/[id]": "Lead details", "/calls/[id]": "Call details",
  "/agents/new": "New agent",
  "/campaigns/new": "New campaign",
  "/operator": "Platform operator",
};

const EXAMPLES: Record<string, string[]> = {
  "/": [
    "Describe Voni",
    "Show the public demo",
    "How do I sign in?"
  ],
  "/login": [
    "Sign in to Voni",
    "Continue with Google",
    "Open sign in"
  ],
  "/signup": [
    "Create my account",
    "Sign up with Google",
    "Join Voni"
  ],
  "/dashboard": [
    "Open dashboard",
    "Show the overview",
    "Read recent calls"
  ],
  "/agents": [
    "Show my agents",
    "Find an agent named Sara",
    "Open the agent library"
  ],
  "/agents/new": [
    "Create a new agent",
    "Read this wizard step",
    "Go to review"
  ],
  "/agents/[id]": [
    "Find an agent named Sara",
    "Open the second matching agent",
    "Read this agent configuration"
  ],
  "/campaigns": [
    "Open campaigns",
    "Find my viewing campaign",
    "Show active campaigns"
  ],
  "/campaigns/new": [
    "Create a campaign",
    "Read the campaign fields",
    "Set campaign name to Viewings"
  ],
  "/campaigns/[id]": [
    "Find a campaign named Viewings",
    "Read this campaign queue",
    "Show the CSV upload control"
  ],
  "/leads": [
    "Open leads",
    "Find a lead named Alex",
    "Read the lead list"
  ],
  "/calls": [
    "Open calls",
    "Show my call history",
    "Read the call list"
  ],
  "/leads/[id]": [
    "Find a lead named Alex",
    "Open the second matching lead",
    "Read this lead status"
  ],
  "/calls/[id]": [
    "Find calls for Alex",
    "Open the first matching call",
    "Read this call summary"
  ],
  "/numbers": [
    "Show phone numbers",
    "Read the number assignments",
    "Show available number actions"
  ],
  "/jobs": [
    "Open background jobs",
    "Show failed jobs",
    "Read job status"
  ],
  "/settings": [
    "Open settings",
    "Open the Voice copilot tab",
    "Set voice to Ivy"
  ],
  "/operator": [
    "Open the operator area",
    "Show platform readiness",
    "Read provider status"
  ]
};

const APP_FEATURE_TERMS = [
  "Voni",
  "Voice copilot",
  "dashboard",
  "agent",
  "agents",
  "campaign",
  "campaigns",
  "lead",
  "leads",
  "phone numbers",
  "background jobs",
  "settings",
  "workspace",
  "services",
  "appearance",
  "operator",
  "platform readiness",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name === "page.tsx") out.push(full);
  }
  return out;
}

function routeOf(pageFile: string): string | null {
  const rel = pageFile.slice(join(SRC, "app").length);
  const parts = rel.split("/").slice(0, -1).filter((p) => p !== "" && !/^\(.*\)$/.test(p));

  // Local design prototypes are outside tool-enabled product navigation.
  if (parts[0] === "prototypes") return null;
  return `/${parts.join("/")}`;
}

function titleFor(route: string): string {
  const nav = (NAV_ITEMS as Array<{ title: string; url: string }>).find((item) => item.url === route);
  if (nav) return nav.title;
  const titled = (SECTION_TITLES as Array<[string, string]>).find(([prefix]) => prefix === route);
  if (titled) return titled[1];
  const override = TITLE_OVERRIDES[route];
  if (override) return override;
  throw new Error(
    `generate-app-manifest: no title for ${route} — add it to NAV_ITEMS, SECTION_TITLES, or TITLE_OVERRIDES.`,
  );
}

function settingsTabs(): Array<{ value: string; label: string; adminOnly: boolean }> {
  const source = readFileSync(join(SRC, "lib", "settings-tabs.ts"), "utf8");
  const block = source.match(/SETTINGS_TABS = \[([\s\S]*?)\] as const;/)?.[1];
  if (!block) throw new Error("generate-app-manifest: SETTINGS_TABS block not found in lib/settings-tabs.ts.");
  const tabs = [...block.matchAll(/\{\s*value:\s*"([^"]+)",\s*label:\s*"([^"]+)"(,\s*adminOnly:\s*true)?/g)].map(
    (m) => ({ value: m[1], label: m[2], adminOnly: Boolean(m[3]) }),
  );
  if (tabs.length === 0) throw new Error("generate-app-manifest: no tabs parsed from SETTINGS_TABS.");
  return tabs;
}

function build(): string {
  const routes = walk(join(SRC, "app"))
    .map(routeOf)
    .filter((route): route is string => route !== null);
  const destinations = [...new Set(routes)].sort().map((route) => {
    const phrases = PHRASES[route];
    if (!phrases?.length || phrases.some((p) => !p.trim())) {
      throw new Error(
        `generate-app-manifest: no voice phrases for ${route} — add them to PHRASES in scripts/generate-app-manifest.mts.`,
      );
    }
    const access = PUBLIC_ROUTES.has(route) ? "public" : AUTH_ROUTES.has(route) ? "auth" : PLATFORM_ADMIN_ROUTES.has(route) ? "platform-admin" : "signed-in";
    const navigationKind = access === "public" || access === "auth" ? "none" : route.includes("[") ? "record" : "static";
    const title = titleFor(route);
    const examples = EXAMPLES[route];
    if (!examples || examples.length !== 3 || examples.some((e) => !e.trim())) {
      throw new Error(`Missing three example utterances for ${route}`);
    }
    return { route, title, phrases, examples, access, navigationKind };
  });
  const tabs = settingsTabs();
  const lines = [
    "// GENERATED by scripts/generate-app-manifest.mts — do not hand-edit.",
    "// Regenerate with `npm run copilot:manifest`; CI verifies with `npm run copilot:manifest:check`.",
    "",
    "export const APP_MANIFEST_VERSION = 2;",
    "export type AppDestination = { route: string; title: string; phrases: string[]; examples: string[]; access: \"public\" | \"auth\" | \"signed-in\" | \"platform-admin\"; navigationKind: \"none\" | \"static\" | \"record\" };",
    "",
    "export const APP_DESTINATIONS: AppDestination[] = [",
    ...destinations.map((d) => `  ${JSON.stringify(d)},`),
    "];",
    "",
    "/** Static routes voice may navigate to. Dynamic detail pages stay model-proposed, never invented. */",
    `export const NAVIGABLE_ROUTES: string[] = [${destinations.filter((d) => d.navigationKind === "static").map((d) => `"${d.route}"`).join(", ")}];`,
    "",
    "export const SETTINGS_TABS_MANIFEST: Array<{ value: string; label: string; adminOnly: boolean }> = [",
    ...tabs.map((t) => `  { value: "${t.value}", label: "${t.label}", adminOnly: ${t.adminOnly} },`),
    "];",
    "",
    "/** Vocabulary boosts so recognition hears feature names the first time. */",
    `export const APP_FEATURE_TERMS: string[] = [${APP_FEATURE_TERMS.map((t) => `"${t}"`).join(", ")}];`,
    "",
  ];
  return lines.join("\n");
}

const generated = build();
if (process.argv.includes("--check")) {
  const current = readFileSync(OUT, "utf8");
  if (current !== generated) {
    console.error("app-manifest.ts is stale — run `npm run copilot:manifest` and commit the result.");
    process.exit(1);
  }
  console.log("app-manifest.ts is current.");
} else {
  writeFileSync(OUT, generated);
  console.log(`wrote ${OUT}`);
}

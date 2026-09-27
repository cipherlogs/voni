/**
 * Source for the disposable press-kit specimen routes (pass 2/2 raster input).
 *
 * RECIPE: copy this file to `src/app/press-specimen/[shot]/page.tsx`, run
 * `npx tsx scripts/press-wordmark-shots.mts` against `next dev`, then delete
 * `src/app/press-specimen/`. The manifest generator excludes press-specimen
 * permanently. To add a slogan: extend SLOGANS + generateStaticParams here,
 * add the route/out pairs in press-wordmark-shots.mts, and add masters.
 *
 * Chromium shapes the wordmark "oni" + slogans in real Geist (next/font),
 * which sharp alone cannot do (no Geist in fontconfig). Each shot owns its
 * background via inline colors — deterministic at any OS theme.
 *
 * NOTE: this file lives in scripts/ (not src/app/) so the specimen routes
 * never ship to production. Do not move it without adding prod gating.
 */

const V_PATH = "M5 9Q12 24 19 9";

const SLOGANS: Record<string, string> = {
  "work-done": "Every call ends with the work already done",
  "everything-after": "One call, and everything after it.",
  "while-talking": "The work happens while it's still talking.",
};

const SANS = "var(--font-geist-sans), Geist, Inter, system-ui, sans-serif";

type Shot =
  | { kind: "wordmark"; ink: string; bg: string }
  | { kind: "lockup"; slogan: string; ink: string; bg: string }
  | { kind: "og"; slogan: string | null };

function parseShot(shot: string): Shot | null {
  if (shot === "wordmark-light") return { kind: "wordmark", ink: "#0a0a0a", bg: "#ffffff" };
  if (shot === "wordmark-dark") return { kind: "wordmark", ink: "#fafafa", bg: "#000000" };
  const lockup = shot.match(/^lockup-(work-done|everything-after|while-talking)-(light|dark)$/);
  if (lockup) {
    const dark = lockup[2] === "dark";
    return {
      kind: "lockup",
      slogan: SLOGANS[lockup[1]],
      ink: dark ? "#fafafa" : "#0a0a0a",
      bg: dark ? "#000000" : "#ffffff",
    };
  }
  if (shot === "og") return { kind: "og", slogan: null };
  const og = shot.match(/^og-(work-done|everything-after|while-talking)$/);
  if (og) return { kind: "og", slogan: SLOGANS[og[1]] };
  return null;
}

export function generateStaticParams() {
  return [
    "wordmark-light",
    "wordmark-dark",
    "lockup-work-done-light",
    "lockup-work-done-dark",
    "lockup-everything-after-light",
    "lockup-everything-after-dark",
    "lockup-while-talking-light",
    "lockup-while-talking-dark",
    "og",
    "og-work-done",
    "og-everything-after",
    "og-while-talking",
  ].map((shot) => ({ shot }));
}

function Wordmark({ ink, oniSize }: { ink: string; oniSize: number }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        fontFamily: SANS,
        fontWeight: 600,
        fontSize: oniSize,
        letterSpacing: "-0.02em",
        color: ink,
        lineHeight: 1,
      }}
    >
      <svg
        viewBox="3 7 18 11"
        aria-hidden="true"
        style={{
          display: "inline-block",
          height: "0.85em",
          width: "1.39em",
          marginRight: "0.06em",
          transform: "translateY(0.12em)",
        }}
      >
        <path d={V_PATH} fill="none" stroke={ink} strokeWidth={2.75} strokeLinecap="round" />
      </svg>
      oni
    </span>
  );
}

export default async function PressSpecimenPage({ params }: { params: Promise<{ shot: string }> }) {
  const { shot } = await params;
  const parsed = parseShot(shot);
  if (!parsed) return null;

  if (parsed.kind === "og") {
    return (
      <div
        style={{
          width: "1200px",
          height: "100vh",
          minHeight: "630px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "28px",
          backgroundColor: "#ffffff",
          overflow: "hidden",
        }}
      >
        <Wordmark ink="#0a0a0a" oniSize={132} />
        {parsed.slogan ? (
          <span style={{ fontFamily: SANS, fontSize: 36, color: "#0a0a0a" }}>{parsed.slogan}</span>
        ) : null}
      </div>
    );
  }

  const big = parsed.kind === "wordmark";
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: big ? 0 : "40px",
        backgroundColor: parsed.bg,
        overflow: "hidden",
        padding: "120px",
      }}
    >
      <Wordmark ink={parsed.ink} oniSize={220} />
      {parsed.kind === "lockup" ? (
        <span style={{ fontFamily: SANS, fontSize: 56, letterSpacing: "0.01em", color: parsed.ink }}>
          {parsed.slogan}
        </span>
      ) : null}
    </div>
  );
}

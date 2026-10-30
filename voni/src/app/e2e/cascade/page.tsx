import { notFound } from "next/navigation";
import { connection } from "next/server";

import { VoiceCall } from "@/components/voice-call";
import type { AgentConfig } from "@/lib/agents/config";
import { pipelineUrlFromEnv } from "@/lib/voice/pipeline-url";

/**
 * Seam 4's page (ticket 149): the real inline agent call card with the cascade
 * engine, reachable only in the isolated E2E test build.
 *
 * The Playwright spec drives it exactly as a person does (click the call
 * button, hang up) and fakes only the service socket, so the real
 * `CascadeSession`, the real mic path and the real playout worklet all run.
 * `?delivercapture=1` turns on the existing dev tap; the workflow's candidate
 * build opts into that in production mode (`NEXT_PUBLIC_VONI_E2E_CAPTURE`).
 *
 * The pipeline URL is runtime configuration, read here on the server and
 * handed to the client as the derived `wss` URL (ticket 08). There is no
 * build-time public pipeline variable and no localhost fallback: a missing or
 * non-https value fails the page by name, so the rig cannot silently test
 * against nothing.
 *
 * An ordinary production build has no business exposing a test call surface:
 * `VONI_INSTANT_TEST_BUILD` is set only by `scripts/e2e-run.mjs` on its
 * throwaway candidate (next.config.ts gates the testing API the same way), and
 * this page 404s everywhere else.
 */

const E2E_AGENT: AgentConfig = {
  mission: "Drive the cascade browser seam against a deterministic fake service.",
  identity: { name: "Voni", role: "browser seam" },
  detect: [],
  tools: [],
  toolIdeas: [],
  customTools: [],
  knowledge: "",
  channels: ["phone"],
  voiceId: "anna",
  languageCodes: ["en"],
  greeting: "Hi.",
  conversationLanguage: "en",
};

/**
 * The page reads the pipeline URL per request, so it cannot be prerendered.
 * Next 16's Cache Components build wants that stated: without this, the
 * throwaway candidate build fails on this route before the rig can run.
 */
export const instant = false;

export default async function CascadeE2ePage() {
  if (process.env.VONI_INSTANT_TEST_BUILD !== "1") notFound();
  // Read the pipeline URL per request, not once at build: the candidate image
  // must carry no baked-in service address.
  await connection();
  const pipeline = await pipelineUrlFromEnv();
  if (!pipeline.ok) throw new Error(pipeline.error.message);
  return (
    <main
      data-testid="cascade-e2e-shell"
      className="mx-auto flex min-h-dvh w-full max-w-xl flex-col p-6"
    >
      <VoiceCall
        mode={{ kind: "inline", config: E2E_AGENT, agentId: "agent_e2e", isDirty: false }}
        engine="cascade"
        cascadeUrl={pipeline.wsUrl}
        presentation="card"
      />
    </main>
  );
}

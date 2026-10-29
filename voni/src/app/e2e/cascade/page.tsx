import { notFound } from "next/navigation";

import { VoiceCall } from "@/components/voice-call";
import type { AgentConfig } from "@/lib/agents/config";

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

export default function CascadeE2ePage() {
  if (process.env.VONI_INSTANT_TEST_BUILD !== "1") notFound();
  return (
    <main
      data-testid="cascade-e2e-shell"
      className="mx-auto flex min-h-dvh w-full max-w-xl flex-col p-6"
    >
      <VoiceCall
        mode={{ kind: "inline", config: E2E_AGENT, agentId: "agent_e2e", isDirty: false }}
        engine="cascade"
        presentation="card"
      />
    </main>
  );
}

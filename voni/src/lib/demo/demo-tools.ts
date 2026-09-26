import {
  buildEndCallSuccess,
  END_CALL_TOOL,
  END_CALL_VOICE_TOOL,
  validateToolArguments,
  type VoiceTool,
} from "@/lib/tools/definitions";
import type { ToolResponse } from "@/lib/tools/execute";
import { DEMO_INBOX_ADDRESS, DEMO_INBOX_SPOKEN } from "./email-test";

/**
 * The demo agent's tools, run server-side for one verified demo call (the
 * route checks the call token first). Every tool on the stored demo agent
 * body (stored-agents.ts) needs a case here or in the route. Browser-safe:
 * the voice session imports it, so the inbox check (server-only) is
 * dispatched by the route, not here.
 */

export const SHOW_TEST_ADDRESS_TOOL = "show_test_address";
export const CHECK_EMAIL_TOOL = "check_email";

export const SHOW_TEST_ADDRESS_VOICE_TOOL: VoiceTool = {
  type: "function",
  name: SHOW_TEST_ADDRESS_TOOL,
  description:
    "Put your test inbox address on the caller's screen as a tap-to-copy chip. Call it the moment you invite the caller to send you an email from their work address, then say the address once.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  execution_mode: "interactive",
  timeout_seconds: 5,
};

export const CHECK_EMAIL_VOICE_TOOL: VoiceTool = {
  type: "function",
  name: CHECK_EMAIL_TOOL,
  description:
    "Look for the caller's email in your busy test inbox. Call it as soon as the caller tells you which address they sent from, and again whenever they correct it or give another one.",
  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        maxLength: 200,
        examples: ["andres@casaverde-realty.com"],
        description: "The email address the caller says they sent from, exactly as you heard it.",
      },
    },
    required: ["address"],
    additionalProperties: false,
  },
  execution_mode: "interactive",
  timeout_seconds: 15,
};

/** Every tool the demo agent carries, in stored-body order. */
export const DEMO_VOICE_TOOLS: VoiceTool[] = [
  END_CALL_VOICE_TOOL,
  SHOW_TEST_ADDRESS_VOICE_TOOL,
  CHECK_EMAIL_VOICE_TOOL,
];

export async function executeDemoTool(name: string, rawArguments: unknown): Promise<ToolResponse> {
  if (name === SHOW_TEST_ADDRESS_TOOL) {
    return {
      ok: true,
      data: {
        shown: true,
        address: DEMO_INBOX_ADDRESS,
        instructions: `The address is on their screen now. Say it once, as '${DEMO_INBOX_SPOKEN}', and tell them to let you know when it's sent.`,
      },
    };
  }
  if (name !== END_CALL_TOOL) {
    return { ok: false, error: "Unknown tool.", retryable: false };
  }
  const parsed = validateToolArguments(name, rawArguments);
  if (!parsed.ok) {
    return { ok: false, error: "Say the closing line first, then end the call.", retryable: true };
  }
  return buildEndCallSuccess(false);
}

import {
  buildEndCallSuccess,
  END_CALL_TOOL,
  END_CALL_VOICE_TOOL,
  validateToolArguments,
  type VoiceTool,
} from "@/lib/tools/definitions";
import type { ToolResponse } from "@/lib/tools/execute";
import { DEMO_INBOX_ADDRESS } from "./email-test";

/**
 * The demo agent's tools, run server-side for one verified demo call (the
 * route checks the call token first). Every tool on the stored demo agent
 * body (stored-agents.ts) needs a case here or in the route. Browser-safe:
 * the voice session imports it, so the inbox check, the reply and the code
 * check (server-only) are dispatched by the route, not here.
 */

export const SHOW_TEST_ADDRESS_TOOL = "show_test_address";
export const CHECK_EMAIL_TOOL = "check_email";

export const SHOW_TEST_ADDRESS_VOICE_TOOL: VoiceTool = {
  type: "function",
  name: SHOW_TEST_ADDRESS_TOOL,
  description:
    "Put your test inbox address and the caller's test tag on their screen. Call it the moment you invite the caller to send you an email from their work address; the result tells you the tag to say.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  execution_mode: "interactive",
  // Interactive results reach the model only when its reply finishes, and the
  // invite reply is often 10s long: a short timeout made the model give up and
  // invent an address (sess_c477d8f8).
  timeout_seconds: 30,
};

export const CHECK_EMAIL_VOICE_TOOL: VoiceTool = {
  type: "function",
  name: CHECK_EMAIL_TOOL,
  description:
    "Look for the caller's email in your busy test inbox. Call it when the caller says they've sent it (no address needed: their test tag finds it), and again with an address only if the caller forgot the tag and told you which address they sent from.",
  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        maxLength: 200,
        examples: ["andres@casaverde-realty.com"],
        description:
          "Only when the caller forgot the tag: the address they said they sent from, exactly as you heard it. Leave it out otherwise; never a placeholder.",
      },
    },
    additionalProperties: false,
  },
  execution_mode: "interactive",
  timeout_seconds: 30,
};

export const SEND_CODE_REPLY_TOOL = "send_code_reply";
export const CHECK_CODE_TOOL = "check_code";

export const SEND_CODE_REPLY_VOICE_TOOL: VoiceTool = {
  type: "function",
  name: SEND_CODE_REPLY_TOOL,
  description:
    "Reply to the caller's email with a code to test things out. Call it once their email is found, after asking their first name if you don't know it. Say you're writing and sending it as you call it; it is sent only when the result says so.",
  parameters: {
    type: "object",
    properties: {
      warm_line: {
        type: "string",
        maxLength: 300,
        description:
          "One short, warm sentence of your own for the email, about their business, in the caller's language. No codes, links, or security words.",
      },
      name: {
        type: "string",
        maxLength: 40,
        description: "Their first name, only if they told you. Leave it out otherwise.",
      },
    },
    required: ["warm_line"],
    additionalProperties: false,
  },
  execution_mode: "interactive",
  timeout_seconds: 30,
};

export const CHECK_CODE_VOICE_TOOL: VoiceTool = {
  type: "function",
  name: CHECK_CODE_TOOL,
  description:
    "Check the code the caller read back from your reply email. They get two tries; the result says what to do next.",
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        maxLength: 40,
        examples: ["4821"],
        description: "The four digits the caller read, as numerals.",
      },
    },
    required: ["code"],
    additionalProperties: false,
  },
  execution_mode: "interactive",
  timeout_seconds: 30,
};

/** Every tool the demo agent carries, in stored-body order. */
export const DEMO_VOICE_TOOLS: VoiceTool[] = [
  END_CALL_VOICE_TOOL,
  SHOW_TEST_ADDRESS_VOICE_TOOL,
  CHECK_EMAIL_VOICE_TOOL,
  SEND_CODE_REPLY_VOICE_TOOL,
  CHECK_CODE_VOICE_TOOL,
];

export async function executeDemoTool(
  name: string,
  rawArguments: unknown,
  ctx: { testTag?: string | null } = {},
): Promise<ToolResponse> {
  if (name === SHOW_TEST_ADDRESS_TOOL) {
    if (!ctx.testTag) return { ok: false, error: "No test tag on this call.", retryable: false };
    return {
      ok: true,
      data: {
        shown: true,
        address: DEMO_INBOX_ADDRESS,
        testTag: ctx.testTag,
        instructions: `The address and the tag "${ctx.testTag}" are on their screen now. Don't invite them yet: a note follows with the exact invite. At most, say one short word like "There."`,
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

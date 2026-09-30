import { expect, type Page, type Route, type WebSocketRoute } from "@playwright/test";

/**
 * Shared fakes for the demo call specs: AssemblyAI as a fake socket, the
 * call-scoped routes mocked, and a started call.
 */

export const DEMO_TEST_USE = {
  permissions: ["microphone", "clipboard-read", "clipboard-write"],
  ignoreHTTPSErrors: true,
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  },
};

export type Frame = Record<string, unknown> & { type: string };
export const TAG = "Lime 42";

/** `onFrame` sees each frame the page sends (a test can play the platform's part). */
export async function fakeServer(page: Page, onFrame?: (msg: Frame) => void) {
  const frames: Frame[] = [];
  let ws: WebSocketRoute | null = null;
  await page.routeWebSocket(/agents\.assemblyai\.com/, (socket) => {
    ws = socket;
    socket.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as Frame;
      if (msg.type === "input.audio") return;
      frames.push(msg);
      if (msg.type === "session.update") {
        const session = msg.session as Record<string, unknown>;
        socket.send(JSON.stringify(session.agent_id ? { type: "session.ready", session_id: "sess_1" } : { type: "session.updated" }));
      }
      onFrame?.(msg);
    });
  });
  let reply = 0;
  const say = (msg: Record<string, unknown>) => ws?.send(JSON.stringify(msg));
  return {
    frames,
    say,
    ready: () => ws !== null && frames.some((f) => f.type === "session.update"),
    replyCreates: () => frames.filter((f) => f.type === "reply.create").map((f) => String(f.instructions)),
    toolResults: () =>
      frames.filter((f) => f.type === "tool.result").map((f) => ({ callId: String(f.call_id), result: JSON.parse(String(f.result)) })),
    /** One agent reply that calls a tool and speaks for `speakMs` (results go back at once, ADR 0005). */
    toolCall: async (name: string, args: Record<string, unknown> = {}, speakMs = 0) => {
      const id = `r${(reply += 1)}`;
      say({ type: "reply.started", reply_id: id });
      say({ type: "tool.call", call_id: `call_${id}`, name, arguments: args });
      say({ type: "transcript.agent", reply_id: id, text: "Let's try something real." });
      if (speakMs) await new Promise((resolve) => setTimeout(resolve, speakMs));
      say({ type: "reply.done", reply_id: id, status: "completed" });
      return `call_${id}`;
    },
  };
}

export type Mocks = {
  /** Answer for a check_email request (the poll or the model's own call). */
  check: (args: Record<string, unknown>) => Record<string, unknown>;
  carried?: boolean;
};

export async function mockApis(page: Page, mocks: Mocks) {
  const toolCalls: { name: string; args: Record<string, unknown>; toolCallId: string }[] = [];
  const tokenBodies: Record<string, unknown>[] = [];
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, json: { error: "offline in e2e" } }));
  await page.route("**/api/demo/token", (route) => {
    tokenBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({
      json: { token: "tok", agentId: "agent_demo", callToken: "call-tok", testTag: TAG, tagToken: "tag-tok", tagCarried: mocks.carried === true },
    });
  });
  await page.route("**/api/demo/tools/*", (route: Route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
    const body = route.request().postDataJSON() as { toolCallId: string; arguments: Record<string, unknown> };
    toolCalls.push({ name, args: body.arguments, toolCallId: body.toolCallId });
    if (name === "show_test_address") {
      return route.fulfill({
        json: { ok: true, data: { shown: true, address: "test@voni.cc", testTag: TAG, instructions: `Say "${TAG}".` } },
      });
    }
    return route.fulfill({ json: mocks.check(body.arguments) });
  });
  return { toolCalls, tokenBodies, polls: () => toolCalls.filter((c) => c.toolCallId === "inbox-poll") };
}

export const notArrived = { ok: true, data: { status: "not_arrived", instructions: "Not yet." } };
export const found = (extra: Record<string, unknown> = {}) => ({
  ok: true,
  data: { status: "found", address: "andres@casaverde.pt", name: "Andres", exact: true, instructions: "Found it.", ...extra },
});
export const free = { ok: true, data: { status: "free", address: "nidal@gmail.com", instructions: "Gate." } };

export async function startCall(page: Page, server: Awaited<ReturnType<typeof fakeServer>>) {
  await page.goto("/");
  // A click that lands before hydration does nothing: click again, as a person would.
  const start = page.getByRole("button", { name: /^start call$/i }).filter({ visible: true }).first();
  await expect(async () => {
    if (!server.ready()) await start.click({ timeout: 1000 }).catch(() => undefined);
    await expect.poll(server.ready, { timeout: 3000 }).toBe(true);
  }).toPass({ timeout: 20_000 });
}


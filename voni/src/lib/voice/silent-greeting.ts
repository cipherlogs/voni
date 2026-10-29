/**
 * The one way to hear a voice outside a conversation.
 *
 * AssemblyAI has no standalone text-to-speech endpoint: every utterance is
 * rendered inside a live Voice Agent session. A session that is told to stay
 * silent and gives the line as its greeting speaks exactly that line, once,
 * with no model in the path — which is what makes it a reference rather than
 * a sample of some reply.
 *
 * Two callers share it: the demo scoreboard's fixed caller clips
 * (`scripts/eval-demo-agent.mts`) and the W0 reference capture
 * (`scripts/render-reference.mts`). Sharing the payload keeps a capture from
 * drifting away from the clips the calls are measured against.
 *
 * NATIVE LEVEL BY CONSTRUCTION: the session carries `output.voice` and
 * nothing else — no `output.volume`, no gain, no limiter. A reference is the
 * voice as the vendor renders it, and any level processing here would make
 * the comparison measure our processing instead.
 */

export type SilentGreetingRequest = {
  voiceId: string;
  text: string;
};

/** Wire payload for one silent greeting, at the voice's native level. */
export function silentGreetingSession({ voiceId, text }: SilentGreetingRequest) {
  return {
    type: "session.update",
    session: {
      system_prompt: "Stay silent.",
      greeting: text,
      output: { voice: voiceId },
    },
  };
}

export const VOICE_AGENT_WS = "wss://agents.assemblyai.com/v1/ws";

/** The subset of `WebSocket` this path uses; tests substitute a fake. */
export type GreetingSocket = {
  addEventListener(type: "open" | "message" | "error", listener: (event: { data: unknown }) => void): void;
  send(data: string): void;
  close(): void;
};

export const GREETING_TIMEOUT_MS = 25_000;

/**
 * Speak `text` in `voiceId` and return the raw reply audio (PCM16 mono at the
 * session's default 24 kHz). The sockets are injected so a unit test can prove
 * the wire contract without a live call.
 */
export async function collectSilentGreeting(opts: {
  voiceId: string;
  text: string;
  token: string;
  timeoutMs?: number;
  socketFactory?: (url: string) => GreetingSocket;
}): Promise<Buffer> {
  const url = `${VOICE_AGENT_WS}?token=${opts.token}`;
  const socket = (opts.socketFactory ?? ((target: string) => new WebSocket(target) as unknown as GreetingSocket))(
    url,
  );
  const chunks: Buffer[] = [];
  try {
    const pcm = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("speech timed out")),
        opts.timeoutMs ?? GREETING_TIMEOUT_MS,
      );
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify(silentGreetingSession({ voiceId: opts.voiceId, text: opts.text })));
      });
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as { type?: string; data?: string };
        if (message.type === "reply.audio" && message.data) chunks.push(Buffer.from(message.data, "base64"));
        if (message.type === "reply.done") {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks));
        }
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("speech socket error"));
      });
    });
    socket.send(JSON.stringify({ type: "session.end" }));
    return pcm;
  } finally {
    // A failed greeting closes without pretending to end a session that never
    // started; the error that got us here is the one worth reporting.
    socket.close();
  }
}

import {
  CASCADE_PROTOCOL_VERSION,
  type CascadeCallConfig,
} from "./cascade-session";
import { demoMint, type DemoMint, type DemoMintFetcher } from "./demo-mint";
import type { ResumeMessage } from "./resume-history";

/**
 * The demo's cascade start (demo-cascade ticket 10).
 *
 * A demo visitor's click mints once (the one door, ticket 09) and then starts
 * the real `CascadeSession` with the minted identity: the pipeline WebSocket
 * URL, the cascade call token, the demo subject and the protocol version.
 * There is no managed session on this path and no engine choice — the demo is
 * cascade-only.
 *
 * The sequence is a pure function of its injected mint and the session object
 * the caller already created, so a unit test can prove the identity on the
 * wire and a second start after hang-up without a live socket. A mint
 * refusal propagates untouched: the caller renders its 429 countdown or its
 * 503 unavailable line and never opens a managed call.
 */

/** The one method the demo start needs; the real `CascadeSession` satisfies it. */
export type DemoCascadeCall = {
  start(config: CascadeCallConfig, micOwner?: string): Promise<void>;
};

export type DemoStartInput = {
  /** The picked demo voice; the mint turns it into `demo:<voice>`. */
  voiceId: string;
  /** A hold rejoin continues the same call; a fresh visit is false. */
  resume: boolean;
  /** The carried demo call token (rejoin only), never the cascade token. */
  callToken?: string;
  /** The visitor's Test tag, kept a day by the browser. */
  tagToken?: string;
  /** The hold return's bounded recent turns, already in conversation order. */
  history?: readonly ResumeMessage[];
};

export type DemoStartDeps = {
  /** Injected for tests; the mint fetcher otherwise. */
  mint?: DemoMintFetcher;
  /**
   * Called between the mint and the socket start, so a mark can name the mint
   * before any socket or microphone event lands.
   */
  onMinted?: (minted: DemoMint) => void;
};

/**
 * The cascade config the browser is allowed to send: identity only. Built
 * explicitly from the minted response, so a stray field on the response can
 * never reach the wire.
 */
export function demoCascadeConfig(minted: DemoMint): CascadeCallConfig {
  return {
    serviceUrl: minted.wsUrl,
    callToken: minted.callToken,
    agentId: minted.agentId,
    protocolVersion: CASCADE_PROTOCOL_VERSION,
  };
}

/**
 * Mint one demo call and start the cascade client on it. Must run inside the
 * visitor's click: `CascadeSession.start` acquires the mic and audio graph.
 */
export async function startDemoCall(
  call: DemoCascadeCall,
  input: DemoStartInput,
  deps: DemoStartDeps = {},
): Promise<DemoMint> {
  const mint = deps.mint ?? demoMint;
  const minted = await mint(input.voiceId, {
    ...(input.resume === true ? { resume: true } : {}),
    ...(input.callToken ? { callToken: input.callToken } : {}),
    ...(input.tagToken ? { tagToken: input.tagToken } : {}),
    ...(input.resume === true && input.history && input.history.length > 0
      ? { history: input.history }
      : {}),
  });
  deps.onMinted?.(minted);
  await call.start(demoCascadeConfig(minted), "voice-call");
  return minted;
}

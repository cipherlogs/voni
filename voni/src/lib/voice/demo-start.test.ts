import test from "node:test";
import assert from "node:assert/strict";

import {
  CASCADE_PROTOCOL_VERSION,
  CascadeSession,
  buildConfigMessage,
  type CascadeCallConfig,
} from "./cascade-session";
import { DEMO_MINT_FIELDS, type DemoMint } from "./demo-mint";
import { startDemoCall, type DemoCascadeCall } from "./demo-start";

/**
 * The demo start (demo-cascade ticket 10) at its injected seams: the mint is a
 * fake, the session is either a recording fake or the real `CascadeSession`
 * over a fake socket. No live socket, no server, no managed session.
 */

const WS = "wss://pipeline.example.com/v1/browser-call";

function minted(n: number): DemoMint {
  return {
    engine: "cascade",
    wsUrl: WS,
    agentId: "demo:audrey",
    callToken: `ct1.call-${n}`,
    demoCallToken: `demo-call-${n}.1761771700.tag-${n}.mac`,
    testTag: `Lime ${n}`,
    tagToken: `tag-token-${n}`,
    tagCarried: n > 1,
    maxSessionSeconds: 720,
  };
}

type StartRecord = { config: CascadeCallConfig; owner?: string };

function recordingSession(): DemoCascadeCall & {
  records: StartRecord[];
  stopped: boolean;
  stop: () => Promise<void>;
} {
  const records: StartRecord[] = [];
  const session = {
    records,
    stopped: false,
    async start(config: CascadeCallConfig, owner?: string) {
      records.push({ config, ...(owner === undefined ? {} : { owner }) });
    },
    async stop() {
      session.stopped = true;
    },
  };
  return session;
}

test("the demo starts the cascade with exactly the minted identity", async () => {
  const mints: Array<{ voiceId: string; opts?: unknown }> = [];
  const session = recordingSession();
  const first = minted(1);

  const result = await startDemoCall(
    session,
    { voiceId: "audrey", resume: false, tagToken: "browser-tag-token" },
    {
      mint: async (voiceId, opts) => {
        mints.push({ voiceId, ...(opts === undefined ? {} : { opts }) });
        return first;
      },
    },
  );

  assert.deepEqual(result, first);
  assert.deepEqual(mints, [
    { voiceId: "audrey", opts: { tagToken: "browser-tag-token" } },
  ]);
  assert.equal(session.records.length, 1);
  assert.deepEqual(session.records[0].config, {
    serviceUrl: first.wsUrl,
    callToken: first.callToken,
    agentId: first.agentId,
    protocolVersion: CASCADE_PROTOCOL_VERSION,
  });
  assert.equal(session.records[0].owner, "voice-call");

  // The demo call token authorizes the tool/judge routes; it is never the
  // cascade connect credential.
  assert.notEqual(session.records[0].config.callToken, first.demoCallToken);
  assert.equal(
    JSON.stringify(session.records[0].config).includes(first.demoCallToken),
    false,
    "the demo call token never reaches the cascade",
  );
  assert.deepEqual(
    Object.keys(JSON.parse(buildConfigMessage(session.records[0].config))).sort(),
    ["agentId", "callToken", "protocolVersion", "type"],
    "the wire is identity only",
  );
});

test("the real cascade client opens the minted URL and sends identity only", async () => {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const session = new CascadeSession(
    {},
    {
      socketFactory: (url) => {
        urls.push(url);
        const socket = makeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      startMic: async () => ({ stop: () => {} }),
      createPlayout: () => ({ play: () => {}, flush: () => {} }),
    },
  );

  const first = minted(1);
  await startDemoCall(
    session,
    { voiceId: "audrey", resume: false },
    { mint: async () => first },
  );

  assert.deepEqual(urls, [first.wsUrl], "the minted URL is the one connected");
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].sent.length, 0, "nothing is sent before the socket opens");

  sockets[0].readyState = sockets[0].OPEN;
  sockets[0].onopen?.();

  assert.equal(sockets[0].sent.length, 1);
  const wire = JSON.parse(sockets[0].sent[0]);
  assert.deepEqual(wire, {
    type: "config",
    protocolVersion: CASCADE_PROTOCOL_VERSION,
    agentId: first.agentId,
    callToken: first.callToken,
  });
  assert.deepEqual(Object.keys(wire).sort(), [
    "agentId",
    "callToken",
    "protocolVersion",
    "type",
  ]);
  assert.equal("systemPrompt" in wire, false, "no prompt on the wire");
  assert.equal("tools" in wire, false, "no tool list on the wire");
  assert.equal("pipeline" in wire, false, "no pipeline configuration on the wire");

  await session.stop();
});

test("a hold return mints a fresh call token for the same call and carries history", async () => {
  const mints: Array<{ voiceId: string; opts?: unknown }> = [];
  const session = recordingSession();
  const history = [
    { role: "user" as const, content: "We run a bakery." },
    { role: "assistant" as const, content: "What is your busiest hour?" },
  ];

  await startDemoCall(
    session,
    {
      voiceId: "audrey",
      resume: true,
      callToken: "demo-call-1.1761771700.tag-1.mac",
      history,
    },
    {
      mint: async (voiceId, opts) => {
        mints.push({ voiceId, ...(opts === undefined ? {} : { opts }) });
        return minted(2);
      },
    },
  );

  assert.deepEqual(mints[0].opts, {
    resume: true,
    callToken: "demo-call-1.1761771700.tag-1.mac",
    history,
  });
  assert.equal(session.records[0].config.callToken, "ct1.call-2", "the cascade token is fresh");
});

test("a second start after hang-up is a fresh cascade call", async () => {
  let n = 0;
  const mint = async () => minted(++n);
  const first = recordingSession();
  const second = recordingSession();

  await startDemoCall(first, { voiceId: "audrey", resume: false }, { mint });
  await first.stop();
  await startDemoCall(second, { voiceId: "audrey", resume: false }, { mint });

  assert.equal(first.stopped, true, "the first call is hung up");
  assert.equal(first.records.length, 1);
  assert.equal(second.records.length, 1, "the second start opens one fresh call");
  assert.equal(first.records[0].config.callToken, "ct1.call-1");
  assert.equal(second.records[0].config.callToken, "ct1.call-2");
  assert.notEqual(
    second.records[0].config.callToken,
    first.records[0].config.callToken,
    "a new call gets a new token, never the old one",
  );
});

test("the minted demo response has exactly the nine route fields", () => {
  const value = minted(1);
  assert.deepEqual(Object.keys(value).sort(), [...DEMO_MINT_FIELDS].sort());
});

type FakeSocket = {
  sent: string[];
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  closed: boolean;
  readyState: number;
  OPEN: number;
  send(message: string): void;
  close(): void;
};

function makeSocket(): FakeSocket {
  const socket: FakeSocket = {
    sent: [],
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    closed: false,
    readyState: 0,
    OPEN: 1,
    send(message: string) {
      socket.sent.push(message);
    },
    close() {
      socket.closed = true;
    },
  };
  return socket;
}

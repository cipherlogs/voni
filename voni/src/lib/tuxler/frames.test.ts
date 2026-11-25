/**
 * The relay's framing, locked to golden frames taken from the probe.
 *
 * Two facts make this a real target, not decoration: the server writes UTF-16LE
 * while the client writes one byte per character (latin-1), and a UTF-16 code
 * unit can straddle two reads. A reader that gets either wrong hands the session
 * a frame with a corrupt tag, which the state machine sees as a protocol error.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import {
  ControlReader,
  encodeClientFrame,
  encodeServerFrame,
  parseFrame,
  type Frame,
} from "./frames";

/** Wire frames recorded while the probe ran against the real relay. */
const GOLDEN: Record<string, { raw: string; frame: Frame }> = {
  connectList: {
    raw: "<message>CONNECT_LIST<details>3;5;7;</details></message>",
    frame: { tag: "CONNECT_LIST", details: "3;5;7;" },
  },
  makeTest: {
    raw: "<message>MAKE_TEST_1<details><CONNECTION><host>example.test</host><port>80</port><match>OKEXT</match><sendmessage>GET / HTTP/1.0\r\n\r\n</sendmessage></CONNECTION></details></message>",
    frame: {
      tag: "MAKE_TEST_1",
      details:
        "<CONNECTION><host>example.test</host><port>80</port><match>OKEXT</match><sendmessage>GET / HTTP/1.0\r\n\r\n</sendmessage></CONNECTION>",
    },
  },
  secondConnection: {
    raw: "<message>MAKE_SECOND_CONNECTION<details>8000</details></message>",
    frame: { tag: "MAKE_SECOND_CONNECTION", details: "8000" },
  },
  loginFinished: {
    raw: "<message>LOGIN_FINISHED<details></details></message>",
    frame: { tag: "LOGIN_FINISHED", details: "" },
  },
  timeval: {
    raw: "<message>TIMEVAL<details>60</details></message>",
    frame: { tag: "TIMEVAL", details: "60" },
  },
  yourIp: {
    raw: "<message>YOUR_IP<details><location><ip>203.0.113.9</ip><country>United States</country><countryiso>US</countryiso><city>Dallas</city></location></details></message>",
    frame: {
      tag: "YOUR_IP",
      details:
        "<location><ip>203.0.113.9</ip><country>United States</country><countryiso>US</countryiso><city>Dallas</city></location>",
    },
  },
  limitsInfo: {
    raw: '<message>LIMITS_INFO<details>{"ipLocationChangesLimit":10,"ipLocationPoolLimit":50}</details></message>',
    frame: {
      tag: "LIMITS_INFO",
      details: '{"ipLocationChangesLimit":10,"ipLocationPoolLimit":50}',
    },
  },
  resetInfo: {
    raw: "<message>RESET_INFO<details>2026-11-26T08:26:00-05:00</details></message>",
    frame: { tag: "RESET_INFO", details: "2026-11-26T08:26:00-05:00" },
  },
};

test("parseFrame splits every golden server frame into tag and details", () => {
  for (const [name, golden] of Object.entries(GOLDEN)) {
    assert.deepEqual(parseFrame(golden.raw), golden.frame, name);
  }
});

test("parseFrame keeps the whole body when a frame carries no details", () => {
  assert.deepEqual(parseFrame("<message>PING</message>"), {
    tag: "PING",
    details: "",
  });
});

test("parseFrame ends details at the frame's own terminator, not an inner one", () => {
  const raw =
    "<message>SHOW_MESSAGE<details><a><details>inner</details></a><b>1</b></details></message>";
  assert.deepEqual(parseFrame(raw), {
    tag: "SHOW_MESSAGE",
    details: "<a><details>inner</details></a><b>1</b>",
  });
});

test("parseFrame tolerates a byte-order mark before the frame", () => {
  assert.deepEqual(parseFrame("\uFEFF" + GOLDEN.timeval.raw), GOLDEN.timeval.frame);
});

test("client frames go out one byte per character, latin-1", () => {
  const encoded = encodeClientFrame("LOGIN", "LOGIN:a@b.test;NAME:;PASSWORD:pw;;SYSINFO:;VERSION:6;");
  assert.equal(
    encoded.toString("latin1"),
    "<message>LOGIN<details>LOGIN:a@b.test;NAME:;PASSWORD:pw;;SYSINFO:;VERSION:6;</details></message>",
  );
  assert.equal(encoded.length, encoded.toString("latin1").length);
  assert.equal(
    encodeClientFrame("I_AM_ALIVE").toString("latin1"),
    "<message>I_AM_ALIVE<details></details></message>",
  );
});

test("server frames are UTF-16LE, two bytes per character", () => {
  const encoded = encodeServerFrame("TIMEVAL", "60");
  assert.equal(encoded.toString("utf16le"), GOLDEN.timeval.raw);
  assert.equal(encoded.length, GOLDEN.timeval.raw.length * 2);
});

function readerOn(socket: PassThrough) {
  return new ControlReader(socket);
}

test("a frame split across two reads at an odd byte boundary is reassembled", async () => {
  const socket = new PassThrough();
  const reader = readerOn(socket);
  const bytes = encodeServerFrame("TIMEVAL", "60");
  socket.write(bytes.subarray(0, 7));
  await new Promise((resolve) => setTimeout(resolve, 20));
  socket.write(bytes.subarray(7));
  assert.deepEqual(await reader.nextFrame(500), GOLDEN.timeval.frame);
  reader.destroy();
});

test("several frames in one read are delivered in order", async () => {
  const socket = new PassThrough();
  const reader = readerOn(socket);
  socket.write(
    Buffer.concat([
      encodeServerFrame("TIMEVAL", "60"),
      encodeServerFrame("YOUR_IP", "<location><ip>203.0.113.9</ip></location>"),
    ]),
  );
  assert.deepEqual(await reader.nextFrame(500), GOLDEN.timeval.frame);
  assert.equal((await reader.nextFrame(500)).tag, "YOUR_IP");
  reader.destroy();
});

test("a stream that opens with a byte-order mark still yields clean frames", async () => {
  const socket = new PassThrough();
  const reader = readerOn(socket);
  socket.write(
    Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      encodeServerFrame("TIMEVAL", "60"),
    ]),
  );
  assert.deepEqual(await reader.nextFrame(500), GOLDEN.timeval.frame);
  reader.destroy();
});

test("the echo block is counted in raw bytes and its <SEND> request is readable", async () => {
  const socket = new PassThrough();
  const reader = readerOn(socket);
  const block = Buffer.from(
    "ECHO_START" +
      "x".repeat(50_000 - "ECHO_START".length - "<SEND>50000</SEND>".length) +
      "<SEND>50000</SEND>",
    "latin1",
  );
  assert.equal(block.length, 50_000);
  reader.enterRawMode(50_000);
  socket.write(block.subarray(0, 33_333));
  await new Promise((resolve) => setTimeout(resolve, 10));
  socket.write(block.subarray(33_333));
  const echo = await reader.rawBytes(1_000);
  assert.equal(echo.length, 50_000);
  assert.match(echo.toString("latin1"), /<SEND>50000<\/SEND>/);
  reader.destroy();
});

test("a frame that arrives with the tail of the echo block is not swallowed", async () => {
  const socket = new PassThrough();
  const reader = readerOn(socket);
  reader.enterRawMode(50_000);
  socket.write(
    Buffer.concat([
      Buffer.alloc(50_000, 0x78),
      encodeServerFrame("MAKE_SECOND_CONNECTION", "8000"),
    ]),
  );
  await reader.rawBytes(1_000);
  assert.deepEqual(await reader.nextFrame(500), GOLDEN.secondConnection.frame);
  reader.destroy();
});

test("a socket that closes without a frame rejects instead of hanging", async () => {
  const socket = new PassThrough();
  const reader = readerOn(socket);
  const pending = reader.nextFrame(2_000);
  socket.destroy();
  await assert.rejects(pending, /closed/i);
});

test("a silent socket rejects on the frame timeout", async () => {
  const socket = new PassThrough();
  const reader = readerOn(socket);
  await assert.rejects(reader.nextFrame(30), /timed out/i);
  reader.destroy();
});

test("unshift puts a peeked frame back in front of the queue", async () => {
  const socket = new PassThrough();
  const reader = readerOn(socket);
  const first = await Promise.resolve(reader);
  assert.ok(first);
  socket.write(encodeServerFrame("CONNECT_LIST", "3;"));
  const peeked = await reader.nextFrame(500);
  reader.unshift(peeked);
  assert.deepEqual(await reader.nextFrame(500), peeked);
  reader.destroy();
});

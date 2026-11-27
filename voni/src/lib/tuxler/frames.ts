/**
 * The relay's wire framing, in one place.
 *
 * The relay is asymmetric on purpose: it writes UTF-16LE code units, we write one
 * byte per character (latin-1), and frames are delimited by the literal
 * `</message>` with a `<message><details>…</details>` split. Everything above this
 * file — the session, the health report, the pool — talks in `Frame`s, never bytes.
 */
import { Duplex } from "node:stream";

export interface Frame {
  tag: string;
  details: string;
}

const MESSAGE_OPEN = "<message>";
const MESSAGE_CLOSE = "</message>";
const DETAILS_OPEN = "<details>";

/**
 * Split one wire frame. `details` ends at the frame's own terminator, so a payload
 * that contains a nested `<details>` keeps all of it.
 */
export function parseFrame(raw: string): Frame {
  const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const messageAt = body.indexOf(MESSAGE_OPEN);
  const detailsAt = body.indexOf(DETAILS_OPEN);
  const tagStart = messageAt === -1 ? 0 : messageAt + MESSAGE_OPEN.length;
  if (detailsAt === -1) {
    const tag = body.slice(tagStart).replace(MESSAGE_CLOSE, "").trim();
    return { tag, details: "" };
  }
  const closeAt = body.lastIndexOf("</details>");
  return {
    tag: body.slice(tagStart, detailsAt),
    details: body.slice(detailsAt + DETAILS_OPEN.length, closeAt === -1 ? undefined : closeAt),
  };
}

/** Client → relay text is one byte per character; the relay reads it as latin-1. */
export function encodeClientFrame(tag: string, details = ""): Buffer {
  return Buffer.from(
    `${MESSAGE_OPEN}${tag}${DETAILS_OPEN}${details}</details>${MESSAGE_CLOSE}`,
    "latin1",
  );
}

/** Relay → client text is UTF-16LE, two bytes per code unit. */
export function encodeServerFrame(tag: string, details = ""): Buffer {
  return Buffer.from(
    `${MESSAGE_OPEN}${tag}${DETAILS_OPEN}${details}</details>${MESSAGE_CLOSE}`,
    "utf16le",
  );
}

/** The echo stage counts raw bytes, so the relay's 50 KB block is single-byte. */
export function encodeRawBlock(text: string): Buffer {
  return Buffer.from(text, "latin1");
}

export interface ControlReaderOptions {
  /** Applied when a caller does not pass its own timeout. */
  frameTimeoutMs?: number;
}

/**
 * Reads one control socket. Holds the odd trailing byte between reads, because a
 * UTF-16 code unit can straddle them, and switches to raw byte counting for the
 * 50 KB echo — carrying whatever arrived after the echo target back into the text
 * path, so a frame sent in the same TCP segment is not lost.
 */
export class ControlReader {
  private pending = Buffer.alloc(0);
  private text = "";
  private frames: Frame[] = [];
  private raw = false;
  private rawBuf = Buffer.alloc(0);
  private rawTarget = 0;
  private waiters: Array<() => void> = [];
  private closeListeners = new Set<() => void>();
  private closed = false;
  private readonly defaultTimeoutMs: number;
  private readonly onDataBound = (chunk: Buffer) => this.onData(chunk);
  private readonly onCloseBound = () => this.handleClose();
  private readonly onErrorBound = () => this.handleClose();

  constructor(
    private readonly socket: Duplex,
    options: ControlReaderOptions = {},
  ) {
    this.defaultTimeoutMs = options.frameTimeoutMs ?? 20_000;
    socket.on("data", this.onDataBound);
    socket.on("close", this.onCloseBound);
    socket.on("error", this.onErrorBound);
    if (socket.destroyed) this.handleClose();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onClose(listener: () => void): () => void {
    if (this.closed) {
      listener();
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  destroy(): void {
    this.closed = true;
    this.closeListeners.clear();
    // Release parked readers, don't drop them: a dropped waiter leaves its
    // timeout registered, and the timer then holds the process open after the
    // session is gone (`tuxler-proxy --once` hung for exactly this).
    this.wake();
    this.socket.off("data", this.onDataBound);
    this.socket.off("close", this.onCloseBound);
    this.socket.off("error", this.onErrorBound);
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    this.wake();
    for (const listener of listeners) listener();
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  private park(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((entry) => entry !== waiter);
        resolve();
      }, Math.max(1, timeoutMs));
      const waiter = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(waiter);
    });
  }

  private onData(chunk: Buffer): void {
    if (this.raw) {
      const need = this.rawTarget - this.rawBuf.length;
      if (chunk.length < need) {
        this.rawBuf = Buffer.concat([this.rawBuf, chunk]);
        return;
      }
      this.rawBuf = Buffer.concat([this.rawBuf, chunk.subarray(0, need)]);
      const rest = chunk.subarray(need);
      this.raw = false;
      this.wake();
      if (rest.length > 0) this.onText(rest);
      return;
    }
    this.onText(chunk);
  }

  private onText(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk]);
    const evenLength = this.pending.length - (this.pending.length % 2);
    if (evenLength === 0) return;
    const even = this.pending.subarray(0, evenLength);
    this.pending = this.pending.subarray(evenLength);
    let text = even.toString("utf16le");
    // A stream that opens with a byte-order mark decodes it as U+FEFF.
    if (this.text.length === 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    this.text += text;
    let end = this.text.indexOf(MESSAGE_CLOSE);
    while (end !== -1) {
      this.frames.push(parseFrame(this.text.slice(0, end + MESSAGE_CLOSE.length)));
      this.text = this.text.slice(end + MESSAGE_CLOSE.length);
      end = this.text.indexOf(MESSAGE_CLOSE);
    }
    this.wake();
  }

  /** Put a peeked frame back at the front — used by the CONNECT_LIST redirect. */
  unshift(frame: Frame): void {
    this.frames.unshift(frame);
  }

  async nextFrame(timeoutMs = this.defaultTimeoutMs): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = this.frames.shift();
      if (frame) return frame;
      if (this.closed) throw new Error("control socket closed");
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timed out waiting for a frame");
      await this.park(left);
    }
  }

  /** Discard buffered text and count raw bytes until `target` arrived (the echo). */
  enterRawMode(target: number): void {
    this.raw = true;
    this.rawTarget = target;
    this.rawBuf = Buffer.alloc(0);
    this.text = "";
    this.frames = [];
  }

  async rawBytes(timeoutMs = 35_000): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs;
    while (this.rawBuf.length < this.rawTarget) {
      if (this.closed) throw new Error("control socket closed during echo");
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timed out waiting for the echo block");
      await this.park(left);
    }
    return this.rawBuf;
  }
}

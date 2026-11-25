/**
 * Start the Tuxler client and hold it open on a loopback control port.
 *
 * This is the process the runner starts before any Click. It prints the health
 * report — never a credential — and exits non-zero when that report is not a live,
 * logged-in session, so a broken client produces no traffic.
 *
 * Usage:
 *   node --import tsx scripts/tuxler-proxy.mts
 *   node --import tsx scripts/tuxler-proxy.mts --once --port 41000
 *   curl -s http://127.0.0.1:41000/health | jq
 *
 * Environment:
 *   TUXLER_EMAIL | TUXLER_USERNAME      account login
 *   TUXLER_PASSWORD | TUXLER_PASSWD     account password
 *   TUXLER_HOST                         relay entry point, default server1.ipsharkk.com
 *   TUXLER_CONTROL_PORT                 relay control port, default 29990
 *   TUXLER_HEALTH_PORT                  loopback control API port, default 41000
 *   TUXLER_SILENCE_MS                   override the silence deadline (diagnostics)
 */
import { startTuxlerClient, type TuxlerClient } from "../src/lib/tuxler";

interface CliOptions {
  once: boolean;
  port: number;
  host: string;
  controlHost: string;
  controlPort: number;
  silenceMs?: number;
  email: string;
  password: string;
  timeoutMs: number;
}

function readOptions(argv: string[]): CliOptions {
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? undefined : argv[at + 1];
  };
  const silence = flag("silence-ms") ?? process.env.TUXLER_SILENCE_MS;
  return {
    once: argv.includes("--once"),
    port: Number(flag("port") ?? process.env.TUXLER_HEALTH_PORT ?? 41_000),
    host: flag("bind") ?? "127.0.0.1",
    controlHost: flag("relay-host") ?? process.env.TUXLER_HOST ?? "server1.ipsharkk.com",
    controlPort: Number(flag("relay-port") ?? process.env.TUXLER_CONTROL_PORT ?? 29_990),
    silenceMs: silence === undefined ? undefined : Number(silence),
    email: process.env.TUXLER_EMAIL ?? process.env.TUXLER_USERNAME ?? "",
    password: process.env.TUXLER_PASSWORD ?? process.env.TUXLER_PASSWD ?? "",
    timeoutMs: Number(flag("timeout-ms") ?? 45_000),
  };
}

async function withDeadline<T>(work: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function main(): Promise<number> {
  const options = readOptions(process.argv.slice(2));
  let client: TuxlerClient;
  try {
    client = await startTuxlerClient({
      email: options.email,
      password: options.password,
      controlHost: options.controlHost,
      controlPort: options.controlPort,
      silenceMs: options.silenceMs,
      health: { host: options.host, port: options.port },
    });
  } catch (error) {
    console.error(`tuxler-proxy: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  console.log(`tuxler-proxy: serving 127.0.0.1:${new URL(client.url).port}`);

  const settle = async (): Promise<number> => {
    let health;
    try {
      health = await withDeadline(client.settled(), options.timeoutMs, "the first contact with the relay");
    } catch (error) {
      console.error(`tuxler-proxy: ${error instanceof Error ? error.message : String(error)}`);
      health = client.health();
    }
    console.log(JSON.stringify(health, null, 2));
    return health.ok ? 0 : 1;
  };

  const shutdown = async (code: number): Promise<number> => {
    await client.close();
    return code;
  };

  if (options.once) return shutdown(await settle());

  let code = 0;
  const settledCode = await settle();
  if (settledCode !== 0) code = settledCode;

  return new Promise<number>((resolve) => {
    const stop = (): void => {
      void shutdown(code).then(resolve);
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`tuxler-proxy: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });

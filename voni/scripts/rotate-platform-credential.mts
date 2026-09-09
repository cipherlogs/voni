/** Server-only encrypted credential rotation. Secret material is stdin-only. */
import { saveCredential } from "../src/lib/platform/credentials";
import { rotateAccountCredential } from "../src/lib/platform/llm-accounts";
import { isCredentialName } from "../src/lib/platform/types";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readSecretFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error("Pipe the new credential through stdin; secret command-line arguments are rejected.");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (chunks.reduce((sum, item) => sum + item.byteLength, 0) > 64 * 1024) {
      throw new Error("Credential input is too large.");
    }
  }
  const value = Buffer.concat(chunks).toString("utf8").replace(/[\r\n]+$/, "");
  if (!value.trim()) throw new Error("Credential input is empty.");
  return value;
}

async function main() {
  const actor = option("--actor-user-id");
  const service = option("--service");
  const account = option("--llm-account");
  if (!actor || (Boolean(service) === Boolean(account))) {
    throw new Error("Use exactly one of --service NAME or --llm-account UUID, plus --actor-user-id ID.");
  }
  if (process.argv.some((value) => value === "--value" || value.startsWith("--value="))) {
    throw new Error("--value is forbidden. Pipe the credential through stdin.");
  }
  const value = await readSecretFromStdin();
  if (service) {
    if (!isCredentialName(service)) throw new Error("Unknown service credential name.");
    await saveCredential(service, value, actor);
    process.stdout.write(`Rotated ${service}.\n`);
    return;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(account!)) throw new Error("Invalid LLM account id.");
  await rotateAccountCredential(account!, value, actor);
  process.stdout.write("Rotated the LLM account credential.\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Credential rotation failed.");
  process.exitCode = 1;
});

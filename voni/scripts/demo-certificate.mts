/**
 * `demo:certificate` entry point. The logic lives in `lib/demo-certificate.ts`
 * so tests can drive `main(argv)` without spawning a process.
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { CERTIFICATE_REFUSAL_EXIT_CODE } from "../src/lib/demo/verification/certificate";
import { main } from "./lib/demo-certificate";

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`demo:certificate: ${(error as Error).message}\n`);
      process.exitCode = CERTIFICATE_REFUSAL_EXIT_CODE;
    });
}

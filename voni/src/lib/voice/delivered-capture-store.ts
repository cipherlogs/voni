/**
 * Dev-only disk sink for a delivered capture (node:fs). The route that calls
 * this 404s in production, and the directory is gitignored.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { DELIVERED_CAPTURE_DIR } from "./delivered-capture";

/** A bare file name in the capture dir; never a path. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.wav$/;

export function captureFilePath(name: string, root = process.cwd()): string {
  if (!NAME.test(name) || name.includes("..")) {
    throw new Error(`invalid capture name: ${JSON.stringify(name)}`);
  }
  const dir = resolve(root, DELIVERED_CAPTURE_DIR);
  const path = join(dir, name);
  if (!path.startsWith(dir + sep)) throw new Error(`invalid capture name: ${JSON.stringify(name)}`);
  return path;
}

/** Write one capture and return its absolute path. */
export async function writeDeliveredCapture(
  name: string,
  bytes: Uint8Array,
  root = process.cwd(),
): Promise<string> {
  const path = captureFilePath(name, root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

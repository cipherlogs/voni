/**
 * Dev-only disk sink for one call's marks (node:fs). The route that calls this
 * refuses production by name, and the directory is gitignored.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import {
  CALL_MARKS_DIR,
  isCallMarksArtifact,
  type CallMarksArtifact,
} from "./call-marks";

/** A call id that is a bare file-name component; never a path. */
const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function callMarksFileName(callId: string): string {
  if (!CALL_ID.test(callId) || callId.includes("..")) {
    throw new Error(`invalid call id: ${JSON.stringify(callId)}`);
  }
  return `call-marks-${callId}.json`;
}

export function callMarksFilePath(callId: string, root = process.cwd()): string {
  const dir = resolve(root, CALL_MARKS_DIR);
  const path = join(dir, callMarksFileName(callId));
  if (!path.startsWith(dir + sep)) throw new Error(`invalid call id: ${JSON.stringify(callId)}`);
  return path;
}

/** Write one marks artifact and return its absolute path. */
export async function writeCallMarks(
  callId: string,
  artifact: CallMarksArtifact,
  root = process.cwd(),
): Promise<string> {
  if (!isCallMarksArtifact(artifact)) throw new Error("invalid call marks artifact");
  if (artifact.callId !== callId) {
    throw new Error(
      `call id mismatch: the URL names ${JSON.stringify(callId)}, the artifact names ${JSON.stringify(artifact.callId)}`,
    );
  }
  const path = callMarksFilePath(callId, root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`);
  return path;
}

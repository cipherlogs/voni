import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptCredential,
  encryptCredential,
  encryptionKeyVersion,
  parseEncryptionKey,
} from "./encryption";

test("parseEncryptionKey accepts exact 32-byte hex and base64 keys", () => {
  assert.equal(parseEncryptionKey("ab".repeat(32)).byteLength, 32);
  assert.equal(parseEncryptionKey(Buffer.alloc(32, 7).toString("base64url")).byteLength, 32);
  assert.throws(() => parseEncryptionKey("too-short"), /exactly 32 bytes/);
});

test("AES-GCM encryption round-trips without exposing plaintext and uses a random IV", async () => {
  const previous = process.env.VONI_CREDENTIALS_ENCRYPTION_KEY;
  process.env.VONI_CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  try {
    const first = await encryptCredential("secret-provider-key");
    const second = await encryptCredential("secret-provider-key");
    assert.notEqual(first.iv, second.iv);
    assert.notEqual(first.ciphertext, second.ciphertext);
    assert.equal(Buffer.from(first.iv, "base64").byteLength, 12);
    assert.equal(await decryptCredential(first.ciphertext, first.iv), "secret-provider-key");
    assert.equal(first.ciphertext.includes("secret-provider-key"), false);
  } finally {
    if (previous === undefined) delete process.env.VONI_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.VONI_CREDENTIALS_ENCRYPTION_KEY = previous;
  }
});

test("key version is positive and defaults to one", async () => {
  const previous = process.env.VONI_CREDENTIALS_KEY_VERSION;
  delete process.env.VONI_CREDENTIALS_KEY_VERSION;
  assert.equal(await encryptionKeyVersion(), 1);
  process.env.VONI_CREDENTIALS_KEY_VERSION = "3";
  assert.equal(await encryptionKeyVersion(), 3);
  process.env.VONI_CREDENTIALS_KEY_VERSION = "0";
  assert.equal(await encryptionKeyVersion(), 1);
  if (previous === undefined) delete process.env.VONI_CREDENTIALS_KEY_VERSION;
  else process.env.VONI_CREDENTIALS_KEY_VERSION = previous;
});

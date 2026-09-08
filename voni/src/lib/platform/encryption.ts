import { secret } from "@/lib/env";

const ALGORITHM = "AES-GCM";

function bytesToBase64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(value: string) {
  return new Uint8Array(Buffer.from(value, "base64"));
}

export function parseEncryptionKey(value: string): Uint8Array {
  const trimmed = value.trim();
  const bytes = /^[0-9a-f]{64}$/i.test(trimmed)
    ? new Uint8Array(Buffer.from(trimmed, "hex"))
    : new Uint8Array(Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
  if (bytes.byteLength !== 32) {
    throw new Error("VONI_CREDENTIALS_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }
  return bytes;
}

async function rootKey() {
  const encoded = await secret("VONI_CREDENTIALS_ENCRYPTION_KEY");
  if (!encoded) throw new Error("Credential encryption is not configured.");
  const bytes = parseEncryptionKey(encoded);
  const keyData = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return crypto.subtle.importKey("raw", keyData, ALGORITHM, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptCredential(value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    await rootKey(),
    new TextEncoder().encode(value),
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
  };
}

export async function decryptCredential(ciphertext: string, iv: string) {
  const plaintext = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv: base64ToBytes(iv) },
    await rootKey(),
    base64ToBytes(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

export async function encryptionKeyVersion() {
  const raw = await secret("VONI_CREDENTIALS_KEY_VERSION");
  const parsed = Number(raw ?? "1");
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

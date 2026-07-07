import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const MEMORY_PROTECTED_OBJECT_ENCRYPTION_ALGORITHM = "aes-256-gcm";

const ENVELOPE_MAGIC = Buffer.from("WMPO1", "ascii");
const KEY_LENGTH_BYTES = 32;
const NONCE_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;

export const MEMORY_PROTECTED_OBJECT_ENVELOPE_OVERHEAD_BYTES =
  ENVELOPE_MAGIC.byteLength + NONCE_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES;

export type MemoryProtectedObjectKey = {
  keyId: string;
  key: Uint8Array;
};

export type MemoryProtectedObjectEncryptionResult = {
  algorithm: typeof MEMORY_PROTECTED_OBJECT_ENCRYPTION_ALGORITHM;
  keyId: string;
  encryptedPayload: Buffer;
  storedBytes: number;
  sha256: string;
};

export function encryptMemoryProtectedObjectPayload(input: {
  plaintext: Uint8Array;
  key: MemoryProtectedObjectKey;
  aad?: Uint8Array;
}): MemoryProtectedObjectEncryptionResult {
  const keyMaterial = normalizeKey(input.key);
  const nonce = randomBytes(NONCE_LENGTH_BYTES);
  const cipher = createCipheriv(MEMORY_PROTECTED_OBJECT_ENCRYPTION_ALGORITHM, keyMaterial, nonce);
  if (input.aad) {
    cipher.setAAD(Buffer.from(input.aad));
  }

  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(input.plaintext)),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  const encryptedPayload = Buffer.concat([
    ENVELOPE_MAGIC,
    nonce,
    authTag,
    ciphertext,
  ]);

  return {
    algorithm: MEMORY_PROTECTED_OBJECT_ENCRYPTION_ALGORITHM,
    keyId: input.key.keyId,
    encryptedPayload,
    storedBytes: encryptedPayload.byteLength,
    sha256: sha256Hex(encryptedPayload),
  };
}

export function decryptMemoryProtectedObjectPayload(input: {
  encryptedPayload: Uint8Array;
  key: MemoryProtectedObjectKey;
  aad?: Uint8Array;
}): Buffer {
  const keyMaterial = normalizeKey(input.key);
  const envelope = Buffer.from(input.encryptedPayload);
  if (envelope.byteLength < MEMORY_PROTECTED_OBJECT_ENVELOPE_OVERHEAD_BYTES) {
    throw new Error("Memory protected object envelope is too short.");
  }

  const magic = envelope.subarray(0, ENVELOPE_MAGIC.byteLength);
  if (!magic.equals(ENVELOPE_MAGIC)) {
    throw new Error("Memory protected object envelope is invalid.");
  }

  const nonceStart = ENVELOPE_MAGIC.byteLength;
  const authTagStart = nonceStart + NONCE_LENGTH_BYTES;
  const ciphertextStart = authTagStart + AUTH_TAG_LENGTH_BYTES;
  const nonce = envelope.subarray(nonceStart, authTagStart);
  const authTag = envelope.subarray(authTagStart, ciphertextStart);
  const ciphertext = envelope.subarray(ciphertextStart);

  const decipher = createDecipheriv(MEMORY_PROTECTED_OBJECT_ENCRYPTION_ALGORITHM, keyMaterial, nonce);
  if (input.aad) {
    decipher.setAAD(Buffer.from(input.aad));
  }
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function normalizeKey(input: MemoryProtectedObjectKey): Buffer {
  if (input.keyId.trim().length === 0) {
    throw new Error("Memory protected object key id is required.");
  }
  if (input.key.byteLength !== KEY_LENGTH_BYTES) {
    throw new Error("Memory protected object key must be 32 bytes.");
  }
  return Buffer.from(input.key);
}

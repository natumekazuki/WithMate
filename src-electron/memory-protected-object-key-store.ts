import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { MemoryProtectedObjectKey } from "./memory-protected-object-crypto.js";

const MEMORY_KEYS_ROOT = "memory-keys";
const KEYRING_FILE_NAME = "v6-keyring.json";
const KEYRING_SCHEMA_VERSION = "memory-protected-object-keyring-v1";
const KEY_LENGTH_BYTES = 32;
const KEYRING_READ_RETRY_COUNT = 5;
const KEYRING_READ_RETRY_DELAY_MS = 10;
const KEY_ID_PATTERN = /^[a-f0-9]{32}$/;

type MemoryProtectedObjectKeyringDocument = {
  schemaVersion: typeof KEYRING_SCHEMA_VERSION;
  activeKeyId: string;
  keys: MemoryProtectedObjectWrappedKey[];
};

type MemoryProtectedObjectWrappedKey = {
  keyId: string;
  encryptedKeyBase64: string;
  createdAt: string;
};

export type MemoryProtectedObjectKeyProtector = {
  isEncryptionAvailable(): boolean;
  protect(plaintext: string): Buffer;
  unprotect(encrypted: Buffer): string;
};

export type ElectronSafeStorageLike = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

export function resolveMemoryProtectedObjectKeyringPath(userDataPath: string): string {
  return join(userDataPath, MEMORY_KEYS_ROOT, KEYRING_FILE_NAME);
}

export function createElectronSafeStorageKeyProtector(
  safeStorage: ElectronSafeStorageLike,
): MemoryProtectedObjectKeyProtector {
  return {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    protect: (plaintext) => safeStorage.encryptString(plaintext),
    unprotect: (encrypted) => safeStorage.decryptString(encrypted),
  };
}

export class MemoryProtectedObjectKeyStore {
  constructor(
    private readonly keyringPath: string,
    private readonly protector: MemoryProtectedObjectKeyProtector,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  static fromUserDataPath(
    userDataPath: string,
    protector: MemoryProtectedObjectKeyProtector,
    now?: () => string,
  ): MemoryProtectedObjectKeyStore {
    return new MemoryProtectedObjectKeyStore(
      resolveMemoryProtectedObjectKeyringPath(userDataPath),
      protector,
      now,
    );
  }

  async readActiveKey(): Promise<MemoryProtectedObjectKey | null> {
    const document = await this.readKeyringDocument();
    if (!document) {
      return null;
    }
    return this.unwrapKey(document, document.activeKeyId);
  }

  async readKey(keyId: string): Promise<MemoryProtectedObjectKey | null> {
    assertKeyId(keyId);
    const document = await this.readKeyringDocument();
    if (!document) {
      return null;
    }
    return this.unwrapKey(document, keyId);
  }

  async getOrCreateActiveKey(): Promise<MemoryProtectedObjectKey> {
    const existing = await this.readActiveKey();
    if (existing) {
      return existing;
    }

    this.assertEncryptionAvailable();
    const keyId = createKeyId();
    const key = randomBytes(KEY_LENGTH_BYTES);
    const plaintextKeyBase64 = key.toString("base64");
    const encryptedKey = this.protector.protect(plaintextKeyBase64);
    const document: MemoryProtectedObjectKeyringDocument = {
      schemaVersion: KEYRING_SCHEMA_VERSION,
      activeKeyId: keyId,
      keys: [{
        keyId,
        encryptedKeyBase64: encryptedKey.toString("base64"),
        createdAt: this.now(),
      }],
    };

    await mkdir(dirname(this.keyringPath), { recursive: true });
    try {
      await writeFile(this.keyringPath, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx" });
      return {
        keyId,
        key,
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        const winner = await this.readActiveKeyWithRetry();
        if (winner) {
          return winner;
        }
      }
      throw error;
    }
  }

  private async readKeyringDocument(): Promise<MemoryProtectedObjectKeyringDocument | null> {
    let content: string;
    try {
      content = await readFile(this.keyringPath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }

    const parsed: unknown = JSON.parse(content);
    return normalizeKeyringDocument(parsed);
  }

  private async readActiveKeyWithRetry(): Promise<MemoryProtectedObjectKey | null> {
    let lastError: unknown;
    for (let attempt = 0; attempt < KEYRING_READ_RETRY_COUNT; attempt += 1) {
      try {
        return await this.readActiveKey();
      } catch (error) {
        lastError = error;
        await delay(KEYRING_READ_RETRY_DELAY_MS);
      }
    }
    throw lastError;
  }

  private unwrapKey(document: MemoryProtectedObjectKeyringDocument, keyId: string): MemoryProtectedObjectKey {
    this.assertEncryptionAvailable();
    const active = document.keys.find((entry) => entry.keyId === keyId);
    if (!active) {
      throw new Error("Memory protected object key is missing.");
    }
    const encryptedKey = decodeCanonicalBase64(active.encryptedKeyBase64, "encrypted key");
    const plaintextKeyBase64 = this.protector.unprotect(encryptedKey);
    const key = decodeCanonicalBase64(plaintextKeyBase64, "plaintext key");
    if (key.byteLength !== KEY_LENGTH_BYTES) {
      throw new Error("Memory protected object keyring contains an invalid key.");
    }
    return {
      keyId: active.keyId,
      key,
    };
  }

  private assertEncryptionAvailable(): void {
    if (!this.protector.isEncryptionAvailable()) {
      throw new Error("Memory protected object key protection is not available.");
    }
  }
}

function normalizeKeyringDocument(value: unknown): MemoryProtectedObjectKeyringDocument {
  if (!isRecord(value)) {
    throw new Error("Memory protected object keyring is invalid.");
  }
  if (value.schemaVersion !== KEYRING_SCHEMA_VERSION) {
    throw new Error("Memory protected object keyring schema is unsupported.");
  }
  if (typeof value.activeKeyId !== "string" || !KEY_ID_PATTERN.test(value.activeKeyId)) {
    throw new Error("Memory protected object keyring active key id is invalid.");
  }
  if (!Array.isArray(value.keys) || value.keys.length === 0) {
    throw new Error("Memory protected object keyring keys are invalid.");
  }

  const keys = value.keys.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("Memory protected object keyring key entry is invalid.");
    }
    if (typeof entry.keyId !== "string" || !KEY_ID_PATTERN.test(entry.keyId)) {
      throw new Error("Memory protected object keyring key id is invalid.");
    }
    if (typeof entry.encryptedKeyBase64 !== "string" || entry.encryptedKeyBase64.trim().length === 0) {
      throw new Error("Memory protected object keyring encrypted key is invalid.");
    }
    decodeCanonicalBase64(entry.encryptedKeyBase64, "encrypted key");
    if (typeof entry.createdAt !== "string" || entry.createdAt.trim().length === 0) {
      throw new Error("Memory protected object keyring created timestamp is invalid.");
    }
    return {
      keyId: entry.keyId,
      encryptedKeyBase64: entry.encryptedKeyBase64,
      createdAt: entry.createdAt,
    };
  });

  return {
    schemaVersion: KEYRING_SCHEMA_VERSION,
    activeKeyId: value.activeKeyId,
    keys,
  };
}

function createKeyId(): string {
  return randomUUID().replaceAll("-", "");
}

function assertKeyId(keyId: string): void {
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new Error("Memory protected object key id is invalid.");
  }
}

function decodeCanonicalBase64(value: string, label: string): Buffer {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error(`Memory protected object keyring ${label} is invalid.`);
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.toString("base64") !== normalized) {
    throw new Error(`Memory protected object keyring ${label} is invalid.`);
  }
  return decoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

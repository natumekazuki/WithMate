import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  createElectronSafeStorageKeyProtector,
  MemoryProtectedObjectKeyStore,
  resolveMemoryProtectedObjectKeyringPath,
  type MemoryProtectedObjectKeyProtector,
} from "../../src-electron/memory-protected-object-key-store.js";

class ReversingProtector implements MemoryProtectedObjectKeyProtector {
  constructor(private available = true) {}

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  protect(plaintext: string): Buffer {
    return Buffer.from(reverse(plaintext), "utf8");
  }

  unprotect(encrypted: Buffer): string {
    return reverse(encrypted.toString("utf8"));
  }
}

class ThrowingUnprotectProtector extends ReversingProtector {
  unprotect(): string {
    throw new Error("decrypt failed");
  }
}

async function withKeyStore<T>(
  runner: (input: {
    keyStore: MemoryProtectedObjectKeyStore;
    keyringPath: string;
    userDataPath: string;
  }) => T | Promise<T>,
): Promise<T> {
  const userDataPath = await mkdtemp(join(tmpdir(), "withmate-memory-object-key-store-"));
  const keyringPath = resolveMemoryProtectedObjectKeyringPath(userDataPath);
  const keyStore = MemoryProtectedObjectKeyStore.fromUserDataPath(
    userDataPath,
    new ReversingProtector(),
    () => "2026-07-05T00:00:00.000Z",
  );
  try {
    return await runner({ keyStore, keyringPath, userDataPath });
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
}

describe("MemoryProtectedObjectKeyStore", () => {
  it("active keyを生成し、wrapped keyringから同じkeyを読み直せる", async () => {
    await withKeyStore(async ({ keyStore, keyringPath, userDataPath }) => {
      const created = await keyStore.getOrCreateActiveKey();
      const loaded = await MemoryProtectedObjectKeyStore
        .fromUserDataPath(userDataPath, new ReversingProtector())
        .getOrCreateActiveKey();
      const keyringJson = await readFile(keyringPath, "utf8");

      assert.match(created.keyId, /^[a-f0-9]{32}$/);
      assert.equal(created.key.byteLength, 32);
      assert.match(keyringPath, /memory-keys/);
      assert.doesNotMatch(keyringPath, /memory-objects/);
      assert.equal(loaded.keyId, created.keyId);
      assert.deepEqual(loaded.key, created.key);
      assert.deepEqual(await keyStore.readKey(created.keyId), created);
      assert.equal(keyringJson.includes(created.key.toString("base64")), false);
      assert.match(keyringJson, /memory-protected-object-keyring-v1/);
      assert.match(keyringJson, /encryptedKeyBase64/);
      await assert.rejects(
        () => keyStore.readKey("not-a-key-id"),
        /key id is invalid/,
      );
    });
  });

  it("同時生成では先に作成されたkeyringを使う", async () => {
    await withKeyStore(async ({ userDataPath }) => {
      const first = MemoryProtectedObjectKeyStore.fromUserDataPath(userDataPath, new ReversingProtector());
      const second = MemoryProtectedObjectKeyStore.fromUserDataPath(userDataPath, new ReversingProtector());
      const keys = await Promise.all([
        first.getOrCreateActiveKey(),
        second.getOrCreateActiveKey(),
      ]);

      assert.equal(keys[0]?.keyId, keys[1]?.keyId);
      assert.deepEqual(keys[0]?.key, keys[1]?.key);
    });
  });

  it("safeStorage相当のprotector adapterを使う", () => {
    const protector = createElectronSafeStorageKeyProtector({
      isEncryptionAvailable: () => true,
      encryptString: (plainText) => Buffer.from(`wrapped:${plainText}`, "utf8"),
      decryptString: (encrypted) => encrypted.toString("utf8").replace(/^wrapped:/, ""),
    });

    assert.equal(protector.isEncryptionAvailable(), true);
    const encrypted = protector.protect("plain");
    assert.deepEqual(encrypted, Buffer.from("wrapped:plain"));
    assert.equal(protector.unprotect(encrypted), "plain");
  });

  it("key protectionが使えない場合はkeyringを作らない", async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), "withmate-memory-object-key-store-unavailable-"));
    const keyringPath = resolveMemoryProtectedObjectKeyringPath(userDataPath);
    const keyStore = MemoryProtectedObjectKeyStore.fromUserDataPath(
      userDataPath,
      new ReversingProtector(false),
    );
    try {
      await assert.rejects(
        () => keyStore.getOrCreateActiveKey(),
        /not available/,
      );
      await assert.rejects(
        () => readFile(keyringPath, "utf8"),
        /ENOENT/,
      );
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("壊れたkeyringや復号後に32 bytesではないkeyを拒否する", async () => {
    await withKeyStore(async ({ keyringPath, userDataPath }) => {
      await mkdir(dirname(keyringPath), { recursive: true });
      await writeFile(keyringPath, JSON.stringify({
        schemaVersion: "memory-protected-object-keyring-v1",
        activeKeyId: "a".repeat(32),
        keys: [{
          keyId: "a".repeat(32),
          encryptedKeyBase64: Buffer.from(reverse(Buffer.from("short").toString("base64")), "utf8").toString("base64"),
          createdAt: "2026-07-05T00:00:00.000Z",
        }],
      }));

      await assert.rejects(
        () => MemoryProtectedObjectKeyStore.fromUserDataPath(userDataPath, new ReversingProtector()).readActiveKey(),
        /invalid key/,
      );

      await writeFile(keyringPath, JSON.stringify({ schemaVersion: "unknown" }));
      await assert.rejects(
        () => MemoryProtectedObjectKeyStore.fromUserDataPath(userDataPath, new ReversingProtector()).readActiveKey(),
        /unsupported/,
      );

      await writeFile(keyringPath, JSON.stringify({
        schemaVersion: "memory-protected-object-keyring-v1",
        activeKeyId: "b".repeat(32),
        keys: [{
          keyId: "b".repeat(32),
          encryptedKeyBase64: "not-base64",
          createdAt: "2026-07-05T00:00:00.000Z",
        }],
      }));
      await assert.rejects(
        () => MemoryProtectedObjectKeyStore.fromUserDataPath(userDataPath, new ReversingProtector()).readActiveKey(),
        /encrypted key is invalid/,
      );

      await writeFile(keyringPath, JSON.stringify({
        schemaVersion: "memory-protected-object-keyring-v1",
        activeKeyId: "c".repeat(32),
        keys: [{
          keyId: "c".repeat(32),
          encryptedKeyBase64: Buffer.from("wrapped").toString("base64"),
          createdAt: "2026-07-05T00:00:00.000Z",
        }],
      }));
      await assert.rejects(
        () => MemoryProtectedObjectKeyStore.fromUserDataPath(userDataPath, new ThrowingUnprotectProtector()).readActiveKey(),
        /decrypt failed/,
      );

      await writeFile(keyringPath, JSON.stringify({
        schemaVersion: "memory-protected-object-keyring-v1",
        activeKeyId: "not-a-key-id",
        keys: [{
          keyId: "not-a-key-id",
          encryptedKeyBase64: Buffer.from("wrapped").toString("base64"),
          createdAt: "2026-07-05T00:00:00.000Z",
        }],
      }));
      await assert.rejects(
        () => MemoryProtectedObjectKeyStore.fromUserDataPath(userDataPath, new ReversingProtector()).readActiveKey(),
        /active key id is invalid/,
      );
    });
  });
});

function reverse(value: string): string {
  return [...value].reverse().join("");
}

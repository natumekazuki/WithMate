import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { encryptMemoryProtectedObjectPayload, type MemoryProtectedObjectKey } from "../../src-electron/memory-protected-object-crypto.js";
import { exportMemoryProtectedObjectFile, exportMemoryProtectedObjectFiles } from "../../src-electron/memory-protected-object-exporter.js";
import {
  createMemoryProtectedObjectAad,
  MEMORY_PROTECTED_OBJECT_MAX_ORIGINAL_BYTES,
  MEMORY_PROTECTED_OBJECT_MAX_STORED_BYTES,
} from "../../src-electron/memory-protected-object-importer.js";
import { MemoryProtectedObjectStore } from "../../src-electron/memory-protected-object-store.js";
import type { MemoryV6ProtectedObjectExportMetadata } from "../../src-electron/memory-v6-storage.js";

describe("memory protected object exporter", () => {
  it("stored objectを復号して明示output pathへ書き出し、既存ファイルは上書きしない", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-object-exporter-"));
    const objectStore = MemoryProtectedObjectStore.fromUserDataPath(tempDirectory);
    const objectId = "a".repeat(32);
    const entryId = "mem-exporter";
    const plaintext = Buffer.from("protected object export payload", "utf8");
    const key: MemoryProtectedObjectKey = {
      keyId: "b".repeat(32),
      key: randomBytes(32),
    };
    const encrypted = encryptMemoryProtectedObjectPayload({
      plaintext,
      key,
      aad: createMemoryProtectedObjectAad({ entryId, objectId }),
    });
    const writeResult = await objectStore.writeObject({
      objectId,
      payload: encrypted.encryptedPayload,
    });
    const metadata: MemoryV6ProtectedObjectExportMetadata = {
      objectId,
      entryId,
      contentType: "text/plain",
      displayName: "payload.txt",
      originalBytes: plaintext.byteLength,
      storedBytes: writeResult.storedBytes,
      sha256: encrypted.sha256,
      keyId: key.keyId,
    };
    const outputPath = join(tempDirectory, "payload.txt");

    try {
      const result = await exportMemoryProtectedObjectFile({
        keyStore: { readKey: async () => key },
        objectStore,
      }, {
        metadata,
        outputPath,
      });

      assert.deepEqual(result, { bytesWritten: plaintext.byteLength });
      assert.deepEqual(await readFile(outputPath), plaintext);

      await assert.rejects(
        () => exportMemoryProtectedObjectFile({
          keyStore: { readKey: async () => key },
          objectStore,
        }, {
          metadata,
          outputPath,
        }),
        /EEXIST|file already exists/i,
      );
      assert.deepEqual(await readFile(outputPath), plaintext);

      await writeFile(outputPath, "different", "utf8");
      assert.equal((await readFile(outputPath, "utf8")), "different");
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("複数stored objectをoutput directoryへ安全なファイル名で書き出す", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-object-exporter-batch-"));
    const objectStore = MemoryProtectedObjectStore.fromUserDataPath(tempDirectory);
    const outputDirectoryPath = join(tempDirectory, "exports");
    const key: MemoryProtectedObjectKey = {
      keyId: "c".repeat(32),
      key: randomBytes(32),
    };
    const entries = [
      {
        objectId: "1".repeat(32),
        entryId: "mem-exporter-batch",
        plaintext: Buffer.from("first", "utf8"),
        displayName: "../trace:one?.txt",
        contentType: "text/plain",
      },
      {
        objectId: "2".repeat(32),
        entryId: "mem-exporter-batch",
        plaintext: Buffer.from("second", "utf8"),
        displayName: "",
        contentType: "",
      },
    ];

    try {
      const metadata: MemoryV6ProtectedObjectExportMetadata[] = [];
      for (const entry of entries) {
        const encrypted = encryptMemoryProtectedObjectPayload({
          plaintext: entry.plaintext,
          key,
          aad: createMemoryProtectedObjectAad({ entryId: entry.entryId, objectId: entry.objectId }),
        });
        const writeResult = await objectStore.writeObject({
          objectId: entry.objectId,
          payload: encrypted.encryptedPayload,
        });
        metadata.push({
          objectId: entry.objectId,
          entryId: entry.entryId,
          contentType: entry.contentType,
          displayName: entry.displayName,
          originalBytes: entry.plaintext.byteLength,
          storedBytes: writeResult.storedBytes,
          sha256: encrypted.sha256,
          keyId: key.keyId,
        });
      }

      const result = await exportMemoryProtectedObjectFiles({
        keyStore: { readKey: async () => key },
        objectStore,
      }, {
        metadata,
        outputDirectoryPath,
      });

      assert.deepEqual(result.files.map((file) => ({
        objectId: file.objectId,
        bytesWritten: file.bytesWritten,
        displayName: file.displayName,
      })), [
        { objectId: "1".repeat(32), bytesWritten: 5, displayName: "../trace:one?.txt" },
        { objectId: "2".repeat(32), bytesWritten: 6, displayName: "" },
      ]);
      assert.deepEqual((await readdir(outputDirectoryPath)).sort(), [
        `${"1".repeat(32)}-trace_one_.txt`,
        `${"2".repeat(32)}.bin`,
      ]);
      assert.equal(await readFile(result.files[0]!.outputPath, "utf8"), "first");
      assert.equal(await readFile(result.files[1]!.outputPath, "utf8"), "second");
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("metadataがper-file上限を超えるexportはobjectを読まずに拒否する", async () => {
    const metadata: MemoryV6ProtectedObjectExportMetadata = {
      objectId: "f".repeat(32),
      entryId: "mem-exporter-large",
      contentType: "application/octet-stream",
      displayName: "too-large.bin",
      originalBytes: MEMORY_PROTECTED_OBJECT_MAX_ORIGINAL_BYTES + 1,
      storedBytes: MEMORY_PROTECTED_OBJECT_MAX_STORED_BYTES + 1,
      sha256: "0".repeat(64),
      keyId: "e".repeat(32),
    };
    let readObjectCalled = false;

    await assert.rejects(
      () =>
        exportMemoryProtectedObjectFile({
          keyStore: { readKey: async () => ({ keyId: metadata.keyId, key: randomBytes(32) }) },
          objectStore: {
            async readObject() {
              readObjectCalled = true;
              return Buffer.alloc(0);
            },
          },
        }, {
          metadata,
          outputPath: "unused.bin",
        }),
      /per-file size limit/,
    );
    assert.equal(readObjectCalled, false);
  });
});

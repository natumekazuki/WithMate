import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { decryptMemoryProtectedObjectPayload, type MemoryProtectedObjectKey } from "../../src-electron/memory-protected-object-crypto.js";
import {
  createMemoryProtectedObjectAad,
  inferMemoryProtectedObjectMediaKind,
  inspectMemoryProtectedObjectInputFile,
  prepareMemoryProtectedObjectFile,
} from "../../src-electron/memory-protected-object-importer.js";
import { MemoryProtectedObjectStore } from "../../src-electron/memory-protected-object-store.js";

async function withTempDir<T>(runner: (directory: string) => T | Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "withmate-memory-object-importer-"));
  try {
    return await runner(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function testKey(): MemoryProtectedObjectKey {
  return {
    keyId: "a".repeat(32),
    key: Buffer.alloc(32, 7),
  };
}

describe("Memory protected object importer", () => {
  it("入力fileを暗号化してobject storeへ保存し、storage登録用metadataを返す", async () => {
    await withTempDir(async (directory) => {
      const inputPath = join(directory, "input.png");
      const plaintext = Buffer.from("fake image bytes");
      await writeFile(inputPath, plaintext);

      const objectStore = MemoryProtectedObjectStore.fromUserDataPath(directory);
      const key = testKey();
      const result = await prepareMemoryProtectedObjectFile(
        {
          keyStore: {
            getOrCreateActiveKey: async () => key,
          },
          objectStore,
        },
        {
          entryId: "mem-entry-1",
          file: {
            path: inputPath,
            summary: "Screenshot of the failing dialog.",
            role: "snapshot",
            displayName: "dialog.png",
            contentType: "image/png",
          },
        },
      );

      assert.match(result.objectId, /^[a-f0-9]{32}$/);
      assert.equal(result.role, "snapshot");
      assert.equal(result.mediaKind, "image");
      assert.equal(result.contentType, "image/png");
      assert.equal(result.displayName, "dialog.png");
      assert.equal(result.summary, "Screenshot of the failing dialog.");
      assert.equal(result.originalBytes, plaintext.byteLength);
      assert.equal(result.keyId, key.keyId);
      assert.match(result.sha256, /^[a-f0-9]{64}$/);

      const encrypted = await objectStore.readObject(result.objectId);
      assert.equal(result.storedBytes, encrypted.byteLength);
      assert.notDeepEqual(encrypted, plaintext);
      assert.deepEqual(
        decryptMemoryProtectedObjectPayload({
          encryptedPayload: encrypted,
          key,
          aad: createMemoryProtectedObjectAad({
            entryId: "mem-entry-1",
            objectId: result.objectId,
          }),
        }),
        plaintext,
      );
    });
  });

  it("summary/displayName/contentTypeを正規化し、元file名は暗黙保存しない", async () => {
    await withTempDir(async (directory) => {
      const inputPath = join(directory, "secret-name.ts");
      await writeFile(inputPath, "export const value = 1;\n");

      const inspected = await inspectMemoryProtectedObjectInputFile({
        path: inputPath,
        summary: "  Source snippet for regression test.  ",
        role: "source",
        contentType: " text/plain ",
      });

      assert.equal(inspected.mediaKind, "source");
      assert.equal(inspected.role, "source");
      assert.equal(inspected.summary, "Source snippet for regression test.");
      assert.equal(inspected.contentType, "text/plain");
      assert.equal(inspected.displayName, "");
      assert.equal(inspected.originalBytes, "export const value = 1;\n".length);
    });
  });

  it("missing file、directory、空summaryを拒否する", async () => {
    await withTempDir(async (directory) => {
      await mkdir(join(directory, "folder"));

      await assert.rejects(
        () =>
          inspectMemoryProtectedObjectInputFile({
            path: join(directory, "missing.png"),
            summary: "Missing file.",
          }),
        /not readable/,
      );
      await assert.rejects(
        () =>
          inspectMemoryProtectedObjectInputFile({
            path: join(directory, "folder"),
            summary: "Directory.",
          }),
        /must be a file/,
      );
      await writeFile(join(directory, "empty-summary.txt"), "content");
      await assert.rejects(
        () =>
          inspectMemoryProtectedObjectInputFile({
            path: join(directory, "empty-summary.txt"),
            summary: "   ",
          }),
        /summary is required/,
      );
    });
  });

  it("media kindをrole、content type、拡張子から推定する", () => {
    assert.equal(inferMemoryProtectedObjectMediaKind({ role: "source", contentType: "image/png" }), "source");
    assert.equal(inferMemoryProtectedObjectMediaKind({ contentType: "image/webp" }), "image");
    assert.equal(inferMemoryProtectedObjectMediaKind({ contentType: "application/json" }), "text");
    assert.equal(inferMemoryProtectedObjectMediaKind({ path: "trace.zip" }), "archive");
    assert.equal(inferMemoryProtectedObjectMediaKind({ path: "report.pdf" }), "document");
    assert.equal(inferMemoryProtectedObjectMediaKind({ path: "unknown.bin" }), "other");
  });
});

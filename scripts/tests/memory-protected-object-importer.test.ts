import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { decryptMemoryProtectedObjectPayload, type MemoryProtectedObjectKey } from "../../src-electron/memory-protected-object-crypto.js";
import {
  createMemoryProtectedObjectAad,
  inferMemoryProtectedObjectMediaKind,
  inspectMemoryProtectedObjectInputFile,
  MemoryProtectedObjectImportError,
  MEMORY_PROTECTED_OBJECT_MAX_ORIGINAL_BYTES,
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
        (error) => error instanceof MemoryProtectedObjectImportError
          && error.code === "MEMORY_INVALID_FIELD"
          && error.field === "path"
          && /not readable/.test(error.message),
      );
      await assert.rejects(
        () =>
          inspectMemoryProtectedObjectInputFile({
            path: join(directory, "folder"),
            summary: "Directory.",
          }),
        (error) => error instanceof MemoryProtectedObjectImportError
          && error.code === "MEMORY_INVALID_FIELD"
          && error.field === "path"
          && /must be a file/.test(error.message),
      );
      await writeFile(join(directory, "empty-summary.txt"), "content");
      await assert.rejects(
        () =>
          inspectMemoryProtectedObjectInputFile({
            path: join(directory, "empty-summary.txt"),
            summary: "   ",
          }),
        (error) => error instanceof MemoryProtectedObjectImportError
          && error.code === "MEMORY_INVALID_FIELD"
          && error.field === "summary"
          && /summary is required/.test(error.message),
      );
    });
  });

  it("per-file上限を超えるinputは読み込み前inspectionで拒否する", async () => {
    await withTempDir(async (directory) => {
      const inputPath = join(directory, "too-large.bin");
      await writeFile(inputPath, "");
      await truncate(inputPath, MEMORY_PROTECTED_OBJECT_MAX_ORIGINAL_BYTES + 1);

      await assert.rejects(
        () =>
          inspectMemoryProtectedObjectInputFile({
            path: inputPath,
            summary: "Too large protected object.",
          }),
        (error) => error instanceof MemoryProtectedObjectImportError
          && error.code === "MEMORY_FIELD_TOO_LARGE"
          && error.field === "path"
          && /per-file size limit/.test(error.message),
      );
    });
  });

  it("inspection後にinput file sizeが変わった場合はdomain errorで拒否する", async () => {
    await withTempDir(async (directory) => {
      const inputPath = join(directory, "changing.bin");
      await writeFile(inputPath, "before");

      const objectStore = MemoryProtectedObjectStore.fromUserDataPath(directory);
      await assert.rejects(
        () =>
          prepareMemoryProtectedObjectFile(
            {
              keyStore: {
                getOrCreateActiveKey: async () => {
                  await writeFile(inputPath, "after-change");
                  return testKey();
                },
              },
              objectStore,
            },
            {
              entryId: "mem-changing",
              file: {
                path: inputPath,
                summary: "Changing file.",
              },
            },
          ),
        (error) => error instanceof MemoryProtectedObjectImportError
          && error.code === "MEMORY_INVALID_FIELD"
          && error.field === "path"
          && /changed during import/.test(error.message),
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

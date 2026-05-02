import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { SyncTextBlobStore, TextBlobSizeLimitError, TextBlobStore } from "../../src-electron/text-blob-store.js";

async function withStore(run: (store: TextBlobStore) => Promise<void>): Promise<void> {
  await withBlobRoot(async (blobRootPath) => {
    await run(new TextBlobStore(blobRootPath));
  });
}

async function withBlobRoot(run: (blobRootPath: string) => Promise<void>): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-text-blob-store-"));
  try {
    await run(path.join(tempDirectory, "blobs"));
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

describe("TextBlobStore", () => {
  it("text と json を圧縮保存して roundtrip できる", async () => {
    await withStore(async (store) => {
      const text = "hello blob\n".repeat(128);
      const textRef = await store.putText({ contentType: "text/plain", text });
      const jsonRef = await store.putJson({ value: { ok: true, items: ["a", "b"] } });

      assert.match(textRef.blobId, /^[a-f0-9]{64}$/);
      assert.equal(textRef.codec, "br");
      assert.equal(textRef.contentType, "text/plain");
      assert.equal(textRef.originalBytes, Buffer.byteLength(text, "utf8"));
      assert.ok(textRef.storedBytes > 0);
      assert.equal(await store.getText(textRef.blobId), text);
      assert.deepEqual(await store.getJson(jsonRef.blobId), { ok: true, items: ["a", "b"] });
      assert.deepEqual(await store.stat(textRef.blobId), textRef);
    });
  });

  it("maxOriginalBytes を超える blob は展開前に拒否する", async () => {
    await withStore(async (store) => {
      const ref = await store.putText({ contentType: "text/plain", text: "abcdef" });

      await assert.rejects(
        () => store.getText(ref.blobId, { maxOriginalBytes: 5 }),
        (error) => error instanceof TextBlobSizeLimitError && error.blobId === ref.blobId,
      );
      assert.equal(await store.getText(ref.blobId, { maxOriginalBytes: 6 }), "abcdef");
    });
  });

  it("deleteUnreferenced で指定 blob を削除し、欠損 blob を report する", async () => {
    await withStore(async (store) => {
      const kept = await store.putText({ contentType: "text/plain", text: "kept" });
      const deleted = await store.putText({ contentType: "text/plain", text: "deleted" });
      const missingBlobId = "f".repeat(64);

      const report = await store.deleteUnreferenced([deleted.blobId, missingBlobId]);

      assert.deepEqual(report.deletedBlobIds, [deleted.blobId]);
      assert.deepEqual(report.missingBlobIds, [missingBlobId]);
      assert.ok(report.bytesDeleted > 0);
      assert.equal(await store.getText(kept.blobId), "kept");
      assert.equal(await store.stat(deleted.blobId), null);
    });
  });

  it("collectGarbage で orphan blob を dry-run 後に cleanup できる", async () => {
    await withStore(async (store) => {
      const live = await store.putText({ contentType: "text/plain", text: "live" });
      const orphan = await store.putText({ contentType: "text/plain", text: "orphan" });

      const dryRun = await store.collectGarbage({
        referencedBlobIds: [live.blobId],
        dryRun: true,
      });

      assert.equal(dryRun.dryRun, true);
      assert.deepEqual(dryRun.orphanBlobIds, [orphan.blobId]);
      assert.deepEqual(dryRun.deletedBlobIds, []);
      assert.equal(await store.getText(orphan.blobId), "orphan");

      const cleanup = await store.collectGarbage({
        referencedBlobIds: [live.blobId],
      });

      assert.equal(cleanup.dryRun, false);
      assert.deepEqual(cleanup.orphanBlobIds, [orphan.blobId]);
      assert.deepEqual(cleanup.deletedBlobIds, [orphan.blobId]);
      assert.equal(await store.getText(live.blobId), "live");
      assert.equal(await store.stat(orphan.blobId), null);
    });
  });

  it("metadata が欠けた blob file も GC report に出して cleanup する", async () => {
    await withStore(async (store) => {
      const blobId = "a".repeat(64);
      const blobDirectory = path.join((store as unknown as { rootPath: string }).rootPath, "aa", "aa");
      await mkdir(blobDirectory, { recursive: true });
      await writeFile(path.join(blobDirectory, `${blobId}.br`), Buffer.from("orphan"));

      const report = await store.collectGarbage({ referencedBlobIds: [] });

      assert.deepEqual(report.missingBlobIds, [blobId]);
      assert.deepEqual(report.orphanBlobIds, [blobId]);
      assert.deepEqual(report.deletedBlobIds, [blobId]);
      assert.equal(await store.stat(blobId), null);
    });
  });
});

describe("SyncTextBlobStore", () => {
  it("async store が書いた blob を同期 store で読める", async () => {
    await withBlobRoot(async (blobRootPath) => {
      const asyncStore = new TextBlobStore(blobRootPath);
      const syncStore = new SyncTextBlobStore(blobRootPath);
      const textRef = await asyncStore.putText({ contentType: "text/plain", text: "async text" });
      const jsonRef = await asyncStore.putJson({ value: { from: "async", count: 2 } });

      assert.equal(syncStore.getText(textRef.blobId), "async text");
      assert.deepEqual(syncStore.getJson(jsonRef.blobId), { from: "async", count: 2 });
      assert.deepEqual(syncStore.stat(textRef.blobId), textRef);
    });
  });

  it("同期 store が書いた blob を async store で読める", async () => {
    await withBlobRoot(async (blobRootPath) => {
      const asyncStore = new TextBlobStore(blobRootPath);
      const syncStore = new SyncTextBlobStore(blobRootPath);
      const textRef = syncStore.putText({ contentType: "text/plain", text: "sync text" });
      const jsonRef = syncStore.putJson({ value: { from: "sync", count: 3 } });

      assert.equal(await asyncStore.getText(textRef.blobId), "sync text");
      assert.deepEqual(await asyncStore.getJson(jsonRef.blobId), { from: "sync", count: 3 });
      assert.deepEqual(await asyncStore.stat(textRef.blobId), textRef);
    });
  });

  it("maxOriginalBytes を超える blob は同期読み込みでも展開前に拒否する", async () => {
    await withBlobRoot(async (blobRootPath) => {
      const store = new SyncTextBlobStore(blobRootPath);
      const ref = store.putText({ contentType: "text/plain", text: "abcdef" });

      assert.throws(
        () => store.getText(ref.blobId, { maxOriginalBytes: 5 }),
        (error) => error instanceof TextBlobSizeLimitError && error.blobId === ref.blobId,
      );
      assert.equal(store.getText(ref.blobId, { maxOriginalBytes: 6 }), "abcdef");
    });
  });

  it("deleteUnreferenced で指定 blob を同期削除し、欠損 blob を report する", async () => {
    await withBlobRoot(async (blobRootPath) => {
      const store = new SyncTextBlobStore(blobRootPath);
      const kept = store.putText({ contentType: "text/plain", text: "kept" });
      const deleted = store.putText({ contentType: "text/plain", text: "deleted" });
      const missingBlobId = "f".repeat(64);

      const report = store.deleteUnreferenced([deleted.blobId, missingBlobId]);

      assert.deepEqual(report.deletedBlobIds, [deleted.blobId]);
      assert.deepEqual(report.missingBlobIds, [missingBlobId]);
      assert.ok(report.bytesDeleted > 0);
      assert.equal(store.getText(kept.blobId), "kept");
      assert.equal(store.stat(deleted.blobId), null);
    });
  });
});

import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createMemoryProtectedObjectId,
  MemoryProtectedObjectStore,
  resolveMemoryProtectedObjectStoreRoot,
} from "../../src-electron/memory-protected-object-store.js";

async function withStore<T>(runner: (input: { store: MemoryProtectedObjectStore; userDataPath: string }) => T | Promise<T>): Promise<T> {
  const userDataPath = await mkdtemp(join(tmpdir(), "withmate-memory-object-store-"));
  const store = MemoryProtectedObjectStore.fromUserDataPath(userDataPath);
  try {
    return await runner({ store, userDataPath });
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
}

describe("MemoryProtectedObjectStore", () => {
  it("暗号化済みpayloadをshard配下へstaging経由で保存し、読み出しと削除ができる", async () => {
    await withStore(async ({ store, userDataPath }) => {
      const objectId = createMemoryProtectedObjectId();
      const payload = Buffer.from("encrypted payload");
      const result = await store.writeObject({ objectId, payload });

      assert.equal(result.objectId, objectId);
      assert.equal(result.storedBytes, payload.byteLength);
      assert.equal(store.resolveObjectPath(objectId), join(resolveMemoryProtectedObjectStoreRoot(userDataPath), objectId.slice(0, 2), `${objectId}.bin`));
      assert.deepEqual(await store.readObject(objectId), payload);
      assert.deepEqual(await store.listStagingFileNames(), []);
      assert.equal(await store.objectExists(objectId), true);
      assert.equal(await store.deleteObject(objectId), true);
      assert.equal(await store.objectExists(objectId), false);
      assert.equal(await store.deleteObject(objectId), false);
    });
  });

  it("object idはopaqueなhex IDだけを受け付け、既存objectを上書きしない", async () => {
    await withStore(async ({ store }) => {
      const objectId = "a".repeat(32);
      await store.writeObject({ objectId, payload: Buffer.from("first") });

      await assert.rejects(
        () => store.writeObject({ objectId, payload: Buffer.from("second") }),
        /already exists/,
      );
      assert.deepEqual(await store.readObject(objectId), Buffer.from("first"));
      assert.deepEqual(await store.listStagingFileNames(), []);

      assert.throws(() => store.resolveObjectPath("../escape"), /invalid/);
      await assert.rejects(
        () => store.writeObject({ objectId: "../escape", payload: Buffer.from("bad") }),
        /invalid/,
      );
    });
  });

  it("同一object idの並列writeでも既存objectを上書きしない", async () => {
    await withStore(async ({ store }) => {
      const objectId = "b".repeat(32);
      const first = Buffer.from("first");
      const second = Buffer.from("second");
      const results = await Promise.allSettled([
        store.writeObject({ objectId, payload: first }),
        store.writeObject({ objectId, payload: second }),
      ]);

      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter((result) => result.status === "rejected").length, 1);
      const stored = await store.readObject(objectId);
      assert.equal(
        stored.equals(first) || stored.equals(second),
        true,
      );
      assert.notDeepEqual(stored, Buffer.concat([first, second]));
      assert.deepEqual(await store.listStagingFileNames(), []);
    });
  });

  it("GC候補scanは古いvalid object fileだけをpath非公開で返す", async () => {
    await withStore(async ({ store, userDataPath }) => {
      const oldObjectId = `ab${"c".repeat(30)}`;
      const freshObjectId = `cd${"d".repeat(30)}`;
      await store.writeObject({ objectId: oldObjectId, payload: Buffer.from("old encrypted payload") });
      await store.writeObject({ objectId: freshObjectId, payload: Buffer.from("fresh encrypted payload") });

      const oldDate = new Date(Date.now() - 10_000);
      await utimes(store.resolveObjectPath(oldObjectId), oldDate, oldDate);
      await mkdir(join(resolveMemoryProtectedObjectStoreRoot(userDataPath), "ab"), { recursive: true });
      await writeFile(join(resolveMemoryProtectedObjectStoreRoot(userDataPath), "ab", "not-an-object.bin"), "ignored");

      assert.deepEqual(await store.listObjectFilesForGc({ graceMs: 1_000, limit: 10 }), [{
        objectId: oldObjectId,
        bytes: Buffer.byteLength("old encrypted payload"),
      }]);
      assert.deepEqual(await store.listObjectFilesForGc({ graceMs: 1_000, limit: 0 }), []);
    });
  });

  it("staging GCは古いstaging fileだけをdry-run後に削除する", async () => {
    await withStore(async ({ store, userDataPath }) => {
      const stagingPath = join(resolveMemoryProtectedObjectStoreRoot(userDataPath), ".staging");
      const oldStagingPath = join(stagingPath, "old.tmp");
      const freshStagingPath = join(stagingPath, "fresh.tmp");
      await mkdir(stagingPath, { recursive: true });
      await writeFile(oldStagingPath, "old");
      await writeFile(freshStagingPath, "fresh");
      const oldDate = new Date(Date.now() - 10_000);
      await utimes(oldStagingPath, oldDate, oldDate);

      assert.deepEqual(await store.collectStagingGarbage({ dryRun: true, graceMs: 1_000, limit: 10 }), {
        candidates: 1,
        deleted: 0,
        failed: 0,
      });
      await access(oldStagingPath);

      assert.deepEqual(await store.collectStagingGarbage({ dryRun: false, graceMs: 1_000, limit: 10 }), {
        candidates: 1,
        deleted: 1,
        failed: 0,
      });
      await assert.rejects(() => access(oldStagingPath));
      await access(freshStagingPath);
    });
  });
});

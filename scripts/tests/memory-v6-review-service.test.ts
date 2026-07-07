import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { NormalizedMemoryTag } from "../../src/memory-v6/memory-contract.js";
import { MEMORY_FILE_QUOTA_MIN_BYTES } from "../../src/provider-settings-state.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { MemoryV6ReviewService, type MemoryV6ReviewServiceDeps } from "../../src-electron/memory-v6-review-service.js";
import type { MemoryV6ResolvedTarget } from "../../src-electron/memory-v6-schema.js";
import { MemoryV6Storage } from "../../src-electron/memory-v6-storage.js";

const projectTarget: MemoryV6ResolvedTarget = {
  owner: { type: "project", id: "project-a" },
  scope: { type: "project", id: "project-a" },
};

function tag(type: string, value: string): NormalizedMemoryTag {
  return {
    type,
    value,
    canonicalType: type.normalize("NFC").toLowerCase(),
    canonicalValue: value.normalize("NFC").toLowerCase(),
  };
}

async function withReviewService<T>(
  runner: (input: { service: MemoryV6ReviewService; storage: MemoryV6Storage }) => T | Promise<T>,
  overrides: Partial<MemoryV6ReviewServiceDeps> = {},
): Promise<T> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-v6-review-service-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(tempDirectory);
  const storage = new MemoryV6Storage(dbPath);
  const service = new MemoryV6ReviewService({
    resolveDbPath: () => dbPath,
    getMemoryFileQuotaBytes: () => MEMORY_FILE_QUOTA_MIN_BYTES,
    ...overrides,
  });
  try {
    return await runner({ service, storage });
  } finally {
    storage.close();
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

describe("MemoryV6ReviewService", () => {
  it("file usage はquota集計とlargest entriesを返す", async () => {
    await withReviewService(({ service, storage }) => {
      storage.appendEntry({
        target: projectTarget,
        kind: "context",
        title: "Large evidence",
        body: "添付の根拠を保持する。",
        preview: "添付の根拠。",
        tags: [tag("topic", "memory")],
        source: { type: "agent", sessionId: null, messageId: "message-a", providerId: "codex" },
        id: "mem-large-evidence",
        now: "2026-07-06T00:00:00.000Z",
        protectedObjects: [{
          objectId: "a".repeat(32),
          role: "evidence",
          mediaKind: "image",
          contentType: "image/png",
          displayName: "dialog.png",
          summary: "エラー状態のスクリーンショット。",
          originalBytes: 1536,
          storedBytes: 1600,
          sha256: "b".repeat(64),
          keyId: "c".repeat(32),
        }],
        fileQuotaBytes: MEMORY_FILE_QUOTA_MIN_BYTES,
      });

      const usage = service.getFileUsage();

      assert.equal(usage.quotaBytes, MEMORY_FILE_QUOTA_MIN_BYTES);
      assert.equal(usage.usedBytes, 1536);
      assert.equal(usage.physicalBytes, 1600);
      assert.equal(usage.availableBytes, MEMORY_FILE_QUOTA_MIN_BYTES - 1536);
      assert.deepEqual(usage.largestEntries, [{
        entryId: "mem-large-evidence",
        title: "Large evidence",
        preview: "添付の根拠。",
        totalFileBytes: 1536,
        fileCount: 1,
        updatedAt: "2026-07-06T00:00:00.000Z",
      }]);
    });
  });

  it("review search / get-entry はfile summaryから内部object idを落とす", async () => {
    await withReviewService(({ service, storage }) => {
      storage.appendEntry({
        target: projectTarget,
        kind: "context",
        title: "Sanitized review",
        body: "review detail では object id を返さない。",
        preview: "sanitized review",
        tags: [tag("topic", "memory")],
        source: { type: "agent", sessionId: null, messageId: "message-a", providerId: "codex" },
        id: "mem-sanitized-review",
        now: "2026-07-06T00:00:00.000Z",
        protectedObjects: [{
          objectId: "a".repeat(32),
          role: "evidence",
          mediaKind: "image",
          contentType: "image/png",
          displayName: "dialog.png",
          summary: "review visible summary",
          originalBytes: 1536,
          storedBytes: 1600,
          sha256: "b".repeat(64),
          keyId: "c".repeat(32),
        }],
        fileQuotaBytes: MEMORY_FILE_QUOTA_MIN_BYTES,
      });

      const searchHit = service.searchEntries({ query: "sanitized" }).items[0];
      assert.ok(searchHit.files);
      assert.equal(searchHit.files[0].displayName, "dialog.png");
      assert.equal("objectId" in searchHit.files[0], false);
      assert.equal("keyId" in searchHit.files[0], false);
      assert.equal("sha256" in searchHit.files[0], false);
      assert.equal("outputPath" in searchHit.files[0], false);

      const detail = service.getEntry("mem-sanitized-review");
      assert.ok(detail?.files);
      assert.equal(detail.files[0].summary, "review visible summary");
      assert.equal("objectId" in detail.files[0], false);
      assert.equal("keyId" in detail.files[0], false);
      assert.equal("sha256" in detail.files[0], false);
      assert.equal("outputPath" in detail.files[0], false);
    });
  });

  it("entry files export はactive entryのmetadataをexporterへ渡す", async () => {
    const exportCalls: unknown[] = [];
    await withReviewService(async ({ service, storage }) => {
      storage.appendEntry({
        target: projectTarget,
        kind: "context",
        title: "Export target",
        body: "添付をexportする。",
        preview: "export target",
        tags: [tag("topic", "memory")],
        source: { type: "agent", sessionId: null, messageId: "message-a", providerId: "codex" },
        id: "mem-export-target",
        now: "2026-07-06T00:00:00.000Z",
        protectedObjects: [{
          objectId: "d".repeat(32),
          role: "artifact",
          mediaKind: "text",
          contentType: "text/plain",
          displayName: "note.txt",
          summary: "exportable note",
          originalBytes: 512,
          storedBytes: 640,
          sha256: "e".repeat(64),
          keyId: "f".repeat(32),
        }],
        fileQuotaBytes: MEMORY_FILE_QUOTA_MIN_BYTES,
      });

      const result = await service.exportEntryFiles("mem-export-target", "C:/export");

      assert.equal(result.entryId, "mem-export-target");
      assert.equal(result.exportedCount, 1);
      assert.equal("files" in result, false);
      assert.equal("outputDirectoryPath" in result, false);
    }, {
      protectedObjectExporter: {
        async exportFile() {
          throw new Error("unused");
        },
        async exportFiles(input) {
          exportCalls.push(input);
          return {
            files: [{
              objectId: "d".repeat(32),
              outputPath: "C:/export/note.txt",
              bytesWritten: 512,
              contentType: "text/plain",
              displayName: "note.txt",
            }],
          };
        },
      },
    });

    assert.equal(exportCalls.length, 1);
    assert.deepEqual(exportCalls[0], {
      outputDirectoryPath: "C:/export",
      metadata: [{
        objectId: "d".repeat(32),
        entryId: "mem-export-target",
        contentType: "text/plain",
        displayName: "note.txt",
        originalBytes: 512,
        storedBytes: 640,
        sha256: "e".repeat(64),
        keyId: "f".repeat(32),
      }],
    });
  });

  it("protected object GC はdry-runでは変更せずcleanupでdelete_pendingをdeletedにする", async () => {
    const deletedObjects: string[] = [];
    await withReviewService(async ({ service, storage }) => {
      storage.appendEntry({
        target: projectTarget,
        kind: "context",
        title: "Forget target",
        body: "削除待ちfileを持つ。",
        preview: "forget target",
        tags: [tag("topic", "memory")],
        source: { type: "agent", sessionId: null, messageId: "message-a", providerId: "codex" },
        id: "mem-gc-target",
        now: "2026-07-06T00:00:00.000Z",
        protectedObjects: [{
          objectId: "1".repeat(32),
          role: "artifact",
          mediaKind: "text",
          contentType: "text/plain",
          displayName: "delete.txt",
          summary: "delete pending note",
          originalBytes: 512,
          storedBytes: 640,
          sha256: "2".repeat(64),
          keyId: "3".repeat(32),
        }],
        fileQuotaBytes: MEMORY_FILE_QUOTA_MIN_BYTES,
      });
      storage.forgetEntryForReview({ entryId: "mem-gc-target", now: "2026-07-06T00:01:00.000Z" });

      const dryRun = await service.runProtectedObjectGc({ dryRun: true, graceMs: 0, limit: 10 });
      assert.equal(dryRun.deletePending.candidates, 1);
      assert.equal(dryRun.deletePending.bytes, 640);
      assert.equal(dryRun.deletePending.deleted, 0);
      assert.equal(dryRun.orphanFiles.candidates, 1);
      assert.equal(dryRun.orphanFiles.deleted, 0);
      assert.equal(dryRun.stagingFiles.candidates, 1);
      assert.equal(dryRun.stagingFiles.deleted, 0);
      assert.deepEqual(deletedObjects, []);
      assert.equal(storage.getFileUsage().pendingDeleteCount, 1);

      const cleanup = await service.runProtectedObjectGc({ dryRun: false, graceMs: 0, limit: 10 });
      assert.equal(cleanup.deletePending.candidates, 1);
      assert.equal(cleanup.deletePending.deleted, 1);
      assert.equal(cleanup.orphanFiles.candidates, 1);
      assert.equal(cleanup.orphanFiles.deleted, 1);
      assert.equal(cleanup.stagingFiles.candidates, 1);
      assert.equal(cleanup.stagingFiles.deleted, 1);
      assert.deepEqual(deletedObjects, ["11111111111111111111111111111111", "44444444444444444444444444444444"]);
      assert.equal(storage.getFileUsage().pendingDeleteCount, 0);
    }, {
      protectedObjectStore: {
        async deleteObject(objectId) {
          deletedObjects.push(objectId);
          return true;
        },
        async objectExists() {
          return true;
        },
        async listObjectFilesForGc() {
          return [{ objectId: "4".repeat(32), bytes: 128 }];
        },
        async collectStagingGarbage(input) {
          return { candidates: 1, deleted: input.dryRun ? 0 : 1, failed: 0 };
        },
      },
    });
  });

  it("protected object GC はdryRun booleanがないrequestを拒否し削除処理へ進まない", async () => {
    const deletedObjects: string[] = [];
    await withReviewService(async ({ service, storage }) => {
      storage.appendEntry({
        target: projectTarget,
        kind: "context",
        title: "Malformed GC target",
        body: "削除待ちfileを持つ。",
        preview: "malformed gc",
        tags: [tag("topic", "memory")],
        source: { type: "agent", sessionId: null, messageId: "message-a", providerId: "codex" },
        id: "mem-malformed-gc",
        protectedObjects: [{
          objectId: "5".repeat(32),
          role: "artifact",
          mediaKind: "text",
          contentType: "text/plain",
          displayName: "delete.txt",
          summary: "delete pending note",
          originalBytes: 512,
          storedBytes: 640,
          sha256: "6".repeat(64),
          keyId: "7".repeat(32),
        }],
        fileQuotaBytes: MEMORY_FILE_QUOTA_MIN_BYTES,
      });
      storage.forgetEntryForReview({ entryId: "mem-malformed-gc" });

      await assert.rejects(
        () => service.runProtectedObjectGc({} as never),
        /dryRun boolean/,
      );
      await assert.rejects(
        () => service.runProtectedObjectGc({ dryRun: "false" } as never),
        /dryRun boolean/,
      );
      await assert.rejects(
        () => service.runProtectedObjectGc(null as never),
        /dryRun boolean/,
      );
      assert.deepEqual(deletedObjects, []);
      assert.equal(storage.getFileUsage().pendingDeleteCount, 1);
    }, {
      protectedObjectStore: {
        async deleteObject(objectId) {
          deletedObjects.push(objectId);
          return true;
        },
        async objectExists() {
          return true;
        },
        async listObjectFilesForGc() {
          return [];
        },
        async collectStagingGarbage() {
          return { candidates: 0, deleted: 0, failed: 0 };
        },
      },
    });
  });
});

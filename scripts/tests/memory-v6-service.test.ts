import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { MEMORY_V6_SCHEMA_VERSION, type NormalizedMemoryTag } from "../../src/memory-v6/memory-contract.js";
import { MEMORY_FILE_QUOTA_MIN_BYTES } from "../../src/provider-settings-state.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { MemoryProtectedObjectImportError } from "../../src-electron/memory-protected-object-importer.js";
import { createMemoryV6ProjectResolver } from "../../src-electron/memory-v6-project-resolver.js";
import { createLocalUserMemoryPrincipal } from "../../src-electron/memory-v6-permission.js";
import type { MemoryV6ResolvedTarget } from "../../src-electron/memory-v6-schema.js";
import { MemoryV6Service, type MemoryV6ServiceDeps } from "../../src-electron/memory-v6-service.js";
import { MemoryV6Storage, type MemoryV6AppendProtectedObjectInput } from "../../src-electron/memory-v6-storage.js";

const projectTarget = {
  owner: { type: "project", id: "project-a" },
  scope: { type: "project", id: "project-a" },
} satisfies MemoryV6ResolvedTarget;

function tag(type: string, value: string): NormalizedMemoryTag {
  return {
    type,
    value,
    canonicalType: type.normalize("NFC").toLowerCase(),
    canonicalValue: value.normalize("NFC").toLowerCase(),
  };
}

async function withService<T>(
  runner: (input: { service: MemoryV6Service; storage: MemoryV6Storage }) => T | Promise<T>,
  overrides: Partial<Pick<MemoryV6ServiceDeps, "getMemoryFileQuotaBytes" | "protectedObjectImporter" | "protectedObjectExporter">> = {},
): Promise<T> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-v6-service-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(tempDirectory);
  const storage = new MemoryV6Storage(dbPath);
  const service = new MemoryV6Service({
    storage,
    getMemoryFileQuotaBytes: overrides.getMemoryFileQuotaBytes ?? (() => MEMORY_FILE_QUOTA_MIN_BYTES),
    ...(overrides.protectedObjectImporter ? { protectedObjectImporter: overrides.protectedObjectImporter } : {}),
    ...(overrides.protectedObjectExporter ? { protectedObjectExporter: overrides.protectedObjectExporter } : {}),
    listCharacters: () => [{
      id: "character-a",
      name: "Character A",
      description: "Test character",
      iconFilePath: "",
      theme: { main: "#111111", sub: "#222222" },
      state: "active",
      isDefault: true,
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
      archivedAt: null,
    }],
    resolveProjectById: (id) => ({ id, displayName: id }),
    resolveProjectByPath: (projectPath) => projectPath === "C:/workspace/project-a"
      ? { id: "project-a", displayName: "Project A" }
      : null,
    resolveCharacterById: (id) => id === "character-a" ? { id, name: "Character A" } : null,
  });
  try {
    return await runner({ service, storage });
  } finally {
    storage.close();
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function appendRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    target: {
      owner: "project",
      scope: "project",
      project: { type: "path", path: "C:/workspace/project-a" },
    },
    kind: "decision",
    title: "Runtime API方針",
    body: "Memory serviceはagent payloadを検証してからstorageへ渡す。",
    preview: "serviceで検証してstorageへ渡す。",
    tags: [{ type: "topic", value: "memory" }],
    ...overrides,
  };
}

describe("MemoryV6Service", () => {
  it("local_user は明示project targetでappend / search / get-entry / list-tags / forgetを扱う", async () => {
    await withService(async ({ service }) => {
      const principal = createLocalUserMemoryPrincipal();
      const append = await service.append(principal, appendRequest({
        idempotencyKey: "local-user-project-append",
        sourceMessageId: "external-message-1",
      }));
      assert.equal("error" in append, false);
      assert.equal(append.entry.owner.id, "project-a");
      assert.equal(append.entry.state, "active");

      const search = service.search(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "path", path: "C:/workspace/project-a" } }],
        query: "agent payload",
      });
      assert.equal("error" in search, false);
      assert.deepEqual(search.items.map((item) => item.id), [append.entry.id]);

      const detail = service.getEntry(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId: append.entry.id,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
      });
      assert.equal("error" in detail, false);
      assert.equal(detail.entry.source.sessionId, null);
      assert.equal(detail.entry.source.providerId, "local-user");

      const tags = service.listTags(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }],
      });
      assert.equal("error" in tags, false);
      assert.deepEqual(tags.tags, [{ type: "topic", value: "memory" }]);

      const characters = service.listCharacters(principal);
      assert.equal("error" in characters, false);
      assert.deepEqual(characters.characters, [{
        id: "character-a",
        name: "Character A",
        description: "Test character",
        isDefault: true,
      }]);
      assert.equal("iconFilePath" in characters.characters[0], false);
      assert.equal("theme" in characters.characters[0], false);

      const forget = service.forget(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        entryIds: [append.entry.id],
        reason: "user_request",
      });
      assert.equal("error" in forget, false);
      assert.deepEqual(forget.results, [{ entryId: append.entry.id, status: "forgotten" }]);
    });
  });

  it("get-entry は必ず明示targetを要求し、target外entryを返さない", async () => {
    await withService(({ service, storage }) => {
      const principal = createLocalUserMemoryPrincipal();
      storage.appendEntry({
        id: "mem-project-a",
        target: projectTarget,
        kind: "note",
        title: "Project A",
        body: "Project A body",
        preview: "Project A",
        tags: [tag("topic", "memory")],
        source: {
          type: "agent",
          sessionId: null,
          messageId: null,
          providerId: "local-user",
        },
      });

      const missingTarget = service.getEntry(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId: "mem-project-a",
      });
      assert.equal("error" in missingTarget, true);
      assert.equal(missingTarget.error.code, "MEMORY_INVALID_FIELD");
      assert.equal(missingTarget.error.field, "target");

      const mismatchTarget = service.getEntry(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId: "mem-project-a",
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-b" } },
      });
      assert.equal("error" in mismatchTarget, true);
      assert.equal(mismatchTarget.error.code, "MEMORY_ENTRY_NOT_FOUND");
    });
  });

  it("file usage は quota と protected object 集計を返す", async () => {
    await withService(({ service }) => {
      const principal = createLocalUserMemoryPrincipal();
      const usage = service.fileUsage(principal);

      assert.equal("error" in usage, false);
      assert.deepEqual(usage, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        quotaBytes: MEMORY_FILE_QUOTA_MIN_BYTES,
        usedBytes: 0,
        physicalBytes: 0,
        pendingDeleteBytes: 0,
        availableBytes: MEMORY_FILE_QUOTA_MIN_BYTES,
        objectCount: 0,
        pendingDeleteCount: 0,
        quotaExceeded: false,
      });
    });
  });

  it("file usage は要求時だけlargest entriesを返す", async () => {
    await withService(({ service, storage }) => {
      const principal = createLocalUserMemoryPrincipal();
      storage.appendEntry({
        target: projectTarget,
        kind: "decision",
        title: "容量の大きいMemory",
        body: "添付ファイルの容量が大きい。",
        preview: "添付ファイルの容量が大きい。",
        tags: [tag("topic", "memory")],
        source: { type: "agent", sessionId: null, messageId: "message-large", providerId: "codex" },
        id: "mem-large-files",
        now: "2026-07-04T00:00:00.000Z",
        protectedObjects: [{
          objectId: "a".repeat(32),
          role: "evidence",
          mediaKind: "image",
          contentType: "image/png",
          displayName: "large.png",
          summary: "大きな添付。",
          originalBytes: 4096,
          storedBytes: 4200,
          sha256: "b".repeat(64),
          keyId: "c".repeat(32),
        }],
        fileQuotaBytes: 8192,
      });

      const defaultUsage = service.fileUsage(principal);
      assert.equal("error" in defaultUsage, false);
      assert.equal("largestEntries" in defaultUsage, false);

      const usage = service.fileUsage(principal, { includeLargestEntries: true, largestLimit: 1 });
      assert.equal("error" in usage, false);
      assert.deepEqual(usage.largestEntries, [{
        entryId: "mem-large-files",
        title: "容量の大きいMemory",
        preview: "添付ファイルの容量が大きい。",
        totalFileBytes: 4096,
        fileCount: 1,
        updatedAt: "2026-07-04T00:00:00.000Z",
      }]);
    });
  });

  it("file付きappendはcontract validation後に未実装エラーを返す", async () => {
    await withService(async ({ service, storage }) => {
      const principal = createLocalUserMemoryPrincipal();
      const append = await service.append(principal, appendRequest({
        idempotencyKey: "file-append-key",
        files: [{
          path: "C:/trace/screenshot.png",
          summary: "スクリーンショットでエラー状態を確認できる。",
          role: "evidence",
        }],
      }));

      assert.equal("error" in append, true);
      assert.equal(append.error.code, "MEMORY_FILE_APPEND_UNIMPLEMENTED");
      assert.equal(append.error.field, "files");
      assert.deepEqual(storage.searchEntries({ targets: [projectTarget], query: "Memory service" }).items, []);

      const replay = await service.append(principal, appendRequest({
        idempotencyKey: "file-append-key",
        files: [{
          path: "C:/trace/screenshot.png",
          summary: "スクリーンショットでエラー状態を確認できる。",
          role: "evidence",
        }],
      }));
      assert.equal("error" in replay, true);
      assert.equal(replay.error.code, "MEMORY_FILE_APPEND_UNIMPLEMENTED");
    });
  });

  it("file付きappendはquota preflight後にimporter metadataをstorageへ登録する", async () => {
    const protectedObject = {
      objectId: "a".repeat(32),
      role: "evidence",
      mediaKind: "image",
      contentType: "image/png",
      displayName: "dialog.png",
      summary: "スクリーンショットでエラー状態を確認できる。",
      originalBytes: 128,
      storedBytes: 160,
      sha256: "b".repeat(64),
      keyId: "c".repeat(32),
    } satisfies MemoryV6AppendProtectedObjectInput;
    let inspectCount = 0;
    let prepareEntryId: string | null = null;

    await withService(async ({ service, storage }) => {
      const principal = createLocalUserMemoryPrincipal();
      const append = await service.append(principal, appendRequest({
        idempotencyKey: "file-append-importer-key",
        files: [{
          path: "C:/trace/dialog.png",
          summary: "スクリーンショットでエラー状態を確認できる。",
          role: "evidence",
          displayName: "dialog.png",
          contentType: "image/png",
        }],
      }));

      assert.equal("error" in append, false);
      assert.equal(inspectCount, 1);
      assert.equal(prepareEntryId, append.entry.id);
      assert.deepEqual(storage.getFileUsage(), {
        usedBytes: 128,
        physicalBytes: 160,
        pendingDeleteBytes: 0,
        objectCount: 1,
        pendingDeleteCount: 0,
      });

      const replay = await service.append(principal, appendRequest({
        idempotencyKey: "file-append-importer-key",
        files: [{
          path: "C:/trace/dialog.png",
          summary: "スクリーンショットでエラー状態を確認できる。",
          role: "evidence",
          displayName: "dialog.png",
          contentType: "image/png",
        }],
      }));

      assert.equal("error" in replay, false);
      assert.equal(replay.entry.id, append.entry.id);
      assert.equal(inspectCount, 1);
      assert.equal(prepareEntryId, append.entry.id);
      assert.deepEqual(storage.getFileUsage(), {
        usedBytes: 128,
        physicalBytes: 160,
        pendingDeleteBytes: 0,
        objectCount: 1,
        pendingDeleteCount: 0,
      });
    }, {
      protectedObjectImporter: {
        inspect: async () => {
          inspectCount += 1;
          return {
            originalBytes: protectedObject.originalBytes,
            role: protectedObject.role,
            mediaKind: protectedObject.mediaKind,
            contentType: protectedObject.contentType,
            displayName: protectedObject.displayName,
            summary: protectedObject.summary,
          };
        },
        prepare: async ({ entryId }) => {
          prepareEntryId = entryId;
          return protectedObject;
        },
      },
    });
  });

  it("get-file は明示target内のobjectだけをexporterへ渡す", async () => {
    const protectedObject = {
      objectId: "a".repeat(32),
      role: "evidence",
      mediaKind: "image",
      contentType: "image/png",
      displayName: "dialog.png",
      summary: "スクリーンショットでエラー状態を確認できる。",
      originalBytes: 128,
      storedBytes: 160,
      sha256: "b".repeat(64),
      keyId: "c".repeat(32),
    } satisfies MemoryV6AppendProtectedObjectInput;
    let exportInput: Parameters<NonNullable<MemoryV6ServiceDeps["protectedObjectExporter"]>["exportFile"]>[0] | null = null;

    await withService(async ({ service }) => {
      const principal = createLocalUserMemoryPrincipal();
      const append = await service.append(principal, appendRequest({
        idempotencyKey: "file-get-append-key",
        files: [{
          path: "C:/trace/dialog.png",
          summary: "スクリーンショットでエラー状態を確認できる。",
          role: "evidence",
          displayName: "dialog.png",
          contentType: "image/png",
        }],
      }));
      assert.equal("error" in append, false);

      const getFile = await service.getFile(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        objectId: protectedObject.objectId,
        outputPath: "C:/exports/dialog.png",
      });
      assert.equal("error" in getFile, false);
      assert.equal(getFile.objectId, protectedObject.objectId);
      assert.equal(getFile.entryId, append.entry.id);
      assert.equal(getFile.bytesWritten, 128);
      assert.equal(exportInput?.metadata.entryId, append.entry.id);
      assert.equal(exportInput?.metadata.keyId, protectedObject.keyId);
      assert.equal(exportInput?.outputPath, "C:/exports/dialog.png");

      const mismatch = await service.getFile(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-b" } },
        objectId: protectedObject.objectId,
        outputPath: "C:/exports/dialog.png",
      });
      assert.equal("error" in mismatch, true);
      assert.equal(mismatch.error.code, "MEMORY_FILE_NOT_FOUND");
    }, {
      protectedObjectImporter: {
        inspect: async () => ({
          originalBytes: protectedObject.originalBytes,
          role: protectedObject.role,
          mediaKind: protectedObject.mediaKind,
          contentType: protectedObject.contentType,
          displayName: protectedObject.displayName,
          summary: protectedObject.summary,
        }),
        prepare: async () => protectedObject,
      },
      protectedObjectExporter: {
        exportFile: async (input) => {
          exportInput = input;
          return { bytesWritten: input.metadata.originalBytes };
        },
      },
    });
  });

  it("file付きappendはimporterの入力エラーをdomain errorとして返す", async () => {
    await withService(async ({ service, storage }) => {
      const principal = createLocalUserMemoryPrincipal();
      const append = await service.append(principal, appendRequest({
        idempotencyKey: "file-append-import-error-key",
        files: [{
          path: "C:/trace/missing.png",
          summary: "Missing screenshot.",
          role: "evidence",
        }],
      }));

      assert.equal("error" in append, true);
      assert.equal(append.error.code, "MEMORY_INVALID_FIELD");
      assert.equal(append.error.field, "files[0].path");
      assert.match(append.error.message, /not readable/);
      assert.deepEqual(storage.searchEntries({ targets: [projectTarget], query: "Memory service" }).items, []);
    }, {
      protectedObjectImporter: {
        inspect: async () => {
          throw new MemoryProtectedObjectImportError(
            "MEMORY_INVALID_FIELD",
            "path",
            "Memory protected object input file is not readable.",
          );
        },
        prepare: async () => {
          throw new Error("prepare should not be called");
        },
      },
    });
  });

  it("file付きappendはimporter prepare失敗をdomain errorとして返しentryを作らない", async () => {
    await withService(async ({ service, storage }) => {
      const principal = createLocalUserMemoryPrincipal();
      const append = await service.append(principal, appendRequest({
        idempotencyKey: "file-append-prepare-error-key",
        files: [{
          path: "C:/trace/dialog.png",
          summary: "Screenshot.",
          role: "evidence",
        }],
      }));

      assert.equal("error" in append, true);
      assert.equal(append.error.code, "MEMORY_FILE_IMPORT_FAILED");
      assert.equal(append.error.field, "files[0]");
      assert.deepEqual(storage.searchEntries({ targets: [projectTarget], query: "Memory service" }).items, []);
    }, {
      protectedObjectImporter: {
        inspect: async () => ({
          originalBytes: 128,
          role: "evidence",
          mediaKind: "image",
          contentType: "image/png",
          displayName: "dialog.png",
          summary: "Screenshot.",
        }),
        prepare: async () => {
          throw new Error("safe storage unavailable");
        },
      },
    });
  });

  it("file付きappendのprepareは順次実行して同時read/encryptを避ける", async () => {
    const protectedObjects = [0, 1, 2].map((index) => ({
      objectId: `${index}`.repeat(32),
      role: "evidence",
      mediaKind: "image",
      contentType: "image/png",
      displayName: `dialog-${index}.png`,
      summary: `スクリーンショット ${index}。`,
      originalBytes: 128,
      storedBytes: 160,
      sha256: `${index + 1}`.repeat(64),
      keyId: `${index + 4}`.repeat(32),
    })) satisfies MemoryV6AppendProtectedObjectInput[];
    let activePrepareCount = 0;
    let maxPrepareConcurrency = 0;

    await withService(async ({ service }) => {
      const principal = createLocalUserMemoryPrincipal();
      const append = await service.append(principal, appendRequest({
        idempotencyKey: "sequential-prepare-append-key",
        files: protectedObjects.map((object) => ({
          path: `C:/trace/${object.displayName}`,
          summary: object.summary,
          role: object.role,
          displayName: object.displayName,
          contentType: object.contentType,
        })),
      }));
      assert.equal("error" in append, false);
      assert.equal(append.entry.files.length, 3);
      assert.equal(maxPrepareConcurrency, 1);
    }, {
      protectedObjectImporter: {
        inspect: async (file) => {
          const object = protectedObjects.find((item) => item.displayName === file.displayName);
          assert.ok(object);
          return {
            originalBytes: object.originalBytes,
            role: object.role,
            mediaKind: object.mediaKind,
            contentType: object.contentType,
            displayName: object.displayName,
            summary: object.summary,
          };
        },
        prepare: async ({ file }) => {
          activePrepareCount += 1;
          maxPrepareConcurrency = Math.max(maxPrepareConcurrency, activePrepareCount);
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          activePrepareCount -= 1;
          const object = protectedObjects.find((item) => item.displayName === file.displayName);
          assert.ok(object);
          return object;
        },
      },
    });
  });

  it("export-files はentry内のactive objectsをまとめてexporterへ渡す", async () => {
    const protectedObjects = [
      {
        objectId: "a".repeat(32),
        role: "evidence",
        mediaKind: "image",
        contentType: "image/png",
        displayName: "dialog.png",
        summary: "スクリーンショットでエラー状態を確認できる。",
        originalBytes: 128,
        storedBytes: 160,
        sha256: "b".repeat(64),
        keyId: "c".repeat(32),
      },
      {
        objectId: "d".repeat(32),
        role: "source",
        mediaKind: "text",
        contentType: "text/plain",
        displayName: "trace.txt",
        summary: "テキストログ。",
        originalBytes: 64,
        storedBytes: 96,
        sha256: "e".repeat(64),
        keyId: "f".repeat(32),
      },
    ] satisfies MemoryV6AppendProtectedObjectInput[];
    let exportInput: Parameters<NonNullable<MemoryV6ServiceDeps["protectedObjectExporter"]>["exportFiles"]>[0] | null = null;

    await withService(async ({ service }) => {
      const principal = createLocalUserMemoryPrincipal();
      const append = await service.append(principal, appendRequest({
        idempotencyKey: "file-export-append-key",
        files: protectedObjects.map((object) => ({
          path: `C:/trace/${object.displayName}`,
          summary: object.summary,
          role: object.role,
          displayName: object.displayName,
          contentType: object.contentType,
        })),
      }));
      assert.equal("error" in append, false);

      const exported = await service.exportFiles(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        entryId: append.entry.id,
        outputDirectoryPath: "C:/exports",
      });

      assert.equal("error" in exported, false);
      assert.equal(exported.entryId, append.entry.id);
      assert.equal(exported.outputDirectoryPath, "C:/exports");
      assert.equal(exported.exportedCount, 2);
      assert.deepEqual(exported.files.map((file) => file.objectId), protectedObjects.map((object) => object.objectId));
      assert.equal(exportInput?.metadata.length, 2);
      assert.equal(exportInput?.metadata[0]?.entryId, append.entry.id);
      assert.equal(exportInput?.outputDirectoryPath, "C:/exports");

      const mismatch = await service.exportFiles(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-b" } },
        entryId: append.entry.id,
        outputDirectoryPath: "C:/exports",
      });
      assert.equal("error" in mismatch, true);
      assert.equal(mismatch.error.code, "MEMORY_ENTRY_NOT_FOUND");
    }, {
      protectedObjectImporter: {
        inspect: async (file) => {
          const object = protectedObjects.find((item) => item.displayName === file.displayName);
          assert.ok(object);
          return {
            originalBytes: object.originalBytes,
            role: object.role,
            mediaKind: object.mediaKind,
            contentType: object.contentType,
            displayName: object.displayName,
            summary: object.summary,
          };
        },
        prepare: async ({ file }) => {
          const object = protectedObjects.find((item) => item.displayName === file.displayName);
          assert.ok(object);
          return object;
        },
      },
      protectedObjectExporter: {
        exportFile: async () => {
          throw new Error("export-files should use batch exporter");
        },
        exportFiles: async (input) => {
          exportInput = input;
          return {
            files: input.metadata.map((metadata) => ({
              objectId: metadata.objectId,
              outputPath: `C:/exports/${metadata.objectId}`,
              bytesWritten: metadata.originalBytes,
              contentType: metadata.contentType,
              displayName: metadata.displayName,
            })),
          };
        },
      },
    });
  });

  it("file付きappendはquota超過時にimporter prepareを呼ばずentryを作らない", async () => {
    let prepareCalled = false;
    await withService(async ({ service, storage }) => {
      const principal = createLocalUserMemoryPrincipal();
      const append = await service.append(principal, appendRequest({
        idempotencyKey: "file-append-quota-key",
        files: [{
          path: "C:/trace/huge.zip",
          summary: "Large trace archive.",
          role: "artifact",
        }],
      }));

      assert.equal("error" in append, true);
      assert.equal(append.error.code, "MEMORY_FILE_QUOTA_EXCEEDED");
      assert.equal(append.error.quotaBytes, MEMORY_FILE_QUOTA_MIN_BYTES);
      assert.equal(append.error.usedBytes, 0);
      assert.equal(append.error.incomingBytes, MEMORY_FILE_QUOTA_MIN_BYTES + 1);
      assert.equal(prepareCalled, false);
      assert.deepEqual(storage.searchEntries({ targets: [projectTarget], query: "Memory service" }).items, []);
    }, {
      protectedObjectImporter: {
        inspect: async () => ({
          originalBytes: MEMORY_FILE_QUOTA_MIN_BYTES + 1,
          role: "artifact",
          mediaKind: "archive",
          contentType: "application/zip",
          displayName: "",
          summary: "Large trace archive.",
        }),
        prepare: async () => {
          prepareCalled = true;
          return {
            objectId: "d".repeat(32),
            role: "artifact",
            mediaKind: "archive",
            contentType: "application/zip",
            displayName: "",
            summary: "Large trace archive.",
            originalBytes: MEMORY_FILE_QUOTA_MIN_BYTES + 1,
            storedBytes: MEMORY_FILE_QUOTA_MIN_BYTES + 32,
            sha256: "e".repeat(64),
            keyId: "f".repeat(32),
          };
        },
      },
    });
  });

  it("explicit character ID targetを扱い、character.currentはvalidationで拒否する", async () => {
    await withService(async ({ service }) => {
      const principal = createLocalUserMemoryPrincipal();
      const append = await service.append(principal, appendRequest({
        target: {
          owner: "character",
          scope: "character",
          character: { type: "id", id: "character-a" },
        },
        idempotencyKey: "character-id-append",
      }));
      assert.equal("error" in append, false);
      assert.equal(append.entry.owner.type, "character");
      assert.equal(append.entry.owner.id, "character-a");

      const currentCharacter = service.search(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "character", scope: "character", character: { type: "current" } }],
        query: "memory",
      });
      assert.equal("error" in currentCharacter, true);
      assert.equal(currentCharacter.error.code, "MEMORY_INVALID_FIELD");
      assert.equal(currentCharacter.error.field, "targets[0].character.type");
    });
  });

  it("runtime project resolver はproject.pathからV6 project scopeを作成して解決する", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-v6-project-resolver-"));
    const workspacePath = join(tempDirectory, "repo");
    await mkdir(join(workspacePath, ".git"), { recursive: true });
    const { dbPath } = await createOrVerifyV6FreshDatabase(tempDirectory);
    const storage = new MemoryV6Storage(dbPath);
    const service = new MemoryV6Service({
      storage,
      ...createMemoryV6ProjectResolver(dbPath),
    });
    try {
      const principal = createLocalUserMemoryPrincipal();
      const append = await service.append(principal, appendRequest({
        target: {
          owner: "project",
          scope: "project",
          project: { type: "path", path: workspacePath },
        },
      }));
      assert.equal("error" in append, false);

      const search = service.search(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "path", path: workspacePath } }],
        query: "agent payload",
      });
      assert.equal("error" in search, false);
      assert.deepEqual(search.items.map((item) => item.id), [append.entry.id]);
    } finally {
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});

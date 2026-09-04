import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { MEMORY_V6_SCHEMA_VERSION, type NormalizedMemoryTag } from "../../src/memory-v6/memory-contract.js";
import { MEMORY_FILE_QUOTA_MIN_BYTES } from "../../src/provider-settings-state.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { MemoryProtectedObjectImportError } from "../../src-electron/memory-protected-object-importer.js";
import { createMemoryV6ProjectResolver, listMemoryV6ProjectScopes } from "../../src-electron/memory-v6-project-resolver.js";
import {
  LOCAL_USER_MEMORY_PERMISSIONS,
  createLocalUserMemoryPrincipal,
  type MemoryV6SessionBindingPrincipal,
} from "../../src-electron/memory-v6-permission.js";
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
  runner: (input: { service: MemoryV6Service; storage: MemoryV6Storage; dbPath: string }) => T | Promise<T>,
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
    listCharacters: () => ["a", "b"].map((suffix) => ({
      id: `character-${suffix}`,
      name: `Character ${suffix.toUpperCase()}`,
      description: "Test character",
      iconFilePath: "",
      theme: { main: "#111111", sub: "#222222" },
      state: "active" as const,
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
      archivedAt: null,
    })),
    resolveProjectById: (id) => ({ id, displayName: id }),
    resolveProjectByPath: (projectPath) => projectPath === "C:/workspace/project-a"
      ? { id: "project-a", displayName: "Project A" }
      : null,
    resolveKnownProjectByPath: (projectPath) => projectPath === "C:/workspace/project-a"
      ? { id: "project-a", displayName: "Project A" }
      : null,
    resolveCharacterById: (id) => id === "character-a" || id === "character-b"
      ? { id, name: id === "character-a" ? "Character A" : "Character B" }
      : null,
  });
  try {
    return await runner({ service, storage, dbPath });
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

function createSessionBindingPrincipal(
  characterId = "character-a",
  allowedProjectIds?: readonly string[],
): MemoryV6SessionBindingPrincipal {
  return {
    type: "session_binding",
    bindingIdHash: "binding-a",
    sessionId: "session-a",
    providerId: "codex",
    characterId,
    ...(allowedProjectIds ? { allowedProjectIds } : {}),
    permissions: LOCAL_USER_MEMORY_PERMISSIONS,
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
      }, {
        id: "character-b",
        name: "Character B",
        description: "Test character",
      }]);
      assert.equal("isDefault" in characters.characters[0], false);
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

  it("session bindingはuser-global、Project、自Characterを扱い、別CharacterのCRUDを拒否する", async () => {
    await withService(async ({ service }) => {
      const principal = createSessionBindingPrincipal();
      const allowedTargets = [
        { owner: "user", scope: "global" },
        { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        { owner: "character", scope: "character", character: { type: "id", id: "character-a" } },
        {
          owner: "character",
          scope: "project",
          character: { type: "id", id: "character-a" },
          project: { type: "id", id: "project-a" },
        },
      ];
      for (const target of allowedTargets) {
        const result = service.search(principal, {
          schemaVersion: MEMORY_V6_SCHEMA_VERSION,
          targets: [target],
          query: "Memory",
        });
        assert.equal("error" in result, false);
      }

      const otherTarget = {
        owner: "character",
        scope: "character",
        character: { type: "id", id: "character-b" },
      };
      const append = await service.append(principal, appendRequest({
        target: otherTarget,
        idempotencyKey: "session-binding-other-character",
      }));
      assert.equal("error" in append, true);
      assert.equal(append.error.code, "MEMORY_FORBIDDEN");

      const search = service.search(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [otherTarget],
        query: "Memory",
      });
      assert.equal("error" in search, true);
      assert.equal(search.error.code, "MEMORY_FORBIDDEN");

      const missingOtherCharacter = service.search(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{
          owner: "character",
          scope: "character",
          character: { type: "id", id: "character-missing" },
        }],
        query: "Memory",
      });
      assert.equal("error" in missingOtherCharacter, true);
      assert.equal(missingOtherCharacter.error.code, "MEMORY_FORBIDDEN");

      const forget = service.forget(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: otherTarget,
        entryIds: ["unknown"],
        reason: "user_request",
        idempotencyKey: "session-binding-forget-other-character",
      });
      assert.equal("error" in forget, true);
      assert.equal(forget.error.code, "MEMORY_FORBIDDEN");

      const move = service.moveEntry(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId: "unknown",
        from: allowedTargets[2],
        to: otherTarget,
        reason: "move to requested target",
        idempotencyKey: "session-binding-move-other-character",
      });
      assert.equal("error" in move, true);
      assert.equal(move.error.code, "MEMORY_FORBIDDEN");
    });
  });

  it("session bindingのtarget inventoryは別Characterをpagination前に除外する", async () => {
    await withService(({ service, storage }) => {
      for (const characterId of ["character-a", "character-b"]) {
        storage.appendEntry({
          id: `mem-${characterId}`,
          target: {
            owner: { type: "character", id: characterId },
            scope: { type: "character", id: characterId },
          },
          kind: "note",
          title: characterId,
          body: `${characterId} body`,
          preview: characterId,
          tags: [],
          source: { type: "agent", sessionId: null, messageId: null, providerId: "codex" },
        });
      }

      const result = service.listTargets(createSessionBindingPrincipal(), {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        owner: "character",
        limit: 1,
      });

      assert.equal("error" in result, false);
      assert.deepEqual(result.items.map((item) => item.target.character?.id), ["character-a"]);
      assert.equal(result.nextCursor, undefined);
    });
  });

  // @test-value v1
  // kind = "security"
  // claim = "session bindingのtarget inventoryは未許可Projectをpaginationとcursor生成より前に除外する"
  // oracle = { type = "adr", ref = "ADR-024 actor-relative Memory target authority" }
  // failure_mode = "未許可Projectがpageを消費する、または未許可target IDを含むcursorが返る"
  // scope = "memory-service-list-targets-project-authority"
  // lifecycle = "permanent"
  // @end-test-value
  it("session bindingのtarget inventoryは未許可Projectをpagination前に除外する", async () => {
    await withService(({ service, storage }) => {
      for (const projectId of ["project-a", "project-b"]) {
        storage.appendEntry({
          id: `mem-${projectId}`,
          target: {
            owner: { type: "project", id: projectId },
            scope: { type: "project", id: projectId },
          },
          kind: "note",
          title: projectId,
          body: `${projectId} body`,
          preview: projectId,
          tags: [],
          source: { type: "agent", sessionId: null, messageId: null, providerId: "codex" },
        });
      }

      const result = service.listTargets(createSessionBindingPrincipal("character-a", ["project-a"]), {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        owner: "project",
        limit: 1,
      });

      assert.equal("error" in result, false);
      assert.deepEqual(result.items.map((item) => item.target.project?.id), ["project-a"]);
      assert.equal(result.nextCursor, undefined);
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

  it("bound Sessionのfile usageは他Characterのlargest entry候補を返さない", async () => {
    await withService(async ({ service, dbPath }) => {
      const appendEntry = async (title: string, target: Record<string, unknown>, idempotencyKey: string) => {
        const result = await service.append(createLocalUserMemoryPrincipal(), appendRequest({
          title,
          preview: `${title} preview`,
          target,
          idempotencyKey,
        }));
        if ("error" in result) {
          throw new Error(result.error.message);
        }
        return result.entry.id;
      };
      const otherCharacterEntryId = await appendEntry("Other Character", {
        owner: "character",
        scope: "character",
        character: { type: "id", id: "character-b" },
      }, "file-usage-other-character");
      const ownCharacterEntryId = await appendEntry("Own Character", {
        owner: "character",
        scope: "character",
        character: { type: "id", id: "character-a" },
      }, "file-usage-own-character");
      const projectEntryId = await appendEntry("Project", {
        owner: "project",
        scope: "project",
        project: { type: "id", id: "project-a" },
      }, "file-usage-project");

      const db = new DatabaseSync(dbPath);
      try {
        const insert = db.prepare(`
          INSERT INTO memory_protected_objects_v6 (
            object_id, entry_id, state, role, media_kind, summary,
            original_bytes, stored_bytes, created_at, updated_at, deleted_at
          ) VALUES (?, ?, 'active', 'evidence', 'image', ?, ?, ?, ?, ?, NULL)
        `);
        for (const [objectId, entryId, title, bytes] of [
          ["b".repeat(32), otherCharacterEntryId, "Other Character", 8192],
          ["a".repeat(32), ownCharacterEntryId, "Own Character", 4096],
          ["c".repeat(32), projectEntryId, "Project", 2048],
        ] as const) {
          insert.run(objectId, entryId, `${title} file`, bytes, bytes, "2026-07-04T00:00:00.000Z", "2026-07-04T00:00:00.000Z");
        }
      } finally {
        db.close();
      }

      const usage = service.fileUsage(createSessionBindingPrincipal("character-a"), {
        includeLargestEntries: true,
        largestLimit: 10,
      });

      assert.equal("error" in usage, false);
      assert.deepEqual(usage.largestEntries?.map((entry) => entry.entryId), [
        ownCharacterEntryId,
        projectEntryId,
      ]);
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

  it("同じidempotency keyの同時file appendはreplay側の準備済みobjectを破棄する", async () => {
    const discardedObjectIds: string[] = [];
    let prepareCount = 0;
    let releasePreparations: (() => void) | null = null;
    const bothPrepared = new Promise<void>((resolve) => {
      releasePreparations = resolve;
    });

    await withService(async ({ service, storage }) => {
      const principal = createLocalUserMemoryPrincipal();
      const request = appendRequest({
        idempotencyKey: "concurrent-file-append-key",
        files: [{ path: "C:/trace/dialog.png", summary: "Screenshot.", role: "evidence" }],
      });
      const [first, second] = await Promise.all([
        service.append(principal, request),
        service.append(principal, request),
      ]);

      assert.equal("error" in first, false);
      assert.equal("error" in second, false);
      assert.equal(first.entry.id, second.entry.id);
      assert.equal([first.replayed, second.replayed].filter(Boolean).length, 1);
      assert.equal(discardedObjectIds.length, 1);
      assert.deepEqual(storage.getFileUsage(), {
        usedBytes: 128,
        physicalBytes: 160,
        pendingDeleteBytes: 0,
        objectCount: 1,
        pendingDeleteCount: 0,
      });
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
          prepareCount += 1;
          const preparationIndex = prepareCount;
          if (prepareCount === 2) {
            releasePreparations?.();
          }
          await bothPrepared;
          return {
            objectId: preparationIndex === 1 ? "1".repeat(32) : "2".repeat(32),
            role: "evidence",
            mediaKind: "image",
            contentType: "image/png",
            displayName: "dialog.png",
            summary: "Screenshot.",
            originalBytes: 128,
            storedBytes: 160,
            sha256: "3".repeat(64),
            keyId: "4".repeat(32),
          };
        },
        discardPrepared: async ({ objectId }) => {
          discardedObjectIds.push(objectId);
        },
      },
    });
  });

  it("同じidempotency keyの複数file appendでreplay cleanupの成否が混在してもpartialを永続化する", async () => {
    let prepareCount = 0;
    let discardCount = 0;
    let releasePreparations: (() => void) | null = null;
    let releaseFailedCleanup: (() => void) | null = null;
    const bothPrepared = new Promise<void>((resolve) => {
      releasePreparations = resolve;
    });
    const failedCleanupObserved = new Promise<void>((resolve) => {
      releaseFailedCleanup = resolve;
    });

    await withService(async ({ service, dbPath }) => {
      const principal = createLocalUserMemoryPrincipal();
      const request = appendRequest({
        idempotencyKey: "concurrent-file-cleanup-failure",
        files: [{ path: "C:/trace/dialog.png", summary: "Screenshot.", role: "evidence" }],
      });
      const results = await Promise.all([
        service.append(principal, request),
        service.append(principal, request),
        service.append(principal, request),
      ]);
      const cleanupFailure = results.find((result) => "error" in result);
      assert.ok(cleanupFailure && "error" in cleanupFailure);
      assert.equal(cleanupFailure.error.code, "MEMORY_FILE_CLEANUP_FAILED");
      assert.equal(cleanupFailure.error.effect, "partial");
      assert.equal(results.filter((result) => !("error" in result)).length, 2);
      const db = new (await import("node:sqlite")).DatabaseSync(dbPath, { readOnly: true });
      let persistedRequestFingerprint = "";
      try {
        const row = db.prepare("SELECT cleanup_pending_count, request_fingerprint FROM memory_idempotency_keys_v6 WHERE key = ?").get("concurrent-file-cleanup-failure") as {
          cleanup_pending_count: number;
          request_fingerprint: string;
        };
        assert.equal(row.cleanup_pending_count, 1);
        persistedRequestFingerprint = row.request_fingerprint;
      } finally {
        db.close();
      }
      const reopenedStorage = new MemoryV6Storage(dbPath);
      try {
        const replay = reopenedStorage.resolveAppendIdempotencyReplay({
          target: projectTarget,
          idempotencyKey: "concurrent-file-cleanup-failure",
          bindingIdHash: principal.bindingIdHash,
          requestFingerprint: persistedRequestFingerprint,
        });
        assert.equal(replay?.cleanupRequired, true);
      } finally {
        reopenedStorage.close();
      }
      const retry = await service.append(principal, request);
      assert.equal("error" in retry, true);
      assert.equal(retry.error.code, "MEMORY_FILE_CLEANUP_FAILED");
      assert.equal(retry.error.effect, "partial");
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
          prepareCount += 1;
          const preparationIndex = prepareCount;
          if (prepareCount === 3) {
            releasePreparations?.();
          }
          await bothPrepared;
          return {
            objectId: ["5", "6", "9"][preparationIndex - 1]!.repeat(32),
            role: "evidence",
            mediaKind: "image",
            contentType: "image/png",
            displayName: "dialog.png",
            summary: "Screenshot.",
            originalBytes: 128,
            storedBytes: 160,
            sha256: "7".repeat(64),
            keyId: "8".repeat(32),
          };
        },
        discardPrepared: async () => {
          discardCount += 1;
          if (discardCount === 1) {
            releaseFailedCleanup?.();
            throw new Error("simulated cleanup failure");
          }
          await failedCleanupObserved;
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

  it("file付きappendはprepare途中の失敗で準備済みobjectを破棄する", async () => {
    const preparedObject = {
      objectId: "a".repeat(32),
      role: "evidence",
      mediaKind: "image",
      contentType: "image/png",
      displayName: "dialog-0.png",
      summary: "Screenshot 0.",
      originalBytes: 128,
      storedBytes: 160,
      sha256: "1".repeat(64),
      keyId: "4".repeat(32),
    } satisfies MemoryV6AppendProtectedObjectInput;
    const discardedObjectIds: string[] = [];

    await withService(async ({ service, storage }) => {
      const principal = createLocalUserMemoryPrincipal();
      const append = await service.append(principal, appendRequest({
        idempotencyKey: "file-append-partial-prepare-error-key",
        files: [
          {
            path: "C:/trace/dialog-0.png",
            summary: "Screenshot 0.",
            role: "evidence",
          },
          {
            path: "C:/trace/dialog-1.png",
            summary: "Screenshot 1.",
            role: "evidence",
          },
        ],
      }));

      assert.equal("error" in append, true);
      assert.equal(append.error.code, "MEMORY_FILE_IMPORT_FAILED");
      assert.equal(append.error.field, "files[1]");
      assert.deepEqual(discardedObjectIds, [preparedObject.objectId]);
      assert.deepEqual(storage.searchEntries({ targets: [projectTarget], query: "Memory service" }).items, []);
    }, {
      protectedObjectImporter: {
        inspect: async (file) => ({
          originalBytes: 128,
          role: "evidence",
          mediaKind: "image",
          contentType: "image/png",
          displayName: file.path.endsWith("dialog-0.png") ? "dialog-0.png" : "dialog-1.png",
          summary: file.summary,
        }),
        prepare: async ({ file }) => {
          if (file.path.endsWith("dialog-1.png")) {
            throw new Error("safe storage unavailable");
          }
          return preparedObject;
        },
        discardPrepared: async ({ objectId }) => {
          discardedObjectIds.push(objectId);
        },
      },
    });
  });

  it("file付きappendはDB append失敗時に準備済みobjectを破棄する", async () => {
    const protectedObject = {
      objectId: "b".repeat(32),
      role: "evidence",
      mediaKind: "image",
      contentType: "image/png",
      displayName: "dialog.png",
      summary: "Screenshot.",
      originalBytes: 128,
      storedBytes: 160,
      sha256: "2".repeat(64),
      keyId: "5".repeat(32),
    } satisfies MemoryV6AppendProtectedObjectInput;
    const discardedObjectIds: string[] = [];

    await withService(async ({ service, storage }) => {
      const principal = createLocalUserMemoryPrincipal();
      const append = await service.append(principal, appendRequest({
        idempotencyKey: "file-append-db-error-key",
        supersedes: ["missing-entry"],
        files: [{
          path: "C:/trace/dialog.png",
          summary: "Screenshot.",
          role: "evidence",
        }],
      }));

      assert.equal("error" in append, true);
      assert.equal(append.error.code, "MEMORY_ENTRY_NOT_FOUND");
      assert.deepEqual(discardedObjectIds, [protectedObject.objectId]);
      assert.deepEqual(storage.searchEntries({ targets: [projectTarget], query: "Memory service" }).items, []);
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
        discardPrepared: async ({ objectId }) => {
          discardedObjectIds.push(objectId);
        },
      },
    });
  });

  it("file付きappendのDB失敗後にcleanupも失敗した場合は元errorを保持したpartial errorを返す", async () => {
    const protectedObject = {
      objectId: "9".repeat(32),
      role: "evidence",
      mediaKind: "image",
      contentType: "image/png",
      displayName: "dialog.png",
      summary: "Screenshot.",
      originalBytes: 128,
      storedBytes: 160,
      sha256: "a".repeat(64),
      keyId: "b".repeat(32),
    } satisfies MemoryV6AppendProtectedObjectInput;

    await withService(async ({ service }) => {
      const append = await service.append(createLocalUserMemoryPrincipal(), appendRequest({
        idempotencyKey: "file-append-db-cleanup-error-key",
        supersedes: ["missing-entry"],
        files: [{ path: "C:/trace/dialog.png", summary: "Screenshot.", role: "evidence" }],
      }));
      assert.equal("error" in append, true);
      assert.equal(append.error.code, "MEMORY_FILE_CLEANUP_FAILED");
      assert.equal(append.error.effect, "partial");
      assert.equal(append.error.details?.originalCode, "MEMORY_ENTRY_NOT_FOUND");
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
        discardPrepared: async () => {
          throw new Error("simulated cleanup failure");
        },
      },
    });
  });

  it("file付きappendのgeneric DB失敗後にcleanupも失敗した場合はstorage errorを保持したpartial errorを返す", async () => {
    const protectedObject = {
      objectId: "f".repeat(32),
      role: "evidence",
      mediaKind: "image",
      contentType: "image/png",
      displayName: "dialog.png",
      summary: "Screenshot.",
      originalBytes: 128,
      storedBytes: 160,
      sha256: "1".repeat(64),
      keyId: "2".repeat(32),
    } satisfies MemoryV6AppendProtectedObjectInput;

    await withService(async ({ service, storage }) => {
      Object.defineProperty(storage, "appendEntry", {
        value: () => {
          throw new Error("disk I/O error");
        },
      });
      const append = await service.append(createLocalUserMemoryPrincipal(), appendRequest({
        idempotencyKey: "file-append-generic-db-cleanup-error-key",
        files: [{ path: "C:/trace/dialog.png", summary: "Screenshot.", role: "evidence" }],
      }));
      assert.equal("error" in append, true);
      assert.equal(append.error.code, "MEMORY_FILE_CLEANUP_FAILED");
      assert.equal(append.error.effect, "partial");
      assert.equal(append.error.details?.originalCode, "MEMORY_STORAGE_UNAVAILABLE");
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
        discardPrepared: async () => {
          throw new Error("simulated cleanup failure");
        },
      },
    });
  });

  it("file付きappendのprepare途中失敗後にcleanupも失敗した場合はpartial errorを返す", async () => {
    let prepareCount = 0;
    await withService(async ({ service }) => {
      const append = await service.append(createLocalUserMemoryPrincipal(), appendRequest({
        idempotencyKey: "file-append-prepare-cleanup-error-key",
        files: [
          { path: "C:/trace/first.png", summary: "First.", role: "evidence" },
          { path: "C:/trace/second.png", summary: "Second.", role: "evidence" },
        ],
      }));
      assert.equal("error" in append, true);
      assert.equal(append.error.code, "MEMORY_FILE_CLEANUP_FAILED");
      assert.equal(append.error.effect, "partial");
      assert.equal(append.error.details?.originalCode, "MEMORY_FILE_IMPORT_FAILED");
    }, {
      protectedObjectImporter: {
        inspect: async (file) => ({
          originalBytes: 128,
          role: "evidence",
          mediaKind: "image",
          contentType: "image/png",
          displayName: file.path,
          summary: file.summary,
        }),
        prepare: async () => {
          prepareCount += 1;
          if (prepareCount === 2) {
            throw new Error("simulated prepare failure");
          }
          return {
            objectId: "c".repeat(32),
            role: "evidence",
            mediaKind: "image",
            contentType: "image/png",
            displayName: "first.png",
            summary: "First.",
            originalBytes: 128,
            storedBytes: 160,
            sha256: "d".repeat(64),
            keyId: "e".repeat(32),
          };
        },
        discardPrepared: async () => {
          throw new Error("simulated cleanup failure");
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
    const destinationWorkspacePath = join(tempDirectory, "destination-repo");
    await mkdir(join(workspacePath, ".git"), { recursive: true });
    await mkdir(join(destinationWorkspacePath, ".git"), { recursive: true });
    const { dbPath } = await createOrVerifyV6FreshDatabase(tempDirectory);
    const storage = new MemoryV6Storage(dbPath);
    const service = new MemoryV6Service({
      storage,
      ...createMemoryV6ProjectResolver(dbPath),
    });
    try {
      const principal = createLocalUserMemoryPrincipal();
      const searchBeforeAppend = service.search(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "path", path: workspacePath } }],
        query: "agent payload",
      });
      assert.equal("error" in searchBeforeAppend, false);
      assert.equal(listMemoryV6ProjectScopes(dbPath).length, 0);

      const forgetDryRun = service.forget(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "path", path: workspacePath } },
        entryIds: ["missing-entry"],
        reason: "user_request",
        dryRun: true,
      });
      assert.equal("error" in forgetDryRun, false);
      assert.equal(forgetDryRun.writeOccurred, false);
      assert.equal(listMemoryV6ProjectScopes(dbPath).length, 0);

      const failedAppend = await service.append(principal, appendRequest({
        target: {
          owner: "project",
          scope: "project",
          project: { type: "path", path: workspacePath },
        },
        supersedes: ["missing-entry"],
      }));
      assert.equal("error" in failedAppend, true);
      assert.equal(failedAppend.error.code, "MEMORY_ENTRY_NOT_FOUND");
      assert.equal(failedAppend.error.effect, "none");
      assert.equal(listMemoryV6ProjectScopes(dbPath).length, 0);

      const failedMove = service.moveEntry(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId: "missing-entry",
        from: { owner: "user", scope: "global" },
        to: { owner: "project", scope: "project", project: { type: "path", path: destinationWorkspacePath } },
        reason: "move to project scope",
        idempotencyKey: "missing-move",
      });
      assert.equal("error" in failedMove, true);
      assert.equal(failedMove.error.code, "MEMORY_ENTRY_NOT_FOUND");
      assert.equal(failedMove.error.effect, "none");
      assert.equal(listMemoryV6ProjectScopes(dbPath).length, 0);

      const forgetMissing = service.forget(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "path", path: destinationWorkspacePath } },
        entryIds: ["missing-entry"],
        reason: "user_request",
        idempotencyKey: "forget-missing-project",
      });
      assert.equal("error" in forgetMissing, false);
      assert.equal(forgetMissing.results[0].status, "not_found");
      assert.equal(listMemoryV6ProjectScopes(dbPath).length, 0);

      const append = await service.append(principal, appendRequest({
        target: {
          owner: "project",
          scope: "project",
          project: { type: "path", path: workspacePath },
        },
      }));
      assert.equal("error" in append, false);
      assert.equal(listMemoryV6ProjectScopes(dbPath).length, 1);

      const moved = service.moveEntry(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId: append.entry.id,
        from: { owner: "project", scope: "project", project: { type: "path", path: workspacePath } },
        to: { owner: "project", scope: "project", project: { type: "path", path: destinationWorkspacePath } },
        reason: "move to destination project",
        idempotencyKey: "move-to-new-project",
      });
      assert.equal("error" in moved, false);
      assert.equal(listMemoryV6ProjectScopes(dbPath).length, 2);

      const search = service.search(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "path", path: destinationWorkspacePath } }],
        query: "agent payload",
      });
      assert.equal("error" in search, false);
      assert.deepEqual(search.items.map((item) => item.id), [append.entry.id]);
    } finally {
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("maintenance read APIはinventory、query-free listing、tag stats、auditをbody非公開で返す", async () => {
    await withService(async ({ service, storage }) => {
      const principal = createLocalUserMemoryPrincipal();
      storage.appendEntry({
        target: projectTarget,
        kind: "context",
        title: "PR opened",
        body: "full body must stay hidden by default",
        preview: "Next review is pending.",
        tags: [tag("topic", "maintenance")],
        source: { type: "agent", sessionId: null, messageId: null, providerId: "codex" },
        id: "mem-maintenance",
        now: "2026-01-01T00:00:00.000Z",
      });

      const targets = service.listTargets(principal, { schemaVersion: MEMORY_V6_SCHEMA_VERSION });
      assert.equal("error" in targets, false);
      assert.equal(targets.items[0].entryCount, 1);

      const listed = service.listEntries(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        limit: 100,
      });
      assert.equal("error" in listed, false);
      assert.equal("body" in listed.items[0], false);
      const listedWithBody = service.listEntries(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        includeBody: true,
      });
      assert.equal("error" in listedWithBody, false);
      assert.equal(listedWithBody.items[0].body, "full body must stay hidden by default");

      const tags = service.listTags(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }],
        withCounts: true,
        sampleLimit: 1,
      });
      assert.equal("error" in tags, false);
      assert.equal(tags.tags[0].entryCount, 1);
      assert.deepEqual(tags.tags[0].samples?.map((sample) => sample.id), ["mem-maintenance"]);

      const audit = service.audit(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        allTargets: true,
        staleBefore: "2026-06-01T00:00:00.000Z",
      });
      assert.equal("error" in audit, false);
      assert.equal(audit.targets[0].staleOrProgressCandidates[0].id, "mem-maintenance");
      assert.equal(JSON.stringify(audit).includes("full body must stay hidden"), false);
    });
  });

  it("list-tagsはlimitとcursorでbounded pageを返す", async () => {
    await withService(async ({ service, storage }) => {
      const principal = createLocalUserMemoryPrincipal();
      for (let index = 0; index < 3; index += 1) {
        storage.appendEntry({
          target: projectTarget,
          kind: "context",
          title: `Tag ${index}`,
          body: `Tag body ${index}`,
          preview: `Tag ${index}`,
          tags: [tag("topic", `tag-${index}`)],
          source: { type: "agent", sessionId: null, messageId: null, providerId: "codex" },
          id: `mem-tag-${index}`,
          now: `2026-01-01T00:0${index}:00.000Z`,
        });
      }
      const target = [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }];
      const first = service.listTags(principal, { schemaVersion: MEMORY_V6_SCHEMA_VERSION, targets: target, limit: 2 });
      assert.equal("error" in first, false);
      assert.equal(first.tags.length, 2);
      assert.ok(first.nextCursor);
      const second = service.listTags(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: target,
        limit: 2,
        cursor: first.nextCursor,
      });
      assert.equal("error" in second, false);
      assert.equal(second.tags.length, 1);
      assert.equal(second.nextCursor, undefined);
      assert.equal(new Set([...first.tags, ...second.tags].map((item) => item.value)).size, 3);
      const invalidCursor = service.listTags(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: target,
        cursor: "cursor-a",
      });
      assert.equal("error" in invalidCursor, true);
      assert.equal(invalidCursor.error.code, "MEMORY_INVALID_FIELD");
      assert.equal(invalidCursor.error.field, "cursor");
    });
  });

  it("forgetはsourceMessageIdをidempotency tupleとmutation auditへ保持する", async () => {
    await withService(async ({ service, storage, dbPath }) => {
      const principal = createLocalUserMemoryPrincipal();
      storage.appendEntry({
        target: projectTarget,
        kind: "context",
        title: "Forget source",
        body: "Forget source body",
        preview: "Forget source",
        tags: [],
        source: { type: "agent", sessionId: null, messageId: null, providerId: "codex" },
        id: "mem-forget-source",
      });
      const request = {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        entryIds: ["mem-forget-source"],
        reason: "incorrect",
        sourceMessageId: "message-a",
        idempotencyKey: "forget-source-key",
      };
      const first = service.forget(principal, request);
      assert.equal("error" in first, false);
      const replay = service.forget(principal, request);
      assert.equal("error" in replay, false);
      assert.equal(replay.results[0].replayed, true);
      const conflict = service.forget(principal, { ...request, sourceMessageId: "message-b" });
      assert.equal("error" in conflict, true);
      assert.equal(conflict.error.code, "MEMORY_IDEMPOTENCY_CONFLICT");
      const db = new (await import("node:sqlite")).DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = db.prepare("SELECT source_message_id FROM memory_mutation_events_v6 WHERE operation = 'forget' AND entry_id = ?").get("mem-forget-source") as { source_message_id: string };
        assert.equal(row.source_message_id, "message-a");
      } finally {
        db.close();
      }
    });
  });

  it("forget dry-runはpreviewだけを返し、move-entryは明示target間でretargetしてretry収束する", async () => {
    await withService(async ({ service, storage }) => {
      const principal = createLocalUserMemoryPrincipal();
      storage.appendEntry({
        target: projectTarget,
        kind: "context",
        title: "CLI-wide note",
        body: "Move this note to user global.",
        preview: "CLI-wide note.",
        tags: [tag("topic", "cli")],
        source: { type: "agent", sessionId: null, messageId: null, providerId: "codex" },
        id: "mem-move",
      });
      const dryRun = service.forget(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        entryIds: ["mem-move", "missing"],
        dryRun: true,
      });
      assert.equal("error" in dryRun, false);
      assert.equal(dryRun.dryRun, true);
      assert.equal(dryRun.writeOccurred, false);
      assert.equal(dryRun.results[0].entry?.title, "CLI-wide note");
      assert.equal(storage.getEntry("mem-move")?.state, "active");

      const replaySeed = service.forget(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "user", scope: "global" },
        entryIds: ["mem-move"],
        idempotencyKey: "forget-after-move",
      });
      assert.equal("error" in replaySeed, false);
      assert.equal(replaySeed.results[0].status, "not_found");

      const request = {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId: "mem-move",
        from: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        to: { owner: "user", scope: "global" },
        reason: "move CLI note to user scope",
        idempotencyKey: "move-cli-note",
      };
      const moved = service.moveEntry(principal, request);
      assert.equal("error" in moved, false);
      assert.equal(moved.entry.owner.type, "user");
      const replayPreview = service.forget(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: request.to,
        entryIds: ["mem-move"],
        idempotencyKey: "forget-after-move",
        dryRun: true,
      });
      assert.equal("error" in replayPreview, false);
      assert.equal(replayPreview.results[0].status, "not_found");
      assert.equal(replayPreview.results[0].entry, undefined);
      assert.equal(storage.getEntry("mem-move")?.state, "active");
      const replay = service.moveEntry(principal, request);
      assert.equal("error" in replay, false);
      assert.equal(replay.entry.id, "mem-move");

      const oldTarget = service.listEntries(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: request.from,
      });
      assert.equal("error" in oldTarget, false);
      assert.deepEqual(oldTarget.items, []);
      const newTarget = service.listEntries(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: request.to,
      });
      assert.equal("error" in newTarget, false);
      assert.deepEqual(newTarget.items.map((entry) => entry.id), ["mem-move"]);
    });
  });
});

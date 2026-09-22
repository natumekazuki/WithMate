import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { MEMORY_V6_SCHEMA_VERSION, type NormalizedMemoryTag } from "../../src-shared/memory/memory-contract.js";
import type { MemoryErrorResponse } from "../../src-shared/memory/memory-response-contract.js";
import { MEMORY_FILE_QUOTA_MIN_BYTES } from "../../src-shared/settings/provider-settings-state.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/storage/app-database-v6-bootstrap.js";
import { MemoryProtectedObjectImportError } from "../../src-electron/memory/memory-protected-object-importer.js";
import { createMemoryV6ProjectResolver, listMemoryV6ProjectScopes } from "../../src-electron/memory/memory-v6-project-resolver.js";
import {
  LOCAL_USER_MEMORY_PERMISSIONS,
  createLocalUserMemoryPrincipal,
  type MemoryV6SessionBindingPrincipal,
} from "../../src-electron/memory/memory-v6-permission.js";
import type { MemoryV6ResolvedTarget } from "../../src-electron/memory/memory-v6-schema.js";
import { MemoryV6Service, type MemoryV6ServiceDeps } from "../../src-electron/memory/memory-v6-service.js";
import { MemoryV6Storage, type MemoryV6AppendProtectedObjectInput } from "../../src-electron/memory/memory-v6-storage.js";

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

function assertSuccess<T extends object>(value: T | MemoryErrorResponse): asserts value is T {
  assert.equal("error" in value, false);
}

function assertError<T extends object>(value: T | MemoryErrorResponse): asserts value is MemoryErrorResponse {
  assert.equal("error" in value, true);
}

describe("MemoryV6Service", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "明示target付きMemory操作とcharacter一覧の公開shapeを返す"
  // oracle = { type = "adr", ref = "docs/adr/024-provider-common-memory-mcp-boundary.md" }
  // fault = "明示target操作の成功応答が欠落または誤る"
  // observable = "append/search/get/list/forgetの戻り値とlistCharactersの公開shape"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service"
  // lifecycle = "permanent"
  // impact = "Memoryのtarget契約を維持する"
  // distinction = "service実動作を確認する"
  // @end-test-value
  it("local_user は明示project targetでappend / search / get-entry / list-tags / forgetを扱う", async () => {
    await withService(async ({ service }) => {
      const principal = createLocalUserMemoryPrincipal();
      const append = await service.append(principal, appendRequest({
        idempotencyKey: "local-user-project-append",
        sourceMessageId: "external-message-1",
      }));
      assertSuccess(append);
      assert.equal(append.entry.owner.id, "project-a");
      assert.equal(append.entry.state, "active");

      const search = await service.search(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "path", path: "C:/workspace/project-a" } }],
        query: "agent payload",
      });
      assertSuccess(search);
      assert.deepEqual(search.items.map((item) => item.id), [append.entry.id]);

      const detail = await service.getEntry(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId: append.entry.id,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
      });
      assertSuccess(detail);
      assert.equal(detail.entry.source.sessionId, null);
      assert.equal(detail.entry.source.providerId, "local-user");

      const tags = await service.listTags(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }],
      });
      assertSuccess(tags);
      assert.deepEqual(tags.tags, [{ type: "topic", value: "memory" }]);

      const characters = await service.listCharacters(principal);
      assertSuccess(characters);
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

      const forget = await service.forget(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        entryIds: [append.entry.id],
        reason: "user_request",
      });
      assertSuccess(forget);
      assert.deepEqual(forget.results, [{ entryId: append.entry.id, status: "forgotten" }]);
    });
  });

  // @test-value v2
  // kind = "contract"
  // claim = "session bindingのscope境界を維持する"
  // oracle = { type = "adr", ref = "docs/adr/024-provider-common-memory-mcp-boundary.md" }
  // fault = "別CharacterのCRUDを許可する"
  // observable = "scope別CRUD結果"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service"
  // lifecycle = "permanent"
  // impact = "Memory isolation"
  // distinction = "service境界を実動作で確認する"
  // @end-test-value
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
        const result = await service.search(principal, {
          schemaVersion: MEMORY_V6_SCHEMA_VERSION,
          targets: [target],
          query: "Memory",
        });
        assertSuccess(result);
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
      assertError(append);
      assert.equal(append.error.code, "MEMORY_FORBIDDEN");

      const search = await service.search(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [otherTarget],
        query: "Memory",
      });
      assertError(search);
      assert.equal(search.error.code, "MEMORY_FORBIDDEN");

      const missingOtherCharacter = await service.search(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{
          owner: "character",
          scope: "character",
          character: { type: "id", id: "character-missing" },
        }],
        query: "Memory",
      });
      assertError(missingOtherCharacter);
      assert.equal(missingOtherCharacter.error.code, "MEMORY_FORBIDDEN");

      const forget = await service.forget(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: otherTarget,
        entryIds: ["unknown"],
        reason: "user_request",
        idempotencyKey: "session-binding-forget-other-character",
      });
      assertError(forget);
      assert.equal(forget.error.code, "MEMORY_FORBIDDEN");

      const move = await service.moveEntry(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId: "unknown",
        from: allowedTargets[2],
        to: otherTarget,
        reason: "move to requested target",
        idempotencyKey: "session-binding-move-other-character",
      });
      assertError(move);
      assert.equal(move.error.code, "MEMORY_FORBIDDEN");
    });
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "target inventoryは許可外Characterをpagination前に除外する"
  // oracle = { type = "adr", ref = "docs/adr/024-provider-common-memory-mcp-boundary.md" }
  // fault = "許可外entryがpage境界を消費する"
  // observable = "inventory page"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service"
  // lifecycle = "permanent"
  // impact = "paginationとscope isolation"
  // distinction = "実DB検索結果を確認する"
  // @end-test-value
  it("session bindingのtarget inventoryは別Characterをpagination前に除外する", async () => {
    await withService(async ({ service, storage }) => {
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

      const result = await service.listTargets(createSessionBindingPrincipal("character-b"), {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        owner: "character",
        limit: 1,
      });

      assertSuccess(result);
      assert.deepEqual(result.items.map((item) => "character" in item.target ? item.target.character.id : undefined), ["character-b"]);
      assert.equal(result.nextCursor, undefined);
    });
  });

  // @test-value v2
  // kind = "security"
  // claim = "session bindingのtarget inventoryは未許可Projectをpaginationとcursor生成より前に除外する"
  // oracle = { type = "contract", ref = "docs/plans/20260812-general-memory-mcp/plan.md#GMCP-PROJECT-ADMISSION" }
  // fault = "未許可Projectがpageを消費するかcursorへ混入する"
  // observable = "許可済みProjectだけのinventory pageとcursor"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service"
  // lifecycle = "permanent"
  // impact = "project isolation"
  // distinction = "session bindingのservice実DB検索結果を確認する"
  // @end-test-value
  it("session bindingのtarget inventoryは未許可Projectをpagination前に除外する", async () => {
    await withService(async ({ service, storage }) => {
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

      const result = await service.listTargets(createSessionBindingPrincipal("character-a", ["project-b"]), {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        owner: "project",
        limit: 1,
      });

      assertSuccess(result);
      assert.deepEqual(result.items.map((item) => "project" in item.target && item.target.project.type === "id" ? item.target.project.id : undefined), ["project-b"]);
      assert.equal(result.nextCursor, undefined);
    });
  });

  // @test-value v2
  // kind = "contract"
  // claim = "get-entryは明示targetを要求しtarget外entryを返さない"
  // oracle = { type = "adr", ref = "docs/adr/024-provider-common-memory-mcp-boundary.md" }
  // fault = "target外entryを返す"
  // observable = "get-entry result"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service"
  // lifecycle = "permanent"
  // impact = "Memory disclosure prevention"
  // distinction = "service APIを実動作で確認する"
  // @end-test-value
  it("get-entry は必ず明示targetを要求し、target外entryを返さない", async () => {
    await withService(async ({ service, storage }) => {
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

      const missingTarget = await service.getEntry(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId: "mem-project-a",
      });
      assertError(missingTarget);
      assert.equal(missingTarget.error.code, "MEMORY_INVALID_FIELD");
      assert.equal(missingTarget.error.field, "target");

      const mismatchTarget = await service.getEntry(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId: "mem-project-a",
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-b" } },
      });
      assertError(mismatchTarget);
      assert.equal(mismatchTarget.error.code, "MEMORY_ENTRY_NOT_FOUND");
    });
  });

  // @test-value v2
  // kind = "contract"
  // claim = "file usageはquotaと空のprotected object集計を返す"
  // oracle = { type = "contract", ref = "docs/design/v6-memory-protected-objects.md" }
  // fault = "quotaまたは空のobject集計が欠落する"
  // observable = "file usage response"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service"
  // lifecycle = "permanent"
  // impact = "quota enforcement"
  // distinction = "service実動作を確認する"
  // @end-test-value
  it("file usage は quota と protected object 集計を返す", async () => {
    await withService(async ({ service }) => {
      const principal = createLocalUserMemoryPrincipal();
      const usage = await service.fileUsage(principal);

      assertSuccess(usage);
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

  // @test-value v2
  // kind = "contract"
  // claim = "largest entriesは要求時だけ返す"
  // oracle = { type = "contract", ref = "docs/design/v6-memory-protected-objects.md" }
  // fault = "不要な内部object情報を常時公開する"
  // observable = "file usage response"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service"
  // lifecycle = "permanent"
  // impact = "public payload minimization"
  // distinction = "service responseを確認する"
  // @end-test-value
  it("file usage は要求時だけlargest entriesを返す", async () => {
    await withService(async ({ service, storage }) => {
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

      const defaultUsage = await service.fileUsage(principal);
      assertSuccess(defaultUsage);
      assert.equal("largestEntries" in defaultUsage, false);

      const usage = await service.fileUsage(principal, { includeLargestEntries: true, largestLimit: 1 });
      assertSuccess(usage);
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

  // @test-value v2
  // kind = "invariant"
  // claim = "bound SessionのlargestEntriesに他Characterを含めない"
  // oracle = { type = "adr", ref = "docs/adr/021-agent-runtime-binding-authority-boundary.md" }
  // fault = "他Characterのlargest entryをlargestEntriesへ返す"
  // observable = "file usage response"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service"
  // lifecycle = "permanent"
  // impact = "scope isolation"
  // distinction = "bound session実動作を確認する"
  // @end-test-value
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

      const usage = await service.fileUsage(createSessionBindingPrincipal("character-a"), {
        includeLargestEntries: true,
        largestLimit: 10,
      });

      assertSuccess(usage);
      assert.deepEqual(usage.largestEntries?.map((entry) => entry.entryId), [
        ownCharacterEntryId,
        projectEntryId,
      ]);
    });
  });

  // @test-value v2
  // kind = "contract"
  // claim = "file付きappendは未実装契約を検証後に返し、再送でもentryを作らない"
  // oracle = { type = "contract", ref = "docs/plans/20260812-general-memory-mcp/plan.md#GMCP-FILE" }
  // fault = "未実装のfile appendが成功扱いになりentryまたはfile metadataを永続化する"
  // observable = "初回と同一idempotency keyの再送のerror code/fieldとtarget内entry検索結果"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service.file-append"
  // lifecycle = "permanent"
  // impact = "未提供のfile appendを成功として扱わず、重複保存を防ぐ"
  // distinction = "型検査では検出できないserviceのvalidation順序と永続副作用を実動作で確認する"
  // @end-test-value
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

      assertError(append);
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
      assertError(replay);
      assert.equal(replay.error.code, "MEMORY_FILE_APPEND_UNIMPLEMENTED");
    });
  });

  // @test-value v2
  // kind = "contract"
  // claim = "file付きappendはimporter metadataを一度だけ登録し、同一keyの再送をreplayする"
  // oracle = { type = "contract", ref = "docs/plans/20260812-general-memory-mcp/plan.md#GMCP-FILE" }
  // fault = "replayで再度inspectしてfile usageを二重計上する、またはcanonical entryと異なるentry IDへprepareする"
  // observable = "append/replayのentry identity、inspect回数、prepare entry ID、file usage"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service.file-append"
  // lifecycle = "permanent"
  // impact = "quotaとidempotent appendの永続file metadataが一致する"
  // distinction = "serviceからstorageのquota・importer・replay連携を同時に確認する"
  // @end-test-value
  it("file付きappendはimporter metadataを一度だけstorageへ登録する", async () => {
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

      assertSuccess(append);
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

      assertSuccess(replay);
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

  // @test-value v2
  // kind = "invariant"
  // claim = "同じidempotency keyの同時file appendはcanonical entryを一件だけ確定しreplay側objectを破棄する"
  // oracle = { type = "contract", ref = "docs/plans/20260812-general-memory-mcp/plan.md#GMCP-FILE-RETRY" }
  // fault = "並行replay側のprepared objectをcleanupせず孤立させる、またはentry/file usageを二重化する"
  // observable = "二つのresponseのentry ID/replayed状態、discard object数、file usage"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service.concurrent-file-append"
  // lifecycle = "permanent"
  // impact = "並行retry後もorphan protected objectと二重quota消費を残さない"
  // distinction = "同時実行のraceとcleanup到達性をservice integrationで確認する"
  // @end-test-value
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

      assertSuccess(first);
      assertSuccess(second);
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

  // @test-value v2
  // kind = "invariant"
  // claim = "並行file appendのcleanup成功と失敗が混在しても未完了cleanupをpartialとして永続化しretryへ伝える"
  // oracle = { type = "contract", ref = "docs/plans/20260812-general-memory-mcp/plan.md#GMCP-FILE-RETRY" }
  // fault = "cleanup成功が失敗分のpending countを消し、response loss後のretryを成功扱いにする"
  // observable = "partial error、cleanup_pending_count、再open replayのcleanupRequired、retry error"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service.concurrent-file-cleanup"
  // lifecycle = "permanent"
  // impact = "orphan object cleanupが未完了な状態をconsumerが見失わない"
  // distinction = "並行実行、DB read-back、再open後retryまでを一つのservice/storage経路で確認する"
  // @end-test-value
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
      assertError(retry);
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

  // @test-value v2
  // kind = "security"
  // claim = "get-fileは明示targetに属するobjectだけをexporterへ渡し、target不一致をnot foundで拒否する"
  // oracle = { type = "contract", ref = "docs/plans/20260812-general-memory-mcp/plan.md#GMCP-FILE" }
  // fault = "別targetのobjectをexporterへ渡す、またはexport先とmetadataのentry identityを混同する"
  // observable = "exporter inputのentry/object/key/output pathとtarget mismatchのerror code"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service.get-file"
  // lifecycle = "permanent"
  // impact = "protected objectのcross-target readと意図しないfile exportを防ぐ"
  // distinction = "service target照合からexporter side effectまでを実動作で確認する"
  // @end-test-value
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
      assertSuccess(append);

      const getFile = await service.getFile(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        objectId: protectedObject.objectId,
        outputPath: "C:/exports/dialog.png",
      });
      assertSuccess(getFile);
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
      assertError(mismatch);
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

  // @test-value v2
  // kind = "contract"
  // claim = "file付きappendはimporterの入力検証エラーをdomain errorへ投影しentryを作らない"
  // oracle = { type = "contract", ref = "docs/plans/20260812-general-memory-mcp/plan.md#GMCP-FILE" }
  // fault = "読めないfile pathを内部例外または成功へ変換し、空のentryを永続化する"
  // observable = "error code/field/messageとtarget内entry検索結果"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service.file-append-validation"
  // lifecycle = "permanent"
  // impact = "不正file inputを利用者が扱えるdomain failureとして安全に拒否する"
  // distinction = "importerの入力失敗がservice responseとstorage stateへ伝播することを確認する"
  // @end-test-value
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

      assertError(append);
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

  // @test-value v2
  // kind = "contract"
  // claim = "file付きappendのprepare失敗はdomain errorになりentryを作らない"
  // oracle = { type = "contract", ref = "docs/plans/20260812-general-memory-mcp/plan.md#GMCP-FILE" }
  // fault = "protected object prepareの例外を成功または未分類例外へ流し、部分entryを残す"
  // observable = "error code/fieldとtarget内entry検索結果"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service.file-append-preparation"
  // lifecycle = "permanent"
  // impact = "暗号化object準備失敗時に不完全なMemory entryを公開しない"
  // distinction = "外部importer failureの公開投影とatomicityをserviceで確認する"
  // @end-test-value
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

      assertError(append);
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

  // @test-value v2
  // kind = "invariant"
  // claim = "複数file appendのprepare途中失敗は既に準備したobjectを破棄しentryを作らない"
  // oracle = { type = "contract", ref = "docs/design/v6-memory-protected-objects.md#forget" }
  // fault = "後続fileのprepare失敗後に先行prepared objectをcleanupせずorphanとして残す"
  // observable = "error code/field、discard object IDs、target内entry検索結果"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service.file-append-cleanup"
  // lifecycle = "permanent"
  // impact = "部分的なobject保存による容量漏れと不可視データを防ぐ"
  // distinction = "multi-file prepare failureからcleanupと永続状態までを同時に確認する"
  // @end-test-value
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

      assertError(append);
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

  // @test-value v2
  // kind = "invariant"
  // claim = "file付きappendのDB append失敗はprepared objectを破棄しentryを作らない"
  // oracle = { type = "contract", ref = "docs/plans/20260812-general-memory-mcp/plan.md#GMCP-FILE" }
  // fault = "DB commit failure後にprepared objectを残す、または失敗entryを検索可能にする"
  // observable = "storage error code、discard object IDs、target内entry検索結果"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service.file-append-commit"
  // lifecycle = "permanent"
  // impact = "atomic append失敗で孤立したprotected objectを作らない"
  // distinction = "DB失敗から外部object cleanupへのservice settlementを確認する"
  // @end-test-value
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

      assertError(append);
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

  // @test-value v2
  // kind = "contract"
  // claim = "DB append失敗とcleanup失敗が重なる場合は元errorをdetailsへ保持したpartial errorを返す"
  // oracle = { type = "contract", ref = "docs/plans/20260812-general-memory-mcp/plan.md#GMCP-EFFECT" }
  // fault = "cleanup未完了を成功または元errorだけへ潰し、partial effectをconsumerへ伝えない"
  // observable = "cleanup error code/effectとdetails.originalCode"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service.file-cleanup-settlement"
  // lifecycle = "permanent"
  // impact = "orphan cleanupが未完了な事実と元のDB失敗を同時に回復経路へ渡す"
  // distinction = "二重失敗の公開error projectionを直接確認する"
  // @end-test-value
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
      assertError(append);
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

  // @test-value v2
  // kind = "contract"
  // claim = "generic DB失敗とcleanup失敗が重なる場合はstorage errorを元errorとして保持したpartial errorを返す"
  // oracle = { type = "contract", ref = "docs/plans/20260812-general-memory-mcp/plan.md#GMCP-EFFECT" }
  // fault = "generic storage failureを隠す、またはcleanup失敗をpartialへ投影しない"
  // observable = "cleanup error code/effectとdetails.originalCode"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service.file-cleanup-settlement"
  // lifecycle = "permanent"
  // impact = "利用者とoperatorがstorage failureと未完了cleanupを区別して復旧できる"
  // distinction = "既知domain errorでないDB failureの二重失敗投影を確認する"
  // @end-test-value
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
      assertError(append);
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

  // @test-value v2
  // kind = "contract"
  // claim = "prepare途中失敗とcleanup失敗が重なる場合は元のimport errorを保持したpartial errorを返す"
  // oracle = { type = "contract", ref = "docs/plans/20260812-general-memory-mcp/plan.md#GMCP-EFFECT" }
  // fault = "先行prepared objectのcleanup失敗を成功または単一import errorへ投影する"
  // observable = "cleanup error code/effectとdetails.originalCode"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service.file-cleanup-settlement"
  // lifecycle = "permanent"
  // impact = "partial object cleanupと元のprepare failureを回復処理へ渡す"
  // distinction = "prepare failure起点の二重失敗をservice public errorで確認する"
  // @end-test-value
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
      assertError(append);
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

  // @test-value v2
  // kind = "invariant"
  // claim = "file付きappendのinspectは並列化されてもprepareは一件ずつ実行され、同時encryptを発生させない"
  // oracle = { type = "contract", ref = "docs/plans/20260812-general-memory-mcp/plan.md#GMCP-FILE" }
  // fault = "複数fileを並行prepareしてresource concurrencyを一時に超える"
  // observable = "append成功時のfile countと観測した最大inspect/prepare concurrency"
  // observation_boundary = "component-behavior"
  // scope = "memory-v6-service.file-append-preparation"
  // lifecycle = "permanent"
  // impact = "file importの同時resource負荷を一件に制限する"
  // distinction = "外部importer mockの同時実行数を実測し、型や静的規約では代替できない"
  // @end-test-value
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
    let activeInspectCount = 0;
    let maxInspectConcurrency = 0;

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
      assertSuccess(append);
      assert.ok(append.entry.files);
      assert.equal(append.entry.files.length, 3);
      assert.equal(maxPrepareConcurrency, 1);
      assert.equal(maxInspectConcurrency, protectedObjects.length);
    }, {
      protectedObjectImporter: {
        inspect: async (file) => {
          activeInspectCount += 1;
          maxInspectConcurrency = Math.max(maxInspectConcurrency, activeInspectCount);
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          const object = protectedObjects.find((item) => item.displayName === file.displayName);
          assert.ok(object);
          activeInspectCount -= 1;
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

  // @test-value v2
  // kind = "contract"
  // claim = "export-filesは明示targetのentryに属するactive objectsをまとめてexporterへ渡す"
  // oracle = { type = "contract", ref = "docs/plans/20260812-general-memory-mcp/plan.md#GMCP-FILE" }
  // fault = "inactive/別entryのobjectを含める、対象外targetをexportする、またはmetadataを欠落させる"
  // observable = "export responseのentry/output/count/object IDsとexporter input metadata"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service.export-files"
  // lifecycle = "permanent"
  // impact = "複数protected objectのexport結果とtarget境界を一致させる"
  // distinction = "service target validation、active filtering、外部export inputを一つの経路で確認する"
  // @end-test-value
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
    const otherProtectedObject = {
      objectId: "g".repeat(32),
      role: "evidence" as const,
      mediaKind: "image" as const,
      contentType: "image/png",
      displayName: "other.png",
      summary: "別entryのobject。",
      originalBytes: 32,
      storedBytes: 48,
      sha256: "h".repeat(64),
      keyId: "i".repeat(32),
    } satisfies MemoryV6AppendProtectedObjectInput;
    const inactiveProtectedObject = {
      objectId: "j".repeat(32),
      role: "evidence" as const,
      mediaKind: "image" as const,
      contentType: "image/png",
      displayName: "inactive.png",
      summary: "同entryのinactive object。",
      originalBytes: 48,
      storedBytes: 64,
      sha256: "k".repeat(64),
      keyId: "l".repeat(32),
    } satisfies MemoryV6AppendProtectedObjectInput;
    let exportInput: Parameters<NonNullable<NonNullable<MemoryV6ServiceDeps["protectedObjectExporter"]>["exportFiles"]>>[0] | null = null;

    await withService(async ({ service, storage, dbPath }) => {
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
      assertSuccess(append);

      storage.appendEntry({
        id: "mem-other-entry",
        target: projectTarget,
        kind: "decision",
        title: "別entry",
        body: "別entryのobjectを除外する。",
        preview: "別entry",
        tags: [],
        source: { type: "agent", sessionId: null, messageId: null, providerId: "codex" },
      });
      const db = new DatabaseSync(dbPath);
      try {
        const insertProtectedObject = db.prepare(`
          INSERT INTO memory_protected_objects_v6 (
            object_id, entry_id, state, role, media_kind, content_type, display_name, summary,
            original_bytes, stored_bytes, sha256, key_id, created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        type DeletedObjectFixture = MemoryV6AppendProtectedObjectInput & {
          contentType: string;
          displayName: string;
        };
        const insertProtectedObjectRow = (object: DeletedObjectFixture, entryId: string, state: "active" | "deleted") => {
          insertProtectedObject.run(
            object.objectId,
            entryId,
            state,
            object.role,
            object.mediaKind,
            object.contentType,
            object.displayName,
            object.summary,
            object.originalBytes,
            object.storedBytes,
            object.sha256,
            object.keyId,
            "2026-07-04T00:00:00.000Z",
            "2026-07-04T00:00:00.000Z",
            state === "deleted" ? "2026-07-04T00:00:00.000Z" : null,
          );
        };
        insertProtectedObjectRow(inactiveProtectedObject, append.entry.id, "deleted");
        insertProtectedObjectRow(otherProtectedObject, "mem-other-entry", "active");
      } finally {
        db.close();
      }

      const exported = await service.exportFiles(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        entryId: append.entry.id,
        outputDirectoryPath: "C:/exports",
      });

      assertSuccess(exported);
      assert.equal(exported.entryId, append.entry.id);
      assert.equal(exported.outputDirectoryPath, "C:/exports");
      assert.equal(exported.exportedCount, 2);
      assert.deepEqual(exported.files.map((file) => file.objectId), protectedObjects.map((object) => object.objectId));
      assert.equal(exportInput?.metadata.length, 2);
      assert.equal(exportInput?.metadata[0]?.entryId, append.entry.id);
      assert.equal(exportInput?.metadata.every((metadata) => metadata.entryId === append.entry.id), true);
      assert.deepEqual(
        exportInput?.metadata.map((metadata) => metadata.objectId),
        protectedObjects.map((object) => object.objectId),
      );
      assert.equal(exportInput?.outputDirectoryPath, "C:/exports");

      const mismatch = await service.exportFiles(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-b" } },
        entryId: append.entry.id,
        outputDirectoryPath: "C:/exports",
      });
      assertError(mismatch);
      assert.equal(mismatch.error.code, "MEMORY_ENTRY_NOT_FOUND");
    }, {
      protectedObjectImporter: {
        inspect: async (file) => {
          const object = file.displayName === otherProtectedObject.displayName || file.path.endsWith("other.png")
            ? otherProtectedObject
            : protectedObjects.find((item) => item.displayName === file.displayName);
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
          const object = file.displayName === otherProtectedObject.displayName || file.path.endsWith("other.png")
            ? otherProtectedObject
            : protectedObjects.find((item) => item.displayName === file.displayName);
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

  // @test-value v2
  // kind = "invariant"
  // claim = "file付きappendはquota超過をprepare前に拒否しentryを作らない"
  // oracle = { type = "contract", ref = "docs/design/v6-memory-protected-objects.md#quota" }
  // fault = "quota preflightを省略してfileをprepareする、または超過appendをentryとして保存する"
  // observable = "quota errorのbytes内訳、prepare呼出有無、target内entry検索結果"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service.file-quota"
  // lifecycle = "permanent"
  // impact = "quota超過による容量上限逸脱と不要な暗号化副作用を防ぐ"
  // distinction = "quota判定、外部prepare抑止、永続状態を同時に確認する"
  // @end-test-value
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

      assertError(append);
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

  // @test-value v2
  // kind = "contract"
  // claim = "explicit character targetを扱いcurrent指定を拒否する"
  // oracle = { type = "adr", ref = "docs/adr/024-provider-common-memory-mcp-boundary.md" }
  // fault = "暗黙current targetを許可する"
  // observable = "target validation result"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service"
  // lifecycle = "permanent"
  // impact = "target明示契約"
  // distinction = "validationとserviceを確認する"
  // @end-test-value
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
      assertSuccess(append);
      assert.equal(append.entry.owner.type, "character");
      assert.equal(append.entry.owner.id, "character-a");

      const currentCharacter = await service.search(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "character", scope: "character", character: { type: "current" } }],
        query: "memory",
      });
      assertError(currentCharacter);
      assert.equal(currentCharacter.error.code, "MEMORY_INVALID_FIELD");
      assert.equal(currentCharacter.error.field, "targets[0].character.type");
    });
  });

  // @test-value v2
  // kind = "contract"
  // claim = "path read/search、dry-run、失敗append/move/forgetはProject scopeを作らず、成功append/moveだけがscopeを作る"
  // oracle = { type = "contract", ref = "docs/plans/20260812-general-memory-mcp/plan.md#GMCP-PROJECT-ADMISSION" }
  // fault = "effectなしのproject操作がscopeを永続化するか成功mutationがscopeを作らない"
  // observable = "path operation responses and project scope count"
  // observation_boundary = "component-behavior"
  // scope = "memory-v6-service"
  // lifecycle = "permanent"
  // impact = "project data continuity"
  // distinction = "runtime resolverを実動作で確認する"
  // @end-test-value
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
      const searchBeforeAppend = await service.search(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "path", path: workspacePath } }],
        query: "agent payload",
      });
      assertSuccess(searchBeforeAppend);
      assert.equal(listMemoryV6ProjectScopes(dbPath).length, 0);

      const forgetDryRun = await service.forget(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "path", path: workspacePath } },
        entryIds: ["missing-entry"],
        reason: "user_request",
        dryRun: true,
      });
      assertSuccess(forgetDryRun);
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
      assertError(failedAppend);
      assert.equal(failedAppend.error.code, "MEMORY_ENTRY_NOT_FOUND");
      assert.equal(failedAppend.error.effect, "none");
      assert.equal(listMemoryV6ProjectScopes(dbPath).length, 0);

      const failedMove = await service.moveEntry(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId: "missing-entry",
        from: { owner: "user", scope: "global" },
        to: { owner: "project", scope: "project", project: { type: "path", path: destinationWorkspacePath } },
        reason: "move to project scope",
        idempotencyKey: "missing-move",
      });
      assertError(failedMove);
      assert.equal(failedMove.error.code, "MEMORY_ENTRY_NOT_FOUND");
      assert.equal(failedMove.error.effect, "none");
      assert.equal(listMemoryV6ProjectScopes(dbPath).length, 0);

      const forgetMissing = await service.forget(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "path", path: destinationWorkspacePath } },
        entryIds: ["missing-entry"],
        reason: "user_request",
        idempotencyKey: "forget-missing-project",
      });
      assertSuccess(forgetMissing);
      assert.equal(forgetMissing.results[0].status, "not_found");
      assert.equal(listMemoryV6ProjectScopes(dbPath).length, 0);

      const append = await service.append(principal, appendRequest({
        target: {
          owner: "project",
          scope: "project",
          project: { type: "path", path: workspacePath },
        },
      }));
      assertSuccess(append);
      assert.equal(listMemoryV6ProjectScopes(dbPath).length, 1);

      const moved = await service.moveEntry(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId: append.entry.id,
        from: { owner: "project", scope: "project", project: { type: "path", path: workspacePath } },
        to: { owner: "project", scope: "project", project: { type: "path", path: destinationWorkspacePath } },
        reason: "move to destination project",
        idempotencyKey: "move-to-new-project",
      });
      assertSuccess(moved);
      assert.equal(listMemoryV6ProjectScopes(dbPath).length, 2);

      const search = await service.search(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "path", path: destinationWorkspacePath } }],
        query: "agent payload",
      });
      assertSuccess(search);
      assert.deepEqual(search.items.map((item) => item.id), [append.entry.id]);
    } finally {
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "maintenance read APIはbody-redacted projectionを返す"
  // oracle = { type = "adr", ref = "docs/adr/024-provider-common-memory-mcp-boundary.md" }
  // fault = "内部payloadやaudit bodyを返す"
  // observable = "maintenance read response"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service"
  // lifecycle = "permanent"
  // impact = "privacy-preserving maintenance projection"
  // distinction = "service responseを確認する"
  // @end-test-value
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

      const targets = await service.listTargets(principal, { schemaVersion: MEMORY_V6_SCHEMA_VERSION });
      assertSuccess(targets);
      assert.equal(targets.items[0].entryCount, 1);

      const listed = await service.listEntries(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        limit: 100,
      });
      assertSuccess(listed);
      assert.equal("body" in listed.items[0], false);
      const listedWithBody = await service.listEntries(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        includeBody: true,
      });
      assertSuccess(listedWithBody);
      assert.equal(listedWithBody.items[0].body, "full body must stay hidden by default");

      const tags = await service.listTags(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }],
        withCounts: true,
        sampleLimit: 1,
      });
      assertSuccess(tags);
      assert.equal(tags.tags[0].entryCount, 1);
      assert.deepEqual(tags.tags[0].samples?.map((sample) => sample.id), ["mem-maintenance"]);

      const audit = await service.audit(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        allTargets: true,
        staleBefore: "2026-06-01T00:00:00.000Z",
      });
      assertSuccess(audit);
      assert.equal(audit.targets[0].staleOrProgressCandidates[0].id, "mem-maintenance");
      assert.equal(JSON.stringify(audit).includes("full body must stay hidden"), false);
    });
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "list-tagsはlimitとcursorでbounded response pageを返す"
  // oracle = { type = "contract", ref = "docs/plans/20260812-general-memory-mcp/plan.md#GMCP-TAG-PAGE" }
  // fault = "response page上限またはcursor継続を壊す"
  // observable = "tag page and cursor"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service"
  // lifecycle = "permanent"
  // impact = "bounded response pagination"
  // distinction = "service pageを確認する"
  // @end-test-value
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
      const first = await service.listTags(principal, { schemaVersion: MEMORY_V6_SCHEMA_VERSION, targets: target, limit: 2 });
      assertSuccess(first);
      assert.equal(first.tags.length, 2);
      assert.ok(first.nextCursor);
      const second = await service.listTags(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: target,
        limit: 2,
        cursor: first.nextCursor,
      });
      assertSuccess(second);
      assert.equal(second.tags.length, 1);
      assert.equal(second.nextCursor, undefined);
      assert.equal(new Set([...first.tags, ...second.tags].map((item) => item.value)).size, 3);
      const invalidCursor = await service.listTags(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: target,
        cursor: "cursor-a",
      });
      assertError(invalidCursor);
      assert.equal(invalidCursor.error.code, "MEMORY_INVALID_FIELD");
      assert.equal(invalidCursor.error.field, "cursor");
    });
  });

  // @test-value v2
  // kind = "contract"
  // claim = "forgetはsourceMessageIdをidempotencyとauditへ保持する"
  // oracle = { type = "contract", ref = "docs/plans/20260812-general-memory-mcp/plan.md#GMCP-FORGET-SOURCE" }
  // fault = "retry識別子またはmutation auditが欠落する"
  // observable = "forget result and audit"
  // observation_boundary = "component-behavior"
  // scope = "memory-v6-service"
  // lifecycle = "permanent"
  // impact = "forget retry continuity"
  // distinction = "service mutationとDB audit rowをcomponent境界で確認する"
  // @end-test-value
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
      const first = await service.forget(principal, request);
      assertSuccess(first);
      const replay = await service.forget(principal, request);
      assertSuccess(replay);
      assert.equal(replay.results[0].replayed, true);
      const conflict = await service.forget(principal, { ...request, sourceMessageId: "message-b" });
      assertError(conflict);
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

  // @test-value v2
  // kind = "contract"
  // claim = "forget dry-runはMemory entryとresponseを変更せず、move/retarget/replayを同一契約へ収束する"
  // oracle = { type = "contract", ref = "docs/plans/20260812-general-memory-mcp/plan.md#GMCP-FORGET-SOURCE" }
  // fault = "dry-runでMemory entryまたはresponseを変更する"
  // observable = "dry-run response、move後のtarget、retarget replayのresponseとMemory entry state"
  // observation_boundary = "public-boundary"
  // scope = "memory-v6-service"
  // lifecycle = "permanent"
  // impact = "safe maintenance mutations"
  // distinction = "forget dry-run、move retarget、idempotent replayを同一service経路で確認する"
  // @end-test-value
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
      const dryRun = await service.forget(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        entryIds: ["mem-move", "missing"],
        dryRun: true,
      });
      assertSuccess(dryRun);
      assert.equal(dryRun.dryRun, true);
      assert.equal(dryRun.writeOccurred, false);
      assert.equal(dryRun.results[0].entry?.title, "CLI-wide note");
      assert.equal(storage.getEntry("mem-move")?.state, "active");

      const replaySeed = await service.forget(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "user", scope: "global" },
        entryIds: ["mem-move"],
        idempotencyKey: "forget-after-move",
      });
      assertSuccess(replaySeed);
      assert.equal(replaySeed.results[0].status, "not_found");

      const request = {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId: "mem-move",
        from: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        to: { owner: "user", scope: "global" },
        reason: "move CLI note to user scope",
        idempotencyKey: "move-cli-note",
      };
      const moved = await service.moveEntry(principal, request);
      assertSuccess(moved);
      assert.equal(moved.entry.owner.type, "user");
      const replayPreview = await service.forget(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: request.to,
        entryIds: ["mem-move"],
        idempotencyKey: "forget-after-move",
        dryRun: true,
      });
      assertSuccess(replayPreview);
      assert.equal(replayPreview.results[0].status, "not_found");
      assert.equal(replayPreview.results[0].entry, undefined);
      assert.equal(storage.getEntry("mem-move")?.state, "active");
      const replay = await service.moveEntry(principal, request);
      assertSuccess(replay);
      assert.equal(replay.entry.id, "mem-move");
      assert.equal(replay.replayed, true);

      const oldTarget = await service.listEntries(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: request.from,
      });
      assertSuccess(oldTarget);
      assert.deepEqual(oldTarget.items, []);
      const newTarget = await service.listEntries(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: request.to,
      });
      assertSuccess(newTarget);
      assert.deepEqual(newTarget.items.map((entry) => entry.id), ["mem-move"]);
    });
  });
});

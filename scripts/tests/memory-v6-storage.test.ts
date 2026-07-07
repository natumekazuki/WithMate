import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import type { NormalizedMemoryTag } from "../../src/memory-v6/memory-contract.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import type { MemoryV6ResolvedTarget } from "../../src-electron/memory-v6-schema.js";
import {
  MemoryV6EntryNotFoundError,
  MemoryV6FileQuotaExceededError,
  MemoryV6IdempotencyConflictError,
  MemoryV6Storage,
} from "../../src-electron/memory-v6-storage.js";

const projectTarget = {
  owner: { type: "project", id: "project-a" },
  scope: { type: "project", id: "project-a" },
} satisfies MemoryV6ResolvedTarget;

const characterTarget = {
  owner: { type: "character", id: "character-a" },
  scope: { type: "character", id: "character-a" },
} satisfies MemoryV6ResolvedTarget;

const userGlobalTarget = {
  owner: { type: "user", id: "local-user" },
  scope: { type: "global", id: "global" },
} satisfies MemoryV6ResolvedTarget;

type AppendProtectedObjectInput = NonNullable<Parameters<MemoryV6Storage["appendEntry"]>[0]["protectedObjects"]>[number];

function tag(type: string, value: string): NormalizedMemoryTag {
  return {
    type,
    value,
    canonicalType: type.normalize("NFC").toLowerCase(),
    canonicalValue: value.normalize("NFC").toLowerCase(),
  };
}

function baseAppend(overrides: Partial<Parameters<MemoryV6Storage["appendEntry"]>[0]> = {}): Parameters<MemoryV6Storage["appendEntry"]>[0] {
  return {
    target: projectTarget,
    kind: "decision",
    title: "CLI認証方針",
    body: "CLIはWithMate起動中のruntime APIだけに接続し、DBを直接読まない。",
    preview: "CLIはruntime APIだけに接続する。",
    tags: [tag("topic", "memory")],
    source: {
      type: "agent",
      sessionId: null,
      messageId: "provider-message-a",
      providerId: "codex",
    },
    now: "2026-06-24T00:00:00.000Z",
    ...overrides,
  };
}

async function withStorage<T>(runner: (input: { storage: MemoryV6Storage; dbPath: string }) => T | Promise<T>): Promise<T> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-v6-storage-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(tempDirectory);
  const storage = new MemoryV6Storage(dbPath);
  try {
    return await runner({ storage, dbPath });
  } finally {
    storage.close();
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function readCount(dbPath: string, sql: string, ...params: Array<string | number | null>): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare(sql).get(...params) as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

function readRow<T>(dbPath: string, sql: string, ...params: Array<string | number | null>): T {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).get(...params) as T;
  } finally {
    db.close();
  }
}

function tableNames(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

function insertProtectedObject(dbPath: string, input: {
  objectId: string;
  entryId: string;
  state: "active" | "delete_pending" | "deleted";
  role?: "evidence" | "source" | "snapshot" | "artifact" | "reference" | "other";
  summary: string;
  originalBytes: number;
  storedBytes: number;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      INSERT INTO memory_protected_objects_v6 (
        object_id,
        entry_id,
        state,
        role,
        media_kind,
        summary,
        original_bytes,
        stored_bytes,
        created_at,
        updated_at,
        deleted_at
      ) VALUES (?, ?, ?, ?, 'source', ?, ?, ?, ?, ?, ?)
    `).run(
      input.objectId,
      input.entryId,
      input.state,
      input.role ?? "source",
      input.summary,
      input.originalBytes,
      input.storedBytes,
      input.createdAt ?? "2026-07-04T00:00:00.000Z",
      input.updatedAt ?? "2026-07-04T00:00:00.000Z",
      input.deletedAt ?? null,
    );
  } finally {
    db.close();
  }
}

function protectedObjectInput(overrides: Partial<AppendProtectedObjectInput> = {}): AppendProtectedObjectInput {
  return {
    objectId: "a".repeat(32),
    role: "evidence",
    mediaKind: "image",
    contentType: "image/png",
    displayName: "trace.png",
    summary: "Trace screenshot",
    originalBytes: 100,
    storedBytes: 140,
    sha256: "b".repeat(64),
    keyId: "key-a",
    ...overrides,
  };
}

describe("MemoryV6Storage", () => {
  it("valid V6 DB 以外は開かず legacy DB をin-place変更しない", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-v6-storage-"));
    const legacyDbPath = join(tempDirectory, "withmate-v4.db");
    const legacyDb = new DatabaseSync(legacyDbPath);
    try {
      legacyDb.exec("CREATE TABLE app_settings (setting_key TEXT PRIMARY KEY);");
      legacyDb.exec("PRAGMA user_version = 4;");
    } finally {
      legacyDb.close();
    }

    try {
      assert.throws(() => new MemoryV6Storage(legacyDbPath), /valid withmate-v6\.db/);
      assert.equal(readRow<{ user_version: number }>(legacyDbPath, "PRAGMA user_version").user_version, 4);
      assert.equal(tableNames(legacyDbPath).includes("memory_entries_v6"), false);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("append / get / search / tag catalog / idempotent replay をV6 tableだけで扱う", async () => {
    await withStorage(({ storage, dbPath }) => {
      const first = storage.appendEntry(baseAppend({
        id: "mem-a",
        idempotencyKey: "append-key-a",
        bindingIdHash: "binding-hash-a",
      }));

      assert.equal(first.created, true);
      assert.equal(first.entry.id, "mem-a");
      assert.equal(first.entry.state, "active");
      assert.equal(first.entry.body.includes("DBを直接読まない"), true);

      const replay = storage.appendEntry(baseAppend({
        id: "mem-other",
        idempotencyKey: "append-key-a",
        bindingIdHash: "binding-hash-a",
      }));
      assert.equal(replay.created, true);
      assert.equal(replay.entry.id, "mem-a");
      assert.equal(readCount(dbPath, "SELECT COUNT(*) AS count FROM memory_entries_v6"), 1);

      assert.throws(() => {
        storage.appendEntry(baseAppend({
          idempotencyKey: "append-key-a",
          bindingIdHash: "binding-hash-a",
          body: "同じkeyで違うbodyはconflictにする。",
        }));
      }, MemoryV6IdempotencyConflictError);

      const search = storage.searchEntries({
        targets: [projectTarget],
        query: "直接読まない",
        tags: [tag("topic", "memory")],
      });
      assert.equal(search.items.length, 1);
      assert.equal(search.items[0].id, "mem-a");
      assert.equal("body" in search.items[0], false);
      assert.equal("state" in search.items[0], false);

      assert.deepEqual(storage.listTags([projectTarget]), [tag("topic", "memory")]);
      assert.equal(tableNames(dbPath).includes("session_memories"), false);
      assert.equal(tableNames(dbPath).includes("project_memory_entries"), false);
    });
  });

  it("user-global target のappend / search / tag catalog / forgetを扱う", async () => {
    await withStorage(({ storage }) => {
      const appended = storage.appendEntry(baseAppend({
        id: "mem-user-global",
        target: userGlobalTarget,
        kind: "preference",
        title: "共通検証方針",
        body: "全projectで検証結果を短く添える。",
        preview: "検証結果を短く添える。",
        tags: [tag("topic", "global-preference")],
      }));

      assert.equal(appended.entry.owner.type, "user");
      assert.equal(appended.entry.owner.id, "local-user");
      assert.equal(appended.entry.scope.type, "global");
      assert.equal(appended.entry.scope.id, "global");

      const search = storage.searchEntries({
        targets: [userGlobalTarget],
        query: "検証結果",
      });
      assert.deepEqual(search.items.map((item) => item.id), ["mem-user-global"]);
      assert.deepEqual(storage.listTags([userGlobalTarget]), [tag("topic", "global-preference")]);

      const forget = storage.forgetEntries({
        target: userGlobalTarget,
        entryIds: ["mem-user-global", "missing-entry"],
        reason: "user_request",
      });
      assert.deepEqual(forget, [
        { entryId: "mem-user-global", status: "forgotten" },
        { entryId: "missing-entry", status: "not_found" },
      ]);
    });
  });

  it("protected object usage は active と delete_pending を区別して集計する", async () => {
    await withStorage(({ storage, dbPath }) => {
      storage.appendEntry(baseAppend({ id: "mem-file-owner" }));
      insertProtectedObject(dbPath, { objectId: "obj-active", entryId: "mem-file-owner", state: "active", summary: "active file", originalBytes: 100, storedBytes: 120 });
      insertProtectedObject(dbPath, { objectId: "obj-pending", entryId: "mem-file-owner", state: "delete_pending", summary: "pending file", originalBytes: 200, storedBytes: 240, updatedAt: "2026-07-04T00:01:00.000Z" });
      insertProtectedObject(dbPath, { objectId: "obj-deleted", entryId: "mem-file-owner", state: "deleted", summary: "deleted file", originalBytes: 300, storedBytes: 360, updatedAt: "2026-07-04T00:02:00.000Z", deletedAt: "2026-07-04T00:03:00.000Z" });

      assert.deepEqual(storage.getFileUsage(), {
        usedBytes: 100,
        physicalBytes: 360,
        pendingDeleteBytes: 240,
        objectCount: 1,
        pendingDeleteCount: 1,
      });
    });
  });

  it("largest file entries はactive entryのactive objectだけを容量順に返す", async () => {
    await withStorage(({ storage, dbPath }) => {
      storage.appendEntry(baseAppend({
        id: "mem-small",
        title: "Small entry",
        preview: "small preview",
        now: "2026-07-04T00:00:00.000Z",
      }));
      storage.appendEntry(baseAppend({
        id: "mem-large",
        title: "Large entry",
        preview: "large preview",
        now: "2026-07-04T00:10:00.000Z",
      }));
      storage.appendEntry(baseAppend({
        id: "mem-forgotten",
        title: "Forgotten entry",
        preview: "forgotten preview",
        now: "2026-07-04T00:20:00.000Z",
      }));
      storage.forgetEntries({ target: projectTarget, entryIds: ["mem-forgotten"], reason: "user_request" });

      insertProtectedObject(dbPath, { objectId: "obj-small-a", entryId: "mem-small", state: "active", summary: "small", originalBytes: 100, storedBytes: 120 });
      insertProtectedObject(dbPath, { objectId: "obj-large-a", entryId: "mem-large", state: "active", summary: "large a", originalBytes: 300, storedBytes: 330 });
      insertProtectedObject(dbPath, { objectId: "obj-large-b", entryId: "mem-large", state: "active", summary: "large b", originalBytes: 250, storedBytes: 280 });
      insertProtectedObject(dbPath, { objectId: "obj-large-pending", entryId: "mem-large", state: "delete_pending", summary: "pending", originalBytes: 900, storedBytes: 990 });
      insertProtectedObject(dbPath, { objectId: "obj-forgotten-a", entryId: "mem-forgotten", state: "active", summary: "forgotten", originalBytes: 1000, storedBytes: 1100 });

      assert.deepEqual(storage.listLargestFileEntries({ limit: 2 }), [
        {
          entryId: "mem-large",
          title: "Large entry",
          preview: "large preview",
          totalFileBytes: 550,
          fileCount: 2,
          updatedAt: "2026-07-04T00:10:00.000Z",
        },
        {
          entryId: "mem-small",
          title: "Small entry",
          preview: "small preview",
          totalFileBytes: 100,
          fileCount: 1,
          updatedAt: "2026-07-04T00:00:00.000Z",
        },
      ]);
    });
  });

  it("GC用primitiveはdelete_pending列挙とdeleted反映をstate限定で扱う", async () => {
    await withStorage(({ storage, dbPath }) => {
      const activeObjectId = "a".repeat(32);
      const pendingObjectId = "b".repeat(32);
      const deletedObjectId = "c".repeat(32);
      storage.appendEntry(baseAppend({
        id: "mem-gc-active",
        protectedObjects: [protectedObjectInput({ objectId: activeObjectId })],
        fileQuotaBytes: 1024,
      }));
      storage.appendEntry(baseAppend({
        id: "mem-gc-pending",
        now: "2026-07-04T00:01:00.000Z",
        protectedObjects: [protectedObjectInput({
          objectId: pendingObjectId,
          sha256: "c".repeat(64),
          originalBytes: 200,
          storedBytes: 240,
        })],
        fileQuotaBytes: 1024,
      }));
      storage.appendEntry(baseAppend({ id: "mem-gc-deleted", now: "2026-07-04T00:02:00.000Z" }));
      insertProtectedObject(dbPath, {
        objectId: deletedObjectId,
        entryId: "mem-gc-deleted",
        state: "deleted",
        summary: "deleted",
        originalBytes: 300,
        storedBytes: 360,
        deletedAt: "2026-07-04T00:03:00.000Z",
      });
      storage.forgetEntries({
        target: projectTarget,
        entryIds: ["mem-gc-pending"],
        reason: "user_request",
        now: "2026-07-04T00:04:00.000Z",
      });

      assert.deepEqual(storage.listProtectedObjectIdsForGc({ states: ["active"] }), [activeObjectId]);
      assert.deepEqual(storage.listProtectedObjectIdsForGc({ states: ["delete_pending"] }), [pendingObjectId]);
      assert.deepEqual(storage.listProtectedObjectIdsForGc({ states: ["active", "delete_pending"] }), [activeObjectId, pendingObjectId]);
      assert.deepEqual(storage.listDeletePendingProtectedObjectsForGc({ limit: 10 }), [{
        objectId: pendingObjectId,
        storedBytes: 240,
        updatedAt: "2026-07-04T00:04:00.000Z",
      }]);

      assert.equal(storage.markProtectedObjectDeletedForGc({
        objectId: pendingObjectId,
        deletedAt: "2026-07-04T00:05:00.000Z",
      }), true);
      assert.equal(storage.markProtectedObjectDeletedForGc({
        objectId: activeObjectId,
        deletedAt: "2026-07-04T00:06:00.000Z",
      }), false);
      assert.deepEqual(storage.listDeletePendingProtectedObjectsForGc({ limit: 10 }), []);
      assert.equal(readRow<{ state: string }>(dbPath, "SELECT state FROM memory_protected_objects_v6 WHERE object_id = ?", pendingObjectId).state, "deleted");
      assert.equal(readRow<{ state: string }>(dbPath, "SELECT state FROM memory_protected_objects_v6 WHERE object_id = ?", activeObjectId).state, "active");
    });
  });

  it("append は protected object metadata を同じtransactionで登録する", async () => {
    await withStorage(({ storage, dbPath }) => {
      const appended = storage.appendEntry(baseAppend({
        id: "mem-file-append",
        protectedObjects: [protectedObjectInput()],
        fileQuotaBytes: 1024,
      }));

      assert.equal(appended.entry.id, "mem-file-append");
      assert.deepEqual(storage.getFileUsage(), {
        usedBytes: 100,
        physicalBytes: 140,
        pendingDeleteBytes: 0,
        objectCount: 1,
        pendingDeleteCount: 0,
      });
      assert.deepEqual(appended.entry.files, [{
        objectId: "a".repeat(32),
        role: "evidence",
        mediaKind: "image",
        contentType: "image/png",
        displayName: "trace.png",
        summary: "Trace screenshot",
        originalBytes: 100,
      }]);
      assert.deepEqual(
        storage.searchEntries({ targets: [projectTarget], query: "" }).items.find((item) => item.id === "mem-file-append")?.files,
        appended.entry.files,
      );
      const object = readRow<{
        entry_id: string;
        state: string;
        role: string;
        media_kind: string;
        content_type: string;
        display_name: string;
        summary: string;
        original_bytes: number;
        stored_bytes: number;
        sha256: string;
        key_id: string;
      }>(dbPath, "SELECT * FROM memory_protected_objects_v6 WHERE object_id = ?", "a".repeat(32));
      assert.equal(object.entry_id, "mem-file-append");
      assert.equal(object.state, "active");
      assert.equal(object.role, "evidence");
      assert.equal(object.media_kind, "image");
      assert.equal(object.content_type, "image/png");
      assert.equal(object.display_name, "trace.png");
      assert.equal(object.summary, "Trace screenshot");
      assert.equal(object.original_bytes, 100);
      assert.equal(object.stored_bytes, 140);
      assert.equal(object.sha256, "b".repeat(64));
      assert.equal(object.key_id, "key-a");
    });
  });

  it("export用metadataはtarget内のactive objectだけ返す", async () => {
    await withStorage(({ storage }) => {
      const objectId = "f".repeat(32);
      const append = storage.appendEntry(baseAppend({
        id: "mem-file-export",
        protectedObjects: [protectedObjectInput({
          objectId,
          keyId: "key-export",
          originalBytes: 128,
          storedBytes: 160,
        })],
        fileQuotaBytes: 1024,
      }));

      assert.deepEqual(storage.getProtectedObjectForExport({
        target: projectTarget,
        objectId,
      }), {
        objectId,
        entryId: append.entry.id,
        contentType: "image/png",
        displayName: "trace.png",
        originalBytes: 128,
        storedBytes: 160,
        sha256: "b".repeat(64),
        keyId: "key-export",
      });
      assert.equal(storage.getProtectedObjectForExport({
        target: characterTarget,
        objectId,
      }), null);
      assert.equal(storage.getProtectedObjectForExport({
        target: projectTarget,
        objectId: "not-an-object-id",
      }), null);

      storage.forgetEntries({
        target: projectTarget,
        entryIds: [append.entry.id],
        reason: "user_request",
      });
      assert.equal(storage.getProtectedObjectForExport({
        target: projectTarget,
        objectId,
      }), null);
    });
  });

  it("entry export用metadataはtarget内のactive entryだけ列挙する", async () => {
    await withStorage(({ storage }) => {
      storage.appendEntry(baseAppend({
        id: "mem-file-export-list",
        protectedObjects: [
          protectedObjectInput({
            objectId: "1".repeat(32),
            displayName: "first.png",
            originalBytes: 100,
            storedBytes: 140,
          }),
          protectedObjectInput({
            objectId: "2".repeat(32),
            displayName: "second.txt",
            originalBytes: 20,
            storedBytes: 60,
            sha256: "c".repeat(64),
          }),
        ],
        fileQuotaBytes: 1024,
      }));
      storage.appendEntry(baseAppend({
        id: "mem-file-export-empty",
        protectedObjects: [],
      }));

      assert.deepEqual(storage.listProtectedObjectsForEntryExport({
        target: projectTarget,
        entryId: "mem-file-export-list",
      })?.map((item) => ({
        objectId: item.objectId,
        displayName: item.displayName,
        originalBytes: item.originalBytes,
      })), [
        { objectId: "1".repeat(32), displayName: "first.png", originalBytes: 100 },
        { objectId: "2".repeat(32), displayName: "second.txt", originalBytes: 20 },
      ]);
      assert.deepEqual(storage.listProtectedObjectsForEntryExport({
        target: projectTarget,
        entryId: "mem-file-export-empty",
      }), []);
      assert.equal(storage.listProtectedObjectsForEntryExport({
        target: characterTarget,
        entryId: "mem-file-export-list",
      }), null);

      storage.forgetEntries({
        target: projectTarget,
        entryIds: ["mem-file-export-list"],
      });
      assert.equal(storage.listProtectedObjectsForEntryExport({
        target: projectTarget,
        entryId: "mem-file-export-list",
      }), null);
    });
  });

  it("protected object quota 超過時はentry / object / idempotencyを作らない", async () => {
    await withStorage(({ storage, dbPath }) => {
      storage.appendEntry(baseAppend({ id: "mem-existing" }));
      insertProtectedObject(dbPath, {
        objectId: "obj-existing",
        entryId: "mem-existing",
        state: "active",
        summary: "existing",
        originalBytes: 90,
        storedBytes: 110,
      });

      assert.throws(
        () => storage.appendEntry(baseAppend({
          id: "mem-quota-fail",
          idempotencyKey: "file-append-quota",
          bindingIdHash: "binding-quota",
          protectedObjects: [protectedObjectInput({ objectId: "c".repeat(32), originalBytes: 20 })],
          fileQuotaBytes: 100,
        })),
        MemoryV6FileQuotaExceededError,
      );

      assert.equal(readCount(dbPath, "SELECT COUNT(*) AS count FROM memory_entries_v6 WHERE id = 'mem-quota-fail'"), 0);
      assert.equal(readCount(dbPath, "SELECT COUNT(*) AS count FROM memory_protected_objects_v6 WHERE object_id = ?", "c".repeat(32)), 0);
      assert.equal(readCount(dbPath, "SELECT COUNT(*) AS count FROM memory_idempotency_keys_v6 WHERE key = 'file-append-quota'"), 0);
      assert.deepEqual(storage.getFileUsage(), {
        usedBytes: 90,
        physicalBytes: 110,
        pendingDeleteBytes: 0,
        objectCount: 1,
        pendingDeleteCount: 0,
      });
    });
  });

  it("protected object 登録失敗時はentryもrollbackし、idempotent replayはobjectを重複登録しない", async () => {
    await withStorage(({ storage, dbPath }) => {
      const first = storage.appendEntry(baseAppend({
        id: "mem-file-idempotent",
        idempotencyKey: "file-append-idempotent",
        bindingIdHash: "binding-file",
        requestFingerprint: "fingerprint-file-request",
        protectedObjects: [protectedObjectInput({ objectId: "d".repeat(32) })],
        fileQuotaBytes: 1024,
      }));
      const replay = storage.appendEntry(baseAppend({
        id: "mem-file-idempotent-other",
        idempotencyKey: "file-append-idempotent",
        bindingIdHash: "binding-file",
        requestFingerprint: "fingerprint-file-request",
        protectedObjects: [protectedObjectInput({ objectId: "e".repeat(32), sha256: "c".repeat(64) })],
        fileQuotaBytes: 1024,
      }));

      assert.equal(replay.entry.id, first.entry.id);
      assert.equal(readCount(dbPath, "SELECT COUNT(*) AS count FROM memory_protected_objects_v6"), 1);
      assert.equal(readCount(dbPath, "SELECT COUNT(*) AS count FROM memory_protected_objects_v6 WHERE object_id = ?", "e".repeat(32)), 0);

      assert.throws(
        () => storage.appendEntry(baseAppend({
          id: "mem-file-duplicate-object",
          protectedObjects: [protectedObjectInput({ objectId: "d".repeat(32), sha256: "d".repeat(64) })],
          fileQuotaBytes: 1024,
        })),
        /UNIQUE constraint failed/,
      );
      assert.equal(readCount(dbPath, "SELECT COUNT(*) AS count FROM memory_entries_v6 WHERE id = 'mem-file-duplicate-object'"), 0);
      assert.equal(readCount(dbPath, "SELECT COUNT(*) AS count FROM memory_protected_objects_v6"), 1);
    });
  });

  it("protected object metadata が不正な場合はentryを作らない", async () => {
    await withStorage(({ storage, dbPath }) => {
      assert.throws(
        () => storage.appendEntry(baseAppend({
          id: "mem-invalid-protected-object",
          protectedObjects: [protectedObjectInput({ mediaKind: "video" as never })],
          fileQuotaBytes: 1024,
        })),
        /media kind is invalid/,
      );

      assert.equal(readCount(dbPath, "SELECT COUNT(*) AS count FROM memory_entries_v6 WHERE id = 'mem-invalid-protected-object'"), 0);
      assert.equal(readCount(dbPath, "SELECT COUNT(*) AS count FROM memory_protected_objects_v6"), 0);
    });
  });

  it("forget は紐づくactive protected objectをdelete_pendingにしてusageから外す", async () => {
    await withStorage(({ storage, dbPath }) => {
      storage.appendEntry(baseAppend({ id: "mem-file-forget" }));
      insertProtectedObject(dbPath, { objectId: "obj-forget-active", entryId: "mem-file-forget", state: "active", summary: "file to forget", originalBytes: 100, storedBytes: 120 });
      insertProtectedObject(dbPath, { objectId: "obj-forget-pending", entryId: "mem-file-forget", state: "delete_pending", summary: "already pending", originalBytes: 50, storedBytes: 60 });

      assert.deepEqual(storage.getFileUsage(), {
        usedBytes: 100,
        physicalBytes: 180,
        pendingDeleteBytes: 60,
        objectCount: 1,
        pendingDeleteCount: 1,
      });

      assert.deepEqual(storage.forgetEntries({
        target: projectTarget,
        entryIds: ["mem-file-forget"],
        reason: "outdated",
        now: "2026-07-04T00:10:00.000Z",
      }), [{ entryId: "mem-file-forget", status: "forgotten" }]);

      assert.deepEqual(storage.getFileUsage(), {
        usedBytes: 0,
        physicalBytes: 180,
        pendingDeleteBytes: 180,
        objectCount: 0,
        pendingDeleteCount: 2,
      });
      const activeObject = readRow<{ state: string; updated_at: string; deleted_at: string | null }>(
        dbPath,
        "SELECT state, updated_at, deleted_at FROM memory_protected_objects_v6 WHERE object_id = 'obj-forget-active'",
      );
      assert.equal(activeObject.state, "delete_pending");
      assert.equal(activeObject.updated_at, "2026-07-04T00:10:00.000Z");
      assert.equal(activeObject.deleted_at, null);
    });
  });

  it("malformed user-global row はhydrationで公開しない", async () => {
    await withStorage(({ storage, dbPath }) => {
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("PRAGMA ignore_check_constraints = ON;");
        db.prepare(`
          INSERT INTO memory_entries_v6 (
            id,
            owner_type,
            owner_id,
            scope_type,
            scope_id,
            kind,
            title,
            body,
            body_sha256,
            preview,
            state,
            source_type,
            source_session_id,
            source_app_message_id,
            source_provider_message_id,
            source_provider_id,
            superseded_by_id,
            created_at,
            updated_at,
            forgotten_at
          ) VALUES (
            'mem-malformed-user-global',
            'user',
            'other-user',
            'global',
            'global',
            'note',
            'bad',
            'bad',
            'sha',
            'bad',
            'active',
            'agent',
            NULL,
            NULL,
            NULL,
            'codex',
            NULL,
            '2026-06-29T00:00:00.000Z',
            '2026-06-29T00:00:00.000Z',
            NULL
          )
        `).run();
      } finally {
        db.close();
      }

      assert.equal(storage.getEntry("mem-malformed-user-global"), null);
    });
  });

  it("search は自然文queryをtoken化し、タグ表記揺れとmatch情報と0件時候補を返す", async () => {
    await withStorage(({ storage }) => {
      storage.appendEntry(baseAppend({
        id: "mem-delivery-cleanup",
        title: "納品cleanup branch strategy",
        body: "KMT prefix removal は納品用ブランチで進め、RelayGraph は削除可とする。",
        preview: "納品cleanupのブランチ方針。",
        tags: [
          tag("topic", "delivery-cleanup"),
          tag("topic", "branch-strategy"),
          tag("topic", "relaygraph"),
        ],
      }));
      storage.appendEntry(baseAppend({
        id: "mem-unrelated",
        title: "UI方針",
        body: "Memory UIは既存のlayoutに揃える。",
        preview: "UI方針",
        tags: [tag("topic", "ui")],
      }));

      const naturalQuery = storage.searchEntries({
        targets: [projectTarget],
        query: "delivery cleanup branch relaygraph",
      });
      assert.equal(naturalQuery.items[0]?.id, "mem-delivery-cleanup");
      assert.deepEqual(naturalQuery.items[0]?.match?.fields.includes("tags"), true);
      assert.match(naturalQuery.items[0]?.match?.snippet ?? "", /delivery-cleanup|relaygraph/);

      const hyphenated = storage.searchEntries({ targets: [projectTarget], query: "delivery-cleanup" });
      const spaced = storage.searchEntries({ targets: [projectTarget], query: "delivery cleanup" });
      assert.equal(hyphenated.items[0]?.id, "mem-delivery-cleanup");
      assert.equal(spaced.items[0]?.id, "mem-delivery-cleanup");

      const noEntry = storage.searchEntries({
        targets: [projectTarget],
        query: "delivery cleanup",
        kinds: ["preference"],
      });
      assert.deepEqual(noEntry.items, []);
      assert.deepEqual(noEntry.relatedTags?.map((item) => item.value), ["delivery-cleanup"]);
    });
  });

  it("search match snippet はbody由来の本文断片を返さない", async () => {
    await withStorage(({ storage }) => {
      storage.appendEntry(baseAppend({
        id: "mem-body-only",
        title: "権限境界",
        body: "search権限だけでは直接読ませない秘密の本文断片",
        preview: "検索結果の要約",
        tags: [tag("topic", "permission")],
      }));

      const search = storage.searchEntries({
        targets: [projectTarget],
        query: "秘密の本文断片",
      });

      assert.equal(search.items.length, 1);
      assert.equal(search.items[0]?.id, "mem-body-only");
      assert.deepEqual(search.items[0]?.match?.fields, ["body"]);
      assert.equal(search.items[0]?.match?.snippet, undefined);
    });
  });

  it("search storage は空queryでも防御的にactive entryをupdated_at順に返す", async () => {
    await withStorage(({ storage }) => {
      storage.appendEntry(baseAppend({
        id: "mem-empty-query-old",
        title: "Old",
        body: "old body",
        preview: "old",
        now: "2026-06-24T00:00:00.000Z",
      }));
      storage.appendEntry(baseAppend({
        id: "mem-empty-query-new",
        title: "New",
        body: "new body",
        preview: "new",
        now: "2026-06-24T00:01:00.000Z",
      }));

      const first = storage.searchEntries({ targets: [projectTarget], query: "", limit: 1 });
      assert.deepEqual(first.items.map((item) => item.id), ["mem-empty-query-new"]);
      assert.equal(first.items[0]?.match, undefined);
      assert.ok(first.nextCursor);

      const second = storage.searchEntries({ targets: [projectTarget], query: "", limit: 1, cursor: first.nextCursor });
      assert.deepEqual(second.items.map((item) => item.id), ["mem-empty-query-old"]);
      assert.equal(second.relatedTags, undefined);
    });
  });

  it("review search / get / forget はactive entryの閲覧とforgetに限定する", async () => {
    await withStorage(({ storage }) => {
      storage.appendEntry(baseAppend({
        id: "mem-review-a",
        title: "Review対象",
        body: "Memory Review UIから確認する本文。",
        preview: "Review UI本文",
        tags: [tag("topic", "review")],
        source: {
          type: "agent",
          sessionId: null,
          messageId: "provider-message-review",
          providerId: "codex",
        },
      }));
      storage.appendEntry(baseAppend({
        id: "mem-review-other",
        target: characterTarget,
        title: "Character側",
        body: "Character memory body",
        preview: "Character memory",
        tags: [tag("topic", "character")],
      }));

      const search = storage.searchEntriesForReview({ query: "memory", limit: 10 });
      assert.deepEqual(search.items.map((item) => item.id).sort(), ["mem-review-a", "mem-review-other"]);
      assert.equal(search.items.find((item) => item.id === "mem-review-a")?.sourceSessionId, null);
      assert.equal(search.items.find((item) => item.id === "mem-review-a")?.sourceProviderId, "codex");

      const entry = storage.getEntry("mem-review-a");
      assert.equal(entry?.body, "Memory Review UIから確認する本文。");

      assert.deepEqual(storage.forgetEntryForReview({
        entryId: "mem-review-a",
        reason: "incorrect",
        now: "2026-06-24T00:03:00.000Z",
      }), {
        entryId: "mem-review-a",
        status: "forgotten",
        reason: "incorrect",
      });
      assert.equal(storage.getEntry("mem-review-a")?.state, "forgotten");
      assert.deepEqual(storage.searchEntriesForReview({ query: "Review対象" }).items, []);
    });
  });

  it("review forget はsuperseded / forgotten entryを更新しない", async () => {
    await withStorage(({ storage }) => {
      storage.appendEntry(baseAppend({
        id: "mem-review-old",
        title: "古いReview対象",
        body: "superseded body",
        preview: "old preview",
        tags: [tag("topic", "old-review")],
      }));
      storage.appendEntry(baseAppend({
        id: "mem-review-new",
        title: "新しいReview対象",
        body: "active body",
        preview: "new preview",
        tags: [tag("topic", "new-review")],
        supersedes: ["mem-review-old"],
        now: "2026-06-24T00:04:00.000Z",
      }));
      storage.appendEntry(baseAppend({
        id: "mem-review-forgotten",
        title: "忘却済みReview対象",
        body: "forgotten body should remain",
        preview: "forgotten preview",
        tags: [tag("topic", "forgotten-review")],
        now: "2026-06-24T00:05:00.000Z",
      }));
      assert.deepEqual(storage.forgetEntryForReview({
        entryId: "mem-review-forgotten",
        reason: "incorrect",
        now: "2026-06-24T00:06:00.000Z",
      }), {
        entryId: "mem-review-forgotten",
        status: "forgotten",
        reason: "incorrect",
      });

      assert.deepEqual(storage.forgetEntryForReview({
        entryId: "mem-review-old",
        reason: "privacy",
        now: "2026-06-24T00:07:00.000Z",
      }), {
        entryId: "mem-review-old",
        status: "not_found",
        reason: "privacy",
      });
      assert.deepEqual(storage.forgetEntryForReview({
        entryId: "mem-review-forgotten",
        reason: "privacy",
        now: "2026-06-24T00:08:00.000Z",
      }), {
        entryId: "mem-review-forgotten",
        status: "not_found",
        reason: "privacy",
      });

      assert.equal(storage.getEntry("mem-review-old")?.state, "superseded");
      assert.equal(storage.getEntry("mem-review-old")?.body, "superseded body");
      assert.equal(storage.getEntry("mem-review-forgotten")?.state, "forgotten");
      assert.equal(storage.getEntry("mem-review-forgotten")?.body, "forgotten body should remain");
    });
  });

  it("supersede は旧entryを通常searchから除外し、transaction内でrelation / tag catalog / mutation eventを更新する", async () => {
    await withStorage(({ storage, dbPath }) => {
      storage.appendEntry(baseAppend({
        id: "mem-old",
        title: "古い方針",
        body: "古いMemory方針",
        preview: "古い方針",
        tags: [tag("topic", "old")],
      }));

      const next = storage.appendEntry(baseAppend({
        id: "mem-new",
        title: "新しい方針",
        body: "新しいMemory方針",
        preview: "新しい方針",
        tags: [tag("topic", "new")],
        supersedes: ["mem-old"],
        now: "2026-06-24T00:01:00.000Z",
      }));

      const old = storage.getEntry("mem-old");
      assert.equal(old?.state, "superseded");
      assert.equal(old?.supersededBy, "mem-new");
      assert.deepEqual(next.entry.supersedes, ["mem-old"]);
      assert.deepEqual(storage.searchEntries({ targets: [projectTarget], query: "方針" }).items.map((item) => item.id), ["mem-new"]);
      assert.deepEqual(storage.listTags([projectTarget]), [tag("topic", "new")]);
      assert.equal(readCount(dbPath, "SELECT COUNT(*) AS count FROM memory_entry_relations_v6 WHERE source_entry_id = 'mem-new' AND target_entry_id = 'mem-old'"), 1);
      assert.equal(readCount(dbPath, "SELECT COUNT(*) AS count FROM memory_mutation_events_v6 WHERE operation = 'supersede' AND entry_id = 'mem-old'"), 1);
      assert.equal(readRow<{ usage_count: number }>(dbPath, "SELECT usage_count FROM memory_tag_catalog_v6 WHERE tag_value_canonical = 'old'").usage_count, 0);
    });
  });

  it("forget はactive entryを除外し、privacy reasonではbodyを縮退し、idempotent resultを再利用する", async () => {
    await withStorage(({ storage, dbPath }) => {
      storage.appendEntry(baseAppend({ id: "mem-private" }));

      const results = storage.forgetEntries({
        target: projectTarget,
        entryIds: ["mem-private", "missing-entry"],
        reason: "privacy",
        idempotencyKey: "forget-key-a",
        bindingIdHash: "binding-hash-a",
        now: "2026-06-24T00:02:00.000Z",
      });

      assert.deepEqual(results, [
        { entryId: "mem-private", status: "forgotten" },
        { entryId: "missing-entry", status: "not_found" },
      ]);
      assert.equal(storage.searchEntries({ targets: [projectTarget], query: "CLI" }).items.length, 0);

      const forgotten = storage.getEntry("mem-private");
      assert.equal(forgotten?.state, "forgotten");
      assert.equal(forgotten?.title, "");
      assert.equal(forgotten?.body, "");
      assert.equal(forgotten?.preview, "");
      assert.deepEqual(forgotten?.tags, []);

      const replay = storage.forgetEntries({
        target: projectTarget,
        entryIds: ["missing-entry", "mem-private"],
        reason: "privacy",
        idempotencyKey: "forget-key-a",
        bindingIdHash: "binding-hash-a",
      });
      assert.deepEqual(replay, [
        { entryId: "mem-private", status: "forgotten" },
        { entryId: "missing-entry", status: "not_found" },
      ]);

      assert.deepEqual(storage.forgetEntries({ target: projectTarget, entryIds: ["mem-private"], reason: "privacy" }), [
        { entryId: "mem-private", status: "already_forgotten" },
      ]);
      assert.equal(readCount(dbPath, "SELECT COUNT(*) AS count FROM memory_mutation_events_v6 WHERE operation = 'forget' AND result_status = 'success'"), 1);
      assert.equal(readCount(dbPath, "SELECT COUNT(*) AS count FROM memory_idempotency_forget_results_v6"), 2);
      assert.equal(readRow<{ body_sha256: string }>(dbPath, "SELECT body_sha256 FROM memory_entries_v6 WHERE id = 'mem-private'").body_sha256.length, 64);
    });
  });

  it("privacy forget は既にforgottenのentryもcontentとtagsを縮退する", async () => {
    await withStorage(({ storage, dbPath }) => {
      storage.appendEntry(baseAppend({
        id: "mem-outdated-private",
        title: "残してはいけないtitle",
        body: "残してはいけないbody",
        preview: "残してはいけないpreview",
        tags: [tag("topic", "private"), tag("source", "chat")],
      }));

      assert.deepEqual(storage.forgetEntries({
        target: projectTarget,
        entryIds: ["mem-outdated-private"],
        reason: "outdated",
        now: "2026-06-24T00:02:00.000Z",
      }), [{ entryId: "mem-outdated-private", status: "forgotten" }]);

      const outdated = storage.getEntry("mem-outdated-private");
      assert.equal(outdated?.state, "forgotten");
      assert.equal(outdated?.body, "残してはいけないbody");
      assert.deepEqual(outdated?.tags.map((item) => item.value).sort(), ["chat", "private"]);
      insertProtectedObject(dbPath, {
        objectId: "obj-outdated-private",
        entryId: "mem-outdated-private",
        state: "active",
        summary: "late protected object",
        originalBytes: 10,
        storedBytes: 12,
      });

      assert.deepEqual(storage.forgetEntries({
        target: projectTarget,
        entryIds: ["mem-outdated-private"],
        reason: "privacy",
        now: "2026-06-24T00:03:00.000Z",
      }), [{ entryId: "mem-outdated-private", status: "already_forgotten" }]);

      const redacted = storage.getEntry("mem-outdated-private");
      assert.equal(redacted?.state, "forgotten");
      assert.equal(redacted?.title, "");
      assert.equal(redacted?.body, "");
      assert.equal(redacted?.preview, "");
      assert.deepEqual(redacted?.tags, []);
      assert.equal(readCount(dbPath, "SELECT COUNT(*) AS count FROM memory_entry_tags_v6 WHERE entry_id = 'mem-outdated-private'"), 0);
      assert.equal(readRow<{ updated_at: string }>(dbPath, "SELECT updated_at FROM memory_entries_v6 WHERE id = 'mem-outdated-private'").updated_at, "2026-06-24T00:03:00.000Z");
      assert.equal(readRow<{ state: string }>(dbPath, "SELECT state FROM memory_protected_objects_v6 WHERE object_id = 'obj-outdated-private'").state, "delete_pending");
    });
  });

  it("transaction失敗時にpartial stateを残さない", async () => {
    await withStorage(({ storage, dbPath }) => {
      storage.appendEntry(baseAppend({ id: "mem-project" }));

      assert.throws(() => {
        storage.appendEntry(baseAppend({
          id: "mem-character",
          target: characterTarget,
          supersedes: ["mem-project"],
        }));
      }, MemoryV6EntryNotFoundError);

      assert.equal(readCount(dbPath, "SELECT COUNT(*) AS count FROM memory_entries_v6 WHERE id = 'mem-character'"), 0);
      assert.equal(readCount(dbPath, "SELECT COUNT(*) AS count FROM memory_entries_v6"), 1);
      assert.equal(storage.getEntry("mem-project")?.state, "active");
    });
  });

  it("forget は target 外 entry を not_found に畳み、別targetのentryを変更しない", async () => {
    await withStorage(({ storage }) => {
      storage.appendEntry(baseAppend({ id: "mem-project" }));

      const results = storage.forgetEntries({
        target: characterTarget,
        entryIds: ["mem-project"],
        reason: "incorrect",
      });

      assert.deepEqual(results, [{ entryId: "mem-project", status: "not_found" }]);
      assert.equal(storage.getEntry("mem-project")?.state, "active");
    });
  });

  it("pagination cursorはactive filter後のpageを進める", async () => {
    await withStorage(({ storage }) => {
      storage.appendEntry(baseAppend({ id: "mem-a", title: "A", body: "shared query", preview: "A", now: "2026-06-24T00:00:00.000Z" }));
      storage.appendEntry(baseAppend({ id: "mem-b", title: "B", body: "shared query", preview: "B", now: "2026-06-24T00:01:00.000Z" }));
      storage.appendEntry(baseAppend({ id: "mem-c", title: "C", body: "shared query", preview: "C", now: "2026-06-24T00:02:00.000Z" }));
      storage.forgetEntries({ target: projectTarget, entryIds: ["mem-b"], reason: "outdated" });

      const first = storage.searchEntries({ targets: [projectTarget], query: "shared", limit: 1 });
      assert.deepEqual(first.items.map((item) => item.id), ["mem-c"]);
      assert.ok(first.nextCursor);

      storage.appendEntry(baseAppend({ id: "mem-d", title: "D", body: "shared query", preview: "D", now: "2026-06-24T00:03:00.000Z" }));
      storage.forgetEntries({ target: projectTarget, entryIds: ["mem-c"], reason: "outdated" });

      const second = storage.searchEntries({ targets: [projectTarget], query: "shared", limit: 1, cursor: first.nextCursor });
      assert.deepEqual(second.items.map((item) => item.id), ["mem-a"]);
      assert.equal(second.nextCursor, undefined);
    });
  });

  it("search pagination はmatch scoreに関係なくupdated_at cursor順で漏れなく進める", async () => {
    await withStorage(({ storage }) => {
      storage.appendEntry(baseAppend({
        id: "mem-low-score-old",
        title: "Delivery",
        body: "Delivery only",
        preview: "Delivery",
        tags: [tag("topic", "delivery")],
        now: "2026-06-24T00:00:00.000Z",
      }));
      storage.appendEntry(baseAppend({
        id: "mem-high-score-middle",
        title: "Delivery cleanup branch relaygraph",
        body: "delivery cleanup branch relaygraph",
        preview: "delivery cleanup branch relaygraph",
        tags: [tag("topic", "delivery-cleanup"), tag("topic", "relaygraph")],
        now: "2026-06-24T00:01:00.000Z",
      }));
      storage.appendEntry(baseAppend({
        id: "mem-low-score-new",
        title: "Delivery",
        body: "Delivery only",
        preview: "Delivery",
        tags: [tag("topic", "delivery")],
        now: "2026-06-24T00:02:00.000Z",
      }));

      const first = storage.searchEntries({
        targets: [projectTarget],
        query: "delivery cleanup branch relaygraph",
        limit: 1,
      });
      assert.deepEqual(first.items.map((item) => item.id), ["mem-low-score-new"]);
      assert.ok(first.nextCursor);

      const second = storage.searchEntries({
        targets: [projectTarget],
        query: "delivery cleanup branch relaygraph",
        limit: 2,
        cursor: first.nextCursor,
      });
      assert.deepEqual(second.items.map((item) => item.id), ["mem-high-score-middle", "mem-low-score-old"]);
      assert.equal(second.nextCursor, undefined);
    });
  });
});

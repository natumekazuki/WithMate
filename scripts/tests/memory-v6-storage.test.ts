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
});

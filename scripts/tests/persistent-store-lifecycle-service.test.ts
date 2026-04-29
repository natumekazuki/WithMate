import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import type { Session } from "../../src/session-state.js";
import {
  APP_DATABASE_V2_FILENAME,
  CREATE_V2_SCHEMA_SQL,
} from "../../src-electron/database-schema-v2.js";
import { AuditLogStorageV2 } from "../../src-electron/audit-log-storage-v2.js";
import { SessionStorage } from "../../src-electron/session-storage.js";
import { SessionStorageV2 } from "../../src-electron/session-storage-v2.js";
import {
  PersistentStoreLifecycleService,
  type PersistentStoreBundleLike,
} from "../../src-electron/persistent-store-lifecycle-service.js";

function createClosableStore(name: string, closeCalls: string[]) {
  return {
    name,
    close() {
      closeCalls.push(name);
    },
  };
}

async function withTempV2Database<T>(fn: (dbPath: string) => T | Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "withmate-v2-lifecycle-"));
  const dbPath = path.join(dir, APP_DATABASE_V2_FILENAME);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    for (const statement of CREATE_V2_SCHEMA_SQL) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }

  try {
    return await fn(dbPath);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function withTempEmptyV2NamedDatabase<T>(fn: (dbPath: string) => T | Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "withmate-v2-empty-lifecycle-"));
  const dbPath = path.join(dir, APP_DATABASE_V2_FILENAME);
  const db = new DatabaseSync(dbPath);
  db.close();

  try {
    return await fn(dbPath);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

test("PersistentStoreLifecycleService は store を初期化して session dependency を同期する", async () => {
  const closeCalls: string[] = [];
  const sessionSummaries = [
    {
      id: "session-1",
      taskTitle: "Session 1",
      status: "idle",
      runState: "idle",
    },
    {
      id: "session-2",
      taskTitle: "Session 2",
      status: "saved",
      runState: "idle",
    },
  ] as never;
  const activeModelCatalog = { revision: 1, providers: [] } as ModelCatalogSnapshot;
  let listSessionsCallCount = 0;

  const service = new PersistentStoreLifecycleService({
    createModelCatalogStorage: () =>
      ({
        ensureSeeded: () => activeModelCatalog,
        close() {
          closeCalls.push("model");
        },
      }) as never,
    createSessionStorage: () =>
      ({
        listSessions: () => {
          listSessionsCallCount += 1;
          return [];
        },
        listSessionSummaries: () => sessionSummaries,
        close() {
          closeCalls.push("session");
        },
      }) as never,
    createSessionMemoryStorage: () => createClosableStore("session-memory", closeCalls) as never,
    createProjectMemoryStorage: () => createClosableStore("project-memory", closeCalls) as never,
    createCharacterMemoryStorage: () => createClosableStore("character-memory", closeCalls) as never,
    createAuditLogStorage: () => createClosableStore("audit", closeCalls) as never,
    createAppSettingsStorage: () => createClosableStore("settings", closeCalls) as never,
    onBeforeClose: () => {
      closeCalls.push("before-close");
    },
    truncateWal() {},
    async removeFile() {},
  });

  const bundle = await service.initialize("withmate.db", "model-catalog.json");

  assert.equal(bundle.activeModelCatalog, activeModelCatalog);
  assert.deepEqual(bundle.sessions.map((session) => ({
    id: session.id,
    taskTitle: session.taskTitle,
    messages: session.messages,
    stream: session.stream,
  })), [
    { id: "session-1", taskTitle: "Session 1", messages: [], stream: [] },
    { id: "session-2", taskTitle: "Session 2", messages: [], stream: [] },
  ]);
  assert.equal(listSessionsCallCount, 0);
});

test("PersistentStoreLifecycleService は close 時に hook と各 store close を呼ぶ", () => {
  const closeCalls: string[] = [];
  const service = new PersistentStoreLifecycleService({
    createModelCatalogStorage: () => null as never,
    createSessionStorage: () => null as never,
    createSessionMemoryStorage: () => null as never,
    createProjectMemoryStorage: () => null as never,
    createCharacterMemoryStorage: () => null as never,
    createAuditLogStorage: () => null as never,
    createAppSettingsStorage: () => null as never,
    onBeforeClose: () => {
      closeCalls.push("before-close");
    },
    truncateWal: () => {
      closeCalls.push("truncate-wal");
    },
    async removeFile() {},
  });

  const bundle: PersistentStoreBundleLike = {
    modelCatalogStorage: createClosableStore("model", closeCalls) as never,
    sessionStorage: createClosableStore("session", closeCalls) as never,
    sessionMemoryStorage: createClosableStore("session-memory", closeCalls) as never,
    projectMemoryStorage: createClosableStore("project-memory", closeCalls) as never,
    characterMemoryStorage: createClosableStore("character-memory", closeCalls) as never,
    auditLogStorage: createClosableStore("audit", closeCalls) as never,
    appSettingsStorage: createClosableStore("settings", closeCalls) as never,
  };

  service.close(bundle, "withmate.db");

  assert.deepEqual(closeCalls, [
    "before-close",
    "model",
    "session",
    "session-memory",
    "project-memory",
    "character-memory",
    "audit",
    "settings",
    "truncate-wal",
  ]);
});

test("PersistentStoreLifecycleService は WAL truncate 失敗を close 呼び出し元へ伝播しない", () => {
  const closeCalls: string[] = [];
  const warnCalls: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };

  try {
    const service = new PersistentStoreLifecycleService({
      createModelCatalogStorage: () => null as never,
      createSessionStorage: () => null as never,
      createSessionMemoryStorage: () => null as never,
      createProjectMemoryStorage: () => null as never,
      createCharacterMemoryStorage: () => null as never,
      createAuditLogStorage: () => null as never,
      createAppSettingsStorage: () => null as never,
      onBeforeClose: () => {
        closeCalls.push("before-close");
      },
      truncateWal: () => {
        throw new Error("checkpoint failed");
      },
      async removeFile() {},
    });

    assert.doesNotThrow(() => service.close({}, "withmate.db"));
    assert.deepEqual(closeCalls, ["before-close"]);
    assert.equal(warnCalls.length, 1);
    assert.equal(warnCalls[0]?.[0], "SQLite WAL truncate failed");
  } finally {
    console.warn = originalWarn;
  }
});

test("PersistentStoreLifecycleService は WAL truncate 失敗後も DB 再生成へ進む", async () => {
  const removedPaths: string[] = [];
  const service = new PersistentStoreLifecycleService({
    createModelCatalogStorage: () =>
      ({
        ensureSeeded: () => ({ revision: 3, providers: [] }),
        close() {},
      }) as never,
    createSessionStorage: () =>
      ({
        listSessions: () => [],
        listSessionSummaries: () => [],
        close() {},
      }) as never,
    createSessionMemoryStorage: () => ({ close() {} }) as never,
    createProjectMemoryStorage: () => ({ close() {} }) as never,
    createCharacterMemoryStorage: () => ({ close() {} }) as never,
    createAuditLogStorage: () => ({ close() {} }) as never,
    createAppSettingsStorage: () => ({ close() {} }) as never,
    onBeforeClose: () => {},
    truncateWal: () => {
      throw new Error("checkpoint failed");
    },
    async removeFile(filePath) {
      removedPaths.push(filePath);
    },
  });
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    const bundle = await service.recreate("withmate.db", "model-catalog.json", {});
    assert.equal(bundle.activeModelCatalog.revision, 3);
    assert.deepEqual(removedPaths, [
      "withmate.db-wal",
      "withmate.db-shm",
      "withmate.db",
    ]);
  } finally {
    console.warn = originalWarn;
  }
});

test("PersistentStoreLifecycleService は DB を再生成して再初期化する", async () => {
  const removedPaths: string[] = [];
  const truncateWalCalls: string[] = [];
  const service = new PersistentStoreLifecycleService({
    createModelCatalogStorage: () =>
      ({
        ensureSeeded: () => ({ revision: 2, providers: [] }),
        close() {},
      }) as never,
    createSessionStorage: () =>
      ({
        listSessions: () => [],
        listSessionSummaries: () => [],
        close() {},
      }) as never,
    createSessionMemoryStorage: () => ({ close() {} }) as never,
    createProjectMemoryStorage: () => ({ close() {} }) as never,
    createCharacterMemoryStorage: () => ({ close() {} }) as never,
    createAuditLogStorage: () => ({ close() {} }) as never,
    createAppSettingsStorage: () => ({ close() {} }) as never,
    onBeforeClose: () => {},
    truncateWal(dbPath) {
      truncateWalCalls.push(dbPath);
    },
    async removeFile(filePath) {
      removedPaths.push(filePath);
    },
  });

  const bundle = await service.recreate("withmate.db", "model-catalog.json", {});

  assert.deepEqual(removedPaths, [
    "withmate.db-wal",
    "withmate.db-shm",
    "withmate.db",
  ]);
  assert.deepEqual(truncateWalCalls, ["withmate.db"]);
  assert.equal(bundle.activeModelCatalog.revision, 2);
});

test("PersistentStoreLifecycleService は V2 DB 再生成後に V2 schema を作成して再初期化する", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "withmate-v2-recreate-"));
  const dbPath = path.join(dir, APP_DATABASE_V2_FILENAME);

  try {
    const service = new PersistentStoreLifecycleService({
      createModelCatalogStorage: () =>
        ({
          ensureSeeded: () => ({ revision: 4, providers: [] }),
          close() {},
        }) as never,
      createSessionStorage: () => {
        throw new Error("V2 DB では V1 session storage を生成しない");
      },
      createSessionMemoryStorage: () => ({ close() {} }) as never,
      createProjectMemoryStorage: () => ({ close() {} }) as never,
      createCharacterMemoryStorage: () => ({ close() {} }) as never,
      createAuditLogStorage: () => {
        throw new Error("V2 DB では V1 audit log storage を生成しない");
      },
      createAppSettingsStorage: () => ({ close() {} }) as never,
      ensureV2Schema(pathToDb) {
        const db = new DatabaseSync(pathToDb);
        try {
          db.exec("PRAGMA foreign_keys = ON;");
          for (const statement of CREATE_V2_SCHEMA_SQL) {
            db.exec(statement);
          }
        } finally {
          db.close();
        }
      },
      onBeforeClose: () => {},
      truncateWal() {},
      async removeFile(filePath) {
        await rm(filePath, { force: true });
      },
    });

    const bundle = await service.recreate(dbPath, "model-catalog.json", {});

    assert.equal(bundle.activeModelCatalog.revision, 4);
    assert.equal(bundle.sessionStorage instanceof SessionStorageV2, true);
    assert.deepEqual(bundle.sessions, []);
    service.close(bundle, dbPath);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get();
      assert.ok(row);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("PersistentStoreLifecycleService は required V2 tables がない withmate-v2.db では V1-compatible injected storages を使う", async () => {
  const activeModelCatalog = { revision: 5, providers: [] } as ModelCatalogSnapshot;
  let createSessionStorageCallCount = 0;
  let createAuditLogStorageCallCount = 0;

  await withTempEmptyV2NamedDatabase(async (dbPath) => {
    const service = new PersistentStoreLifecycleService({
      createModelCatalogStorage: () =>
        ({
          ensureSeeded: () => activeModelCatalog,
          close() {},
        }) as never,
      createSessionStorage: () => {
        createSessionStorageCallCount += 1;
        return {
          listSessions: () => [],
          listSessionSummaries: () => [],
          close() {},
        } as never;
      },
      createSessionMemoryStorage: () => ({ close() {} }) as never,
      createProjectMemoryStorage: () => ({ close() {} }) as never,
      createCharacterMemoryStorage: () => ({ close() {} }) as never,
      createAuditLogStorage: () => {
        createAuditLogStorageCallCount += 1;
        return {
          close() {},
        } as never;
      },
      createAppSettingsStorage: () => ({ close() {} }) as never,
      onBeforeClose: () => {},
      truncateWal() {},
      async removeFile() {},
    });

    const bundle = await service.initialize(dbPath, "model-catalog.json");

    assert.equal(bundle.activeModelCatalog, activeModelCatalog);
    assert.equal(bundle.sessionStorage instanceof SessionStorageV2, false);
    assert.equal(bundle.auditLogStorage instanceof AuditLogStorageV2, false);
    assert.equal(createSessionStorageCallCount, 1);
    assert.equal(createAuditLogStorageCallCount, 1);
  });
});

test("PersistentStoreLifecycleService は V2 DB では SessionStorageV2 を使ってセッション要約を読む", async () => {
  const activeModelCatalog = { revision: 1, providers: [] } as ModelCatalogSnapshot;

  await withTempV2Database(async (dbPath) => {
    let v1SessionStorage: { close(): void } | null = null;

    const service = new PersistentStoreLifecycleService({
      createModelCatalogStorage: () =>
        ({
          ensureSeeded: () => activeModelCatalog,
          close() {},
        }) as never,
      createSessionStorage: () => {
        const storage = new SessionStorage(dbPath);
        v1SessionStorage = storage;
        return storage as never;
      },
      createSessionMemoryStorage: () => ({ close() {} }) as never,
      createProjectMemoryStorage: () => ({ close() {} }) as never,
      createCharacterMemoryStorage: () => ({ close() {} }) as never,
      createAuditLogStorage: () => ({ close() {} }) as never,
      createAppSettingsStorage: () => ({ close() {} }) as never,
      onBeforeClose: () => {},
      truncateWal() {},
      async removeFile() {},
    });

    let bundle: Awaited<ReturnType<typeof service.initialize>> | null = null;
    try {
      bundle = await service.initialize(dbPath, "model-catalog.json");
      assert.equal(bundle.sessionStorage instanceof SessionStorageV2, true);
      assert.deepEqual(bundle.sessions, []);
    } finally {
      if (bundle) {
        service.close(bundle, dbPath);
      }
      v1SessionStorage?.close();
    }
  });
});

test("PersistentStoreLifecycleService は V2 DB では V1 write-capable storages を生成せず V2 storages を返す", async () => {
  const activeModelCatalog = { revision: 2, providers: [] } as ModelCatalogSnapshot;
  let createSessionStorageCallCount = 0;
  let createAuditLogStorageCallCount = 0;

  await withTempV2Database(async (dbPath) => {
    const service = new PersistentStoreLifecycleService({
      createModelCatalogStorage: () =>
        ({
          ensureSeeded: () => activeModelCatalog,
          close() {},
        }) as never,
      createSessionStorage: () => {
        createSessionStorageCallCount += 1;
        return {
          listSessions: () => [],
          listSessionSummaries: () => [],
          close() {},
        } as never;
      },
      createSessionMemoryStorage: () => ({ close() {} }) as never,
      createProjectMemoryStorage: () => ({ close() {} }) as never,
      createCharacterMemoryStorage: () => ({ close() {} }) as never,
      createAuditLogStorage: () => {
        createAuditLogStorageCallCount += 1;
        return {
          close() {},
        } as never;
      },
      createAppSettingsStorage: () => ({ close() {} }) as never,
      onBeforeClose: () => {},
      truncateWal() {},
      async removeFile() {},
    });

    const bundle = await service.initialize(dbPath, "model-catalog.json");
    try {
      assert.equal(bundle.sessionStorage instanceof SessionStorageV2, true);
      assert.equal(bundle.auditLogStorage instanceof AuditLogStorageV2, true);
      assert.equal(createSessionStorageCallCount, 0);
      assert.equal(createAuditLogStorageCallCount, 0);
    } finally {
      service.close(bundle, dbPath);
    }
  });
});

test("PersistentStoreLifecycleService は V2 DB に legacy memory table を作成しない", async () => {
  const activeModelCatalog = { revision: 3, providers: [] } as ModelCatalogSnapshot;
  let createSessionMemoryStorageCallCount = 0;
  let createProjectMemoryStorageCallCount = 0;
  let createCharacterMemoryStorageCallCount = 0;

  await withTempV2Database(async (dbPath) => {
    const service = new PersistentStoreLifecycleService({
      createModelCatalogStorage: () =>
        ({
          ensureSeeded: () => activeModelCatalog,
          close() {},
        }) as never,
      createSessionStorage: () => {
        throw new Error("V2 DB では V1 session storage を生成しない");
      },
      createSessionMemoryStorage: () => {
        createSessionMemoryStorageCallCount += 1;
        return { close() {} } as never;
      },
      createProjectMemoryStorage: () => {
        createProjectMemoryStorageCallCount += 1;
        return { close() {} } as never;
      },
      createCharacterMemoryStorage: () => {
        createCharacterMemoryStorageCallCount += 1;
        return { close() {} } as never;
      },
      createAuditLogStorage: () => {
        throw new Error("V2 DB では V1 audit log storage を生成しない");
      },
      createAppSettingsStorage: () => ({ close() {} }) as never,
      onBeforeClose: () => {},
      truncateWal() {},
      async removeFile() {},
    });

    const bundle = await service.initialize(dbPath, "model-catalog.json");
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = db.prepare(`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name IN (
              'session_memories',
              'project_scopes',
              'project_memory_entries',
              'character_scopes',
              'character_memory_entries'
            )
          ORDER BY name
        `).all() as Array<{ name: string }>;
        assert.deepEqual(rows, []);
      } finally {
        db.close();
      }

      assert.equal(createSessionMemoryStorageCallCount, 0);
      assert.equal(createProjectMemoryStorageCallCount, 0);
      assert.equal(createCharacterMemoryStorageCallCount, 0);
    } finally {
      service.close(bundle, dbPath);
    }
  });
});

import assert from "node:assert/strict";
import test from "node:test";

import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import type { Session } from "../../src/session-state.js";
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

test("PersistentStoreLifecycleService は store を初期化して session dependency を同期する", async () => {
  const closeCalls: string[] = [];
  const sessions = [{ id: "session-1" }, { id: "session-2" }] as Session[];
  const activeModelCatalog = { revision: 1, providers: [] } as ModelCatalogSnapshot;

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
        listSessions: () => sessions,
        close() {
          closeCalls.push("session");
        },
      }) as never,
    createSessionMemoryStorage: () => createClosableStore("session-memory", closeCalls) as never,
    createProjectMemoryStorage: () => createClosableStore("project-memory", closeCalls) as never,
    createCharacterMemoryStorage: () => createClosableStore("character-memory", closeCalls) as never,
    createCompanionStorage: () => createClosableStore("companion", closeCalls) as never,
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
  assert.deepEqual(bundle.sessions, sessions);
});

test("PersistentStoreLifecycleService は close 時に hook と各 store close を呼ぶ", () => {
  const closeCalls: string[] = [];
  const service = new PersistentStoreLifecycleService({
    createModelCatalogStorage: () => null as never,
    createSessionStorage: () => null as never,
    createSessionMemoryStorage: () => null as never,
    createProjectMemoryStorage: () => null as never,
    createCharacterMemoryStorage: () => null as never,
    createCompanionStorage: () => null as never,
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
    companionStorage: createClosableStore("companion", closeCalls) as never,
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
    "companion",
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
      createCompanionStorage: () => null as never,
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
        close() {},
      }) as never,
    createSessionMemoryStorage: () => ({ close() {} }) as never,
    createProjectMemoryStorage: () => ({ close() {} }) as never,
    createCharacterMemoryStorage: () => ({ close() {} }) as never,
    createCompanionStorage: () => ({ close() {} }) as never,
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
        close() {},
      }) as never,
    createSessionMemoryStorage: () => ({ close() {} }) as never,
    createProjectMemoryStorage: () => ({ close() {} }) as never,
    createCharacterMemoryStorage: () => ({ close() {} }) as never,
    createCompanionStorage: () => ({ close() {} }) as never,
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

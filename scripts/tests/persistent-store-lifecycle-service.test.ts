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
  const syncedSessionIds: string[] = [];
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
    createAuditLogStorage: () => createClosableStore("audit", closeCalls) as never,
    createAppSettingsStorage: () => createClosableStore("settings", closeCalls) as never,
    syncSessionDependencies: (session) => {
      syncedSessionIds.push(session.id);
    },
    onBeforeClose: () => {
      closeCalls.push("before-close");
    },
    async removeFile() {},
  });

  const bundle = await service.initialize("withmate.db", "model-catalog.json");

  assert.equal(bundle.activeModelCatalog, activeModelCatalog);
  assert.deepEqual(bundle.sessions, sessions);
  assert.deepEqual(syncedSessionIds, ["session-1", "session-2"]);
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
    syncSessionDependencies: () => {},
    onBeforeClose: () => {
      closeCalls.push("before-close");
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

  service.close(bundle);

  assert.deepEqual(closeCalls, [
    "before-close",
    "model",
    "session",
    "session-memory",
    "project-memory",
    "character-memory",
    "audit",
    "settings",
  ]);
});

test("PersistentStoreLifecycleService は DB を再生成して再初期化する", async () => {
  const removedPaths: string[] = [];
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
    createAuditLogStorage: () => ({ close() {} }) as never,
    createAppSettingsStorage: () => ({ close() {} }) as never,
    syncSessionDependencies: () => {},
    onBeforeClose: () => {},
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
  assert.equal(bundle.activeModelCatalog.revision, 2);
});

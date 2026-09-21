import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import type { AuxiliarySession } from "../../src/auxiliary-session-state.js";
import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import type { Session } from "../../src/session-state.js";
import {
  APP_DATABASE_V2_FILENAME,
  CREATE_V2_SCHEMA_SQL,
} from "../../src-electron/database-schema-v2.js";
import { APP_DATABASE_V1_FILENAME } from "../../src-electron/database-schema-v1.js";
import {
  APP_DATABASE_V3_FILENAME,
  CREATE_V3_SCHEMA_SQL,
} from "../../src-electron/database-schema-v3.js";
import { APP_DATABASE_V4_FILENAME } from "../../src-electron/database-schema-v4.js";
import { APP_DATABASE_V6_FILENAME } from "../../src-electron/database-schema-v6.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { MateStorage } from "../../src-electron/mate-storage.js";
import { AuditLogStorageV2 } from "../../src-electron/audit-log-storage-v2.js";
import { AuditLogStorageV3 } from "../../src-electron/audit-log-storage-v3.js";
import { SessionStorage } from "../../src-electron/session-storage.js";
import { SessionStorageV2 } from "../../src-electron/session-storage-v2.js";
import { SessionStorageV3 } from "../../src-electron/session-storage-v3.js";
import {
  PersistentStoreLifecycleService,
  createPersistentStoreLifecycleService,
  type CharacterStorageAccess,
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

function createCharacterStorageStub(onClose: () => void = () => undefined): CharacterStorageAccess {
  const unavailable = (): never => {
    throw new Error("このテストでは character storage の操作を実行しない");
  };

  return {
    getCharacterDirectory: unavailable,
    listCharacters: unavailable,
    getCharacterCatalogEntry: unavailable,
    getCharacter: unavailable,
    createCharacter: unavailable,
    updateCharacterMetadata: unavailable,
    updateCharacterDefinition: unavailable,
    archiveCharacter: unavailable,
    resolveLaunchCharacter: unavailable,
    createRuntimeSnapshot: unavailable,
    deleteCharacterRootDirectory: unavailable,
    close: onClose,
  };
}

function insertV3SessionHeader(dbPath: string, sessionId: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      INSERT INTO sessions (
        id,
        task_title,
        status,
        updated_at,
        provider,
        catalog_revision,
        workspace_label,
        workspace_path,
        branch,
        session_kind,
        character_id,
        character_name,
        character_icon_path,
        character_theme_main,
        character_theme_sub,
        run_state,
        approval_mode,
        codex_sandbox_mode,
        model,
        reasoning_effort,
        custom_agent_name,
        allowed_additional_directories_json,
        thread_id,
        message_count,
        audit_log_count,
        last_active_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      "Runtime task",
      "idle",
      "2026-04-27T00:00:00.000Z",
      "codex",
      1,
      "Workspace A",
      "workspace-a",
      "main",
      "default",
      "char-a",
      "A",
      "",
      "#6f8cff",
      "#6fb8c7",
      "idle",
      "untrusted",
      "workspace-write",
      "gpt-5.4-mini",
      "medium",
      "",
      "[]",
      "thread-v3",
      0,
      0,
      1,
    );
  } finally {
    db.close();
  }
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

async function withTempV3Database<T>(fn: (dbPath: string) => T | Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "withmate-v3-lifecycle-"));
  const dbPath = path.join(dir, APP_DATABASE_V3_FILENAME);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    for (const statement of CREATE_V3_SCHEMA_SQL) {
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

async function withTempDatabaseAndUserData<T>(fn: (dbPath: string, userDataPath: string) => T | Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "withmate-v4-lifecycle-"));
  const dbPath = path.join(dir, "withmate-v4.db");
  const userDataPath = path.join(dir, "user-data");

  try {
    return await fn(dbPath, userDataPath);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function withTempLegacyDatabase<T>(fn: (dbPath: string, userDataPath: string) => T | Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "withmate-v1-lifecycle-"));
  const dbPath = path.join(dir, APP_DATABASE_V1_FILENAME);
  const userDataPath = path.join(dir, "user-data");
  const db = new DatabaseSync(dbPath);
  db.close();

  try {
    return await fn(dbPath, userDataPath);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function readTableNames(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

function createAuxiliarySessionFixture(overrides: Partial<AuxiliarySession> = {}): AuxiliarySession {
  return {
    id: "aux-v6",
    parentSessionId: "session-v6",
    status: "active",
    runState: "idle",
    title: "V6 auxiliary",
    provider: "codex",
    catalogRevision: 1,
    model: "gpt-5.4",
    reasoningEffort: "medium",
    approvalMode: "untrusted",
    codexSandboxMode: "workspace-write",
    codexSpeed: "standard",
    codexReviewer: "user",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "",
    composerDraft: "",
    messages: [],
    displayAfterMessageIndex: null,
    createdAt: "2026-07-02T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    closedAt: "",
    ...overrides,
  };
}

// @test-value v2
// kind = "contract"
// claim = "initialize は model catalog と session summary を bundle に反映する"
// oracle = { type = "contract", ref = "src-electron/persistent-store-lifecycle-service.ts#initialize" }
// fault = "初期化後の bundle が model catalog または session summary を失う"
// observable = "activeModelCatalog、sessions、listSessionSummaries の呼出し回数"
// observation_boundary = "public-boundary"
// scope = "persistent-store-initialize-close"
// lifecycle = "permanent"
// @end-test-value
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
    createCharacterStorage: () => createCharacterStorageStub(() => closeCalls.push("character-memory")),
    createAuditLogStorage: () => createClosableStore("audit", closeCalls) as never,
    createAppSettingsStorage: () => createClosableStore("settings", closeCalls) as never,
    createMateStorage: () => createClosableStore("mate", closeCalls) as never,
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

// @test-value v2
// kind = "contract"
// claim = "起動時の Mate projection 復元は mismatch を警告し、保存された profile を失わない"
// oracle = { type = "contract", ref = "src-electron/persistent-store-lifecycle-service.ts#recoverActiveMateProfileProjection" }
// fault = "projection mismatch を黙って無視する、または起動時に profile を上書きする"
// observable = "復元後の Mate profile と console.warn の mismatch 内容"
// observation_boundary = "public-boundary"
// scope = "persistent-store-mate-projection"
// lifecycle = "permanent"
// @end-test-value
test("PersistentStoreLifecycleService は起動時に Mate projection を復元し、残存 mismatch を警告ログに残す", async () => {
  const warnCalls: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };

  try {
    const service = new PersistentStoreLifecycleService({
      createModelCatalogStorage: () =>
        ({
          ensureSeeded: () => ({ revision: 1, providers: [] }),
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
      createCharacterStorage: () => createCharacterStorageStub(),
      createAuditLogStorage: () => ({ close() {} }) as never,
      createAppSettingsStorage: () => ({ close() {} }) as never,
      createMateStorage: () =>
        ({
          close() {},
          recoverMateProfileFilesFromActiveRevision: async () => [
            {
              sectionKey: "core",
              filePath: "mate/core.md",
              expectedHash: "expected",
              actualHash: "actual",
              expectedByteSize: 10,
              actualByteSize: 9,
              reason: "hash_mismatch",
            },
          ],
        }) as never,
      onBeforeClose: () => {},
      truncateWal() {},
      async removeFile() {},
    });

    const bundle = await service.initialize("withmate.db", "model-catalog.json");

    service.close(bundle, "withmate.db");
    assert.equal(warnCalls.length, 1);
    assert.equal(warnCalls[0]?.[0], "Mate profile projection recovery has remaining mismatches");
    assert.deepEqual(warnCalls[0]?.[1], {
      count: 1,
      mismatches: [
        {
          sectionKey: "core",
          filePath: "mate/core.md",
          expectedHash: "expected",
          actualHash: "actual",
          expectedByteSize: 10,
          actualByteSize: 9,
          reason: "hash_mismatch",
        },
      ],
    });
  } finally {
    console.warn = originalWarn;
  }
});

// @test-value v2
// kind = "invariant"
// claim = "V4 DB の initialize は Mate schema hook を一度だけ呼ぶ"
// oracle = { type = "contract", ref = "src-electron/persistent-store-lifecycle-service.ts#initialize" }
// fault = "V4 DB 起動で Mate schema を初期化しない、または重複初期化する"
// observable = "ensureMateSchema の呼出し回数と db path"
// observation_boundary = "public-boundary"
// scope = "persistent-store-v4-schema"
// lifecycle = "permanent"
// @end-test-value
test("PersistentStoreLifecycleService は v4 DB 起動時に Mate schema を初期化する", async () => {
  await withTempDatabaseAndUserData(async (dbPath, userDataPath) => {
    const service = new PersistentStoreLifecycleService({
      createModelCatalogStorage: () =>
        ({
          ensureSeeded: () => ({ revision: 1, providers: [] }),
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
      createCharacterStorage: () => createCharacterStorageStub(),
      createAuditLogStorage: () => ({ close() {} }) as never,
      createAppSettingsStorage: () => ({ close() {} }) as never,
      createMateStorage: (nextDbPath, nextUserDataPath) => new MateStorage(nextDbPath, nextUserDataPath),
      onBeforeClose: () => {},
      truncateWal() {},
      async removeFile() {},
    });

    const bundle = await service.initialize(dbPath, "model-catalog.json", userDataPath);

    assert.equal(bundle.mateStorage.getMateState(), "not_created");
    assert.throws(
      () => bundle.auxiliarySessionStorage.upsertAuxiliarySession(
        createAuxiliarySessionFixture({ parentSessionId: "session-v4" }),
      ),
      /Auxiliary Session は legacy DB では利用できません/,
    );

    const db = new DatabaseSync(dbPath);
    try {
      const mateProfileTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mate_profile'")
        .get();
      assert.ok(mateProfileTable);
    } finally {
      db.close();
    }

    service.close(bundle, dbPath);
  });
});

// @test-value v2
// kind = "invariant"
// claim = "legacy DB の initialize は V4 専用の Mate schema hook を呼ばない"
// oracle = { type = "contract", ref = "src-electron/persistent-store-lifecycle-service.ts#initialize" }
// fault = "legacy DB 起動時に V4 schema を追加作成する"
// observable = "ensureMateSchema の呼出し回数"
// observation_boundary = "public-boundary"
// scope = "persistent-store-legacy-schema"
// lifecycle = "permanent"
// @end-test-value
test("PersistentStoreLifecycleService は legacy DB 起動時に Mate schema を初期化しない", async () => {
  await withTempLegacyDatabase(async (dbPath, userDataPath) => {
    const service = new PersistentStoreLifecycleService({
      createModelCatalogStorage: () =>
        ({
          ensureSeeded: () => ({ revision: 1, providers: [] }),
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
      createCharacterStorage: () => createCharacterStorageStub(),
      createAuditLogStorage: () => ({ close() {} }) as never,
      createAppSettingsStorage: () => ({ close() {} }) as never,
      createMateStorage: (nextDbPath, nextUserDataPath) => new MateStorage(nextDbPath, nextUserDataPath),
      onBeforeClose: () => {},
      truncateWal() {},
      async removeFile() {},
    });

    const bundle = await service.initialize(dbPath, "model-catalog.json", userDataPath);
    try {
      assert.equal(bundle.mateStorage.getMateState(), "profile_unavailable");

      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = db.prepare(`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name IN ('mate_profile', 'provider_instruction_targets')
          ORDER BY name
        `).all() as Array<{ name: string }>;
        assert.deepEqual(rows, []);
      } finally {
        db.close();
      }
    } finally {
      service.close(bundle, dbPath);
    }
  });
});

// @test-value v2
// kind = "invariant"
// claim = "V3 legacy DB の initialize は V4 専用の Mate schema hook を呼ばない"
// oracle = { type = "contract", ref = "src-electron/persistent-store-lifecycle-service.ts#initialize" }
// fault = "V3 DB 起動時に V4 schema を追加作成する"
// observable = "ensureMateSchema の呼出し回数"
// observation_boundary = "public-boundary"
// scope = "persistent-store-v3-schema"
// lifecycle = "permanent"
// @end-test-value
test("PersistentStoreLifecycleService は V3 legacy DB 起動時に Mate schema を初期化しない", async () => {
  await withTempV3Database(async (dbPath) => {
    const userDataPath = path.join(path.dirname(dbPath), "user-data");
    const service = new PersistentStoreLifecycleService({
      createModelCatalogStorage: () =>
        ({
          ensureSeeded: () => ({ revision: 1, providers: [] }),
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
      createCharacterStorage: () => createCharacterStorageStub(),
      createAuditLogStorage: () => ({ close() {} }) as never,
      createAppSettingsStorage: () =>
        ({
          get() {
            return null;
          },
          set() {},
          delete() {},
          listAll() {
            return [];
          },
          close() {},
        }) as never,
      createMateStorage: (nextDbPath, nextUserDataPath) => new MateStorage(nextDbPath, nextUserDataPath),
      onBeforeClose: () => {},
      truncateWal() {},
      async removeFile() {},
    });

    const bundle = await service.initialize(dbPath, "model-catalog.json", userDataPath);
    try {
      assert.equal(bundle.mateStorage.getMateState(), "profile_unavailable");

      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = db.prepare(`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name IN ('mate_profile', 'provider_instruction_targets')
          ORDER BY name
        `).all() as Array<{ name: string }>;
        assert.deepEqual(rows, []);
      } finally {
        db.close();
      }
    } finally {
      service.close(bundle, dbPath);
    }
  });
});

// @test-value v2
// kind = "contract"
// claim = "V4 DB 起動時の Mate projection は active revision snapshot から復元される"
// oracle = { type = "contract", ref = "src-electron/persistent-store-lifecycle-service.ts#recoverActiveMateProfileProjection" }
// fault = "active revision の profile を復元せず、古い projection を残す"
// observable = "initialize 後に読み出した Mate profile の revision と内容"
// observation_boundary = "public-boundary"
// scope = "persistent-store-v4-mate-projection"
// lifecycle = "permanent"
// @end-test-value
test("PersistentStoreLifecycleService は v4 DB 起動時に Mate projection を active revision snapshot から復元する", async () => {
  await withTempDatabaseAndUserData(async (dbPath, userDataPath) => {
    const service = new PersistentStoreLifecycleService({
      createModelCatalogStorage: () =>
        ({
          ensureSeeded: () => ({ revision: 1, providers: [] }),
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
      createCharacterStorage: () => createCharacterStorageStub(),
      createAuditLogStorage: () => ({ close() {} }) as never,
      createAppSettingsStorage: () => ({ close() {} }) as never,
      createMateStorage: (nextDbPath, nextUserDataPath) => new MateStorage(nextDbPath, nextUserDataPath),
      onBeforeClose: () => {},
      truncateWal() {},
      async removeFile() {},
    });

    const firstBundle = await service.initialize(dbPath, "model-catalog.json", userDataPath);
    try {
      await firstBundle.mateStorage.createMate({ displayName: "Mika" });
      await firstBundle.mateStorage.applyProfileFiles({
        summary: "seed core",
        files: [{ sectionKey: "core", relativePath: "mate/core.md", content: "# Core\n- Stable\n" }],
      });
    } finally {
      service.close(firstBundle, dbPath);
    }

    const corePath = path.join(userDataPath, "mate/core.md");
    await writeFile(corePath, "# Core\n- Broken\n", "utf8");

    const secondBundle = await service.initialize(dbPath, "model-catalog.json", userDataPath);
    try {
      const restoredCore = await readFile(corePath, "utf8");
      const mismatches = await secondBundle.mateStorage.verifyMateProfileFiles();

      assert.equal(restoredCore, "# Core\n- Stable\n");
      assert.deepEqual(mismatches, []);
    } finally {
      service.close(secondBundle, dbPath);
    }
  });
});

// @test-value v2
// kind = "contract"
// claim = "close は before-close hook の後に bundle の各 store を定義済み順で閉じる"
// oracle = { type = "contract", ref = "src-electron/persistent-store-lifecycle-service.ts#close" }
// fault = "store を閉じ忘れる、または hook より先に close する"
// observable = "closeCalls の全要素と順序"
// observation_boundary = "public-boundary"
// scope = "persistent-store-close-order"
// lifecycle = "permanent"
// @end-test-value
test("PersistentStoreLifecycleService は close 時に hook と各 store close を呼ぶ", () => {
  const closeCalls: string[] = [];
  const service = new PersistentStoreLifecycleService({
    createModelCatalogStorage: () => null as never,
    createSessionStorage: () => null as never,
    createSessionMemoryStorage: () => null as never,
    createProjectMemoryStorage: () => null as never,
    createCharacterStorage: () => createCharacterStorageStub(),
    createAuditLogStorage: () => null as never,
    createAppSettingsStorage: () => null as never,
    createMateStorage: () => null as never,
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
    characterStorage: createCharacterStorageStub(() => closeCalls.push("character")),
    sessionMemoryStorage: createClosableStore("session-memory", closeCalls) as never,
    projectMemoryStorage: createClosableStore("project-memory", closeCalls) as never,
    auditLogStorage: createClosableStore("audit", closeCalls) as never,
    appSettingsStorage: createClosableStore("settings", closeCalls) as never,
    mateStorage: createClosableStore("mate", closeCalls) as never,
  };

  service.close(bundle, "withmate.db");

  assert.deepEqual(closeCalls, [
    "before-close",
    "model",
    "character",
    "session",
    "session-memory",
    "project-memory",
    "audit",
    "settings",
    "mate",
    "truncate-wal",
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "V6 closeは初期化前にMain側WAL操作を行わず、初期化後はWorkerのcheckpoint完了を待ってからWorkerを閉じる"
// oracle = { type = "contract", ref = "docs/design/database-schema.md: V6 SQLite所有者とWAL maintenance" }
// fault = "Worker不在のV6 closeがMainへ同期SQLite操作を委譲する、またはWorker checkpoint完了前に接続を閉じる"
// observable = "Main/WorkerへのWAL要求、checkpoint保留中と完了後のWorker close、before-close hookの呼出し"
// observation_boundary = "public-boundary"
// scope = "persistent-store-worker-close"
// lifecycle = "permanent"
// impact = "初期化前closeの所有権違反警告と終了時checkpointの中断を防ぐ"
// distinction = "SQLite guard単体ではlifecycleの委譲先と非同期close順序を検出できず、短い制御Promiseで待機を観測する"
// @end-test-value
test("PersistentStoreLifecycleService は V6 WAL の終了処理を Worker の所有境界内で行う", async () => {
  const calls: string[] = [];
  const service = new PersistentStoreLifecycleService({
    createModelCatalogStorage: () => null as never,
    createSessionStorage: () => null as never,
    createSessionMemoryStorage: () => null as never,
    createProjectMemoryStorage: () => null as never,
    createAuditLogStorage: () => null as never,
    createAppSettingsStorage: () => null as never,
    createMateStorage: () => null as never,
    onBeforeClose: () => { calls.push("before-close"); },
    truncateWal: () => { calls.push("main-wal"); },
    async removeFile() {},
  });
  const dbPath = path.join("user-data", APP_DATABASE_V6_FILENAME);
  await service.close({ storageWorker: null }, dbPath);
  assert.deepEqual(calls, ["before-close"]);

  calls.length = 0;
  let finishCheckpoint!: () => void;
  const checkpoint = new Promise<void>((resolve) => { finishCheckpoint = resolve; });
  const closing = service.close({
    storageWorker: {
      async truncateWal() {
        calls.push("worker-wal");
        await checkpoint;
        calls.push("checkpoint-complete");
      },
      client: { async close() { calls.push("worker-close"); } },
    } as never,
  }, dbPath);
  try {
    assert.deepEqual(calls, ["before-close", "worker-wal"]);
  } finally {
    finishCheckpoint();
    await closing;
  }
  assert.deepEqual(calls, ["before-close", "worker-wal", "checkpoint-complete", "worker-close"]);
});

// @test-value v2
// kind = "contract"
// claim = "WAL truncate の失敗は警告に記録されるが close の呼び出し元へは伝播しない"
// oracle = { type = "contract", ref = "src-electron/persistent-store-lifecycle-service.ts#close" }
// fault = "終了処理の WAL 失敗で close が例外終了する"
// observable = "doesNotThrow、before-close 呼出し、console.warn の内容"
// observation_boundary = "public-boundary"
// scope = "persistent-store-wal-error"
// lifecycle = "permanent"
// @end-test-value
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
      createCharacterStorage: () => createCharacterStorageStub(),
      createAuditLogStorage: () => null as never,
      createAppSettingsStorage: () => null as never,
      createMateStorage: () => null as never,
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

// @test-value v2
// kind = "contract"
// claim = "WAL truncate が失敗しても recreate は WAL/SHM/DB を削除して再初期化する"
// oracle = { type = "contract", ref = "src-electron/persistent-store-lifecycle-service.ts#recreate" }
// fault = "WAL 失敗を理由に DB 再生成を中断する"
// observable = "active model catalog と削除された3つの path"
// observation_boundary = "public-boundary"
// scope = "persistent-store-recreate-wal-error"
// lifecycle = "permanent"
// @end-test-value
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
    createCharacterStorage: () => createCharacterStorageStub(),
    createAuditLogStorage: () => ({ close() {} }) as never,
    createAppSettingsStorage: () => ({ close() {} }) as never,
    createMateStorage: () => ({ close() {} }) as never,
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

// @test-value v2
// kind = "contract"
// claim = "recreate は既存 DB を削除し、指定された依存関係で新しい bundle を初期化する"
// oracle = { type = "contract", ref = "src-electron/persistent-store-lifecycle-service.ts#recreate" }
// fault = "再生成前の DB を残す、または新 bundle を初期化しない"
// observable = "truncate path、removeFile path、active model catalog"
// observation_boundary = "public-boundary"
// scope = "persistent-store-recreate"
// lifecycle = "permanent"
// @end-test-value
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
    createCharacterStorage: () => createCharacterStorageStub(),
    createAuditLogStorage: () => ({ close() {} }) as never,
    createAppSettingsStorage: () => ({ close() {} }) as never,
    createMateStorage: () => ({ close() {} }) as never,
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

// @test-value v2
// kind = "contract"
// claim = "V2 DB の recreate は V2 schema を確保してから bundle を初期化する"
// oracle = { type = "contract", ref = "src-electron/persistent-store-lifecycle-service.ts#recreate" }
// fault = "V2 schema hook を呼ばず、空 DB を V2 storage として開く"
// observable = "ensureV2Schema の path と再初期化後の bundle"
// observation_boundary = "public-boundary"
// scope = "persistent-store-v2-recreate"
// lifecycle = "permanent"
// @end-test-value
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
      createCharacterStorage: () => createCharacterStorageStub(),
      createAuditLogStorage: () => {
        throw new Error("V2 DB では V1 audit log storage を生成しない");
      },
      createAppSettingsStorage: () => ({ close() {} }) as never,
      createMateStorage: () => ({ close() {} }) as never,
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

// @test-value v2
// kind = "contract"
// claim = "V3 DB の recreate は DB と関連 blob root を削除して再初期化する"
// oracle = { type = "contract", ref = "src-electron/persistent-store-lifecycle-service.ts#recreate" }
// fault = "V3 blob root を残したまま DB だけ再生成する"
// observable = "removedDirectories と再初期化 bundle"
// observation_boundary = "public-boundary"
// scope = "persistent-store-v3-recreate"
// lifecycle = "permanent"
// @end-test-value
test("PersistentStoreLifecycleService は V3 DB 再生成時に blob root も削除する", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "withmate-v3-recreate-"));
  const dbPath = path.join(dir, APP_DATABASE_V3_FILENAME);
  const removedDirectories: string[] = [];

  try {
    const service = new PersistentStoreLifecycleService({
      createModelCatalogStorage: () =>
        ({
          ensureSeeded: () => ({ revision: 7, providers: [] }),
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
      createCharacterStorage: () => createCharacterStorageStub(),
      createAuditLogStorage: () => ({ close() {} }) as never,
      createAppSettingsStorage: () => ({ close() {} }) as never,
      createMateStorage: () => ({ close() {} }) as never,
      ensureV3Schema(pathToDb) {
        const db = new DatabaseSync(pathToDb);
        try {
          db.exec("PRAGMA foreign_keys = ON;");
          for (const statement of CREATE_V3_SCHEMA_SQL) {
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
      async removeDirectory(directoryPath) {
        removedDirectories.push(directoryPath);
        await rm(directoryPath, { recursive: true, force: true });
      },
    });

    const bundle = await service.recreate(dbPath, "model-catalog.json", {});

    assert.equal(bundle.activeModelCatalog.revision, 7);
    assert.deepEqual(removedDirectories, [path.join(dir, "blobs", "v3")]);
    assert.equal(bundle.sessionStorage instanceof SessionStorageV3, true);
    service.close(bundle, dbPath);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// @test-value v2
// kind = "contract"
// claim = "V4 DB の recreate は blob root と Character root を削除して再初期化する"
// oracle = { type = "contract", ref = "src-electron/persistent-store-lifecycle-service.ts#recreate" }
// fault = "V4 に紐づく character data を残したまま DB を再生成する"
// observable = "removedDirectories の blob と characters path"
// observation_boundary = "public-boundary"
// scope = "persistent-store-v4-recreate"
// lifecycle = "permanent"
// @end-test-value
test("PersistentStoreLifecycleService は V4 DB 再生成時に blob root と Character root を削除する", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "withmate-v4-recreate-"));
  const dbPath = path.join(dir, APP_DATABASE_V4_FILENAME);
  const userDataPath = path.join(dir, "user-data");
  const removedDirectories: string[] = [];

  try {
    const service = new PersistentStoreLifecycleService({
      createModelCatalogStorage: () =>
        ({
          ensureSeeded: () => ({ revision: 8, providers: [] }),
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
      createCharacterStorage: () => createCharacterStorageStub(),
      createAuditLogStorage: () => ({ close() {} }) as never,
      createAppSettingsStorage: () => ({ close() {} }) as never,
      createMateStorage: () => ({ close() {} }) as never,
      onBeforeClose: () => {},
      truncateWal() {},
      async removeFile(filePath) {
        await rm(filePath, { force: true });
      },
      async removeDirectory(directoryPath) {
        removedDirectories.push(directoryPath);
        await rm(directoryPath, { recursive: true, force: true });
      },
    });

    const bundle = await service.recreate(dbPath, "model-catalog.json", {}, userDataPath);

    assert.equal(bundle.activeModelCatalog.revision, 8);
    assert.deepEqual(removedDirectories, [
      path.join(dir, "blobs", "v3"),
      path.join(userDataPath, "characters"),
    ]);
    service.close(bundle, dbPath);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "required V2 tables がない withmate-v2.db は injected V1-compatible storages を選択する"
// oracle = { type = "contract", ref = "src-electron/persistent-store-lifecycle-service.ts#initialize" }
// fault = "不完全な V2 DB に V2 storage を誤選択する"
// observable = "SessionStorageV2/AuditLogStorageV2 の非使用と injected factory の呼出し回数"
// observation_boundary = "public-boundary"
// scope = "persistent-store-v2-compatibility"
// lifecycle = "permanent"
// @end-test-value
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
      createCharacterStorage: () => createCharacterStorageStub(),
      createAuditLogStorage: () => {
        createAuditLogStorageCallCount += 1;
        return {
          close() {},
        } as never;
      },
      createAppSettingsStorage: () => ({ close() {} }) as never,
      createMateStorage: () => ({ close() {} }) as never,
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

// @test-value v2
// kind = "contract"
// claim = "有効な V2 DB の initialize は SessionStorageV2 を選択し、その session summary を読む"
// oracle = { type = "contract", ref = "src-electron/persistent-store-lifecycle-service.ts#initialize" }
// fault = "V2 DB で V1 session storage を開く、または summary を失う"
// observable = "sessionStorage の実型と bundle.sessions"
// observation_boundary = "public-boundary"
// scope = "persistent-store-v2-session-read"
// lifecycle = "permanent"
// @end-test-value
test("PersistentStoreLifecycleService は V2 DB では SessionStorageV2 を使ってセッション要約を読む", async () => {
  const activeModelCatalog = { revision: 1, providers: [] } as ModelCatalogSnapshot;

  await withTempV2Database(async (dbPath) => {
    const v1SessionStorageControl = { value: undefined as { close(): void } | undefined };

    const service = new PersistentStoreLifecycleService({
      createModelCatalogStorage: () =>
        ({
          ensureSeeded: () => activeModelCatalog,
          close() {},
        }) as never,
      createSessionStorage: () => {
        const storage = new SessionStorage(dbPath);
        v1SessionStorageControl.value = storage;
        return storage as never;
      },
      createSessionMemoryStorage: () => ({ close() {} }) as never,
      createProjectMemoryStorage: () => ({ close() {} }) as never,
      createCharacterStorage: () => createCharacterStorageStub(),
      createAuditLogStorage: () => ({ close() {} }) as never,
      createAppSettingsStorage: () => ({ close() {} }) as never,
      createMateStorage: () => ({ close() {} }) as never,
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
      v1SessionStorageControl.value?.close();
    }
  });
});

// @test-value v2
// kind = "invariant"
// claim = "有効な V2 DB の initialize は V1 write-capable session/audit factory を呼ばず V2 storages を返す"
// oracle = { type = "contract", ref = "src-electron/persistent-store-lifecycle-service.ts#initialize" }
// fault = "V2 DB に V1 writer を接続し、旧 schema へ書き込む"
// observable = "returned storage の実型と V1 factory 呼出し回数"
// observation_boundary = "public-boundary"
// scope = "persistent-store-v2-writer-boundary"
// lifecycle = "permanent"
// @end-test-value
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
      createCharacterStorage: () => createCharacterStorageStub(),
      createAuditLogStorage: () => {
        createAuditLogStorageCallCount += 1;
        return {
          close() {},
        } as never;
      },
      createAppSettingsStorage: () => ({ close() {} }) as never,
      createMateStorage: () => ({ close() {} }) as never,
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

// @test-value v2
// kind = "invariant"
// claim = "V2 DB の initialize は legacy memory storage factory を呼ばず legacy memory table を作成しない"
// oracle = { type = "contract", ref = "src-electron/persistent-store-lifecycle-service.ts#initialize" }
// fault = "V2 DB に legacy memory table を追加し、旧 storage を接続する"
// observable = "factory 呼出し回数と sqlite_master の table 一覧"
// observation_boundary = "public-boundary"
// scope = "persistent-store-v2-memory-boundary"
// lifecycle = "permanent"
// @end-test-value
test("PersistentStoreLifecycleService は V2 DB に legacy memory table を作成しない", async () => {
  const activeModelCatalog = { revision: 3, providers: [] } as ModelCatalogSnapshot;
  let createSessionMemoryStorageCallCount = 0;
  let createProjectMemoryStorageCallCount = 0;
  let createCharacterStorageCallCount = 0;

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
      createCharacterStorage: () => {
        createCharacterStorageCallCount += 1;
        return createCharacterStorageStub();
      },
      createAuditLogStorage: () => {
        throw new Error("V2 DB では V1 audit log storage を生成しない");
      },
      createAppSettingsStorage: () => ({ close() {} }) as never,
      createMateStorage: () => ({ close() {} }) as never,
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
      assert.equal(createCharacterStorageCallCount, 0);
    } finally {
      service.close(bundle, dbPath);
    }
  });
});

// @test-value v2
// kind = "invariant"
// claim = "V6 lifecycle は限定された storage Worker だけを初期化し、legacy session/audit/memory/Mate table を作成しない"
// oracle = { type = "contract", ref = "src-electron/persistent-store-lifecycle-service.ts#initialize" }
// fault = "V6起動時にMain側またはlegacy storageが同期接続し、既存V6 DBへlegacy schemaを追加する"
// observable = "一時V6 DBのWorker経由storage操作と終了後のsqlite_master table一覧"
// observation_boundary = "public-boundary"
// scope = "persistent-store-worker-lifecycle"
// lifecycle = "permanent"
// impact = "V6 DBの所有者をWorkerに限定し、既存データ形式とlegacy table不在を維持する"
// distinction = "型検査では実Workerの初期化、awaitされたproxy呼出し、SQLite schema副作用を確認できない"
// @end-test-value
test("PersistentStoreLifecycleService は V6 DB に legacy session/audit/memory/Mate table を作成しない", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "withmate-v6-lifecycle-"));
  try {
    const userDataPath = path.join(dir, "user-data");
    const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
    assert.equal(path.basename(dbPath), APP_DATABASE_V6_FILENAME);
    const bundledModelCatalogPath = path.join(dir, "model-catalog.json");
    await writeFile(
      bundledModelCatalogPath,
      JSON.stringify({
        providers: [
          {
            id: "codex",
            label: "Codex",
            defaultModelId: "gpt-5.4",
            defaultReasoningEffort: "medium",
            models: [
              {
                id: "gpt-5.4",
                label: "GPT 5.4",
                reasoningEfforts: ["medium"],
              },
            ],
          },
        ],
      }),
    );

    const service = createPersistentStoreLifecycleService();
    const bundle = await service.initialize(dbPath, bundledModelCatalogPath, userDataPath);
    try {
      const auxiliary = await bundle.auxiliarySessionStorage.upsertAuxiliarySession(createAuxiliarySessionFixture());
      assert.equal(auxiliary.id, "aux-v6");
      assert.equal((await bundle.auxiliarySessionStorage.listAuxiliarySessions("session-v6"))[0]?.id, "aux-v6");
    } finally {
      await service.close(bundle, dbPath);
    }
    const tables = readTableNames(dbPath);
    assert.equal(tables.includes("sessions_v6"), true);
    assert.equal(tables.includes("audit_events_v6"), false);
    assert.equal(tables.includes("session_turns_v6"), true);
    assert.equal(tables.includes("auxiliary_sessions"), true);
    assert.equal(tables.includes("sessions"), false);
    assert.equal(tables.includes("audit_logs"), false);
    assert.equal(tables.includes("session_memories"), false);
    assert.equal(tables.includes("project_memory_entries"), false);
    assert.equal(tables.includes("mate_profile"), false);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// @test-value v2
// kind = "contract"
// claim = "V3 DB の initialize は V3 session/audit storage と schema hook を選択し、V1 factory を呼ばない"
// oracle = { type = "contract", ref = "src-electron/persistent-store-lifecycle-service.ts#initialize" }
// fault = "V3 DB に V1 storage を接続する、または V3 schema hook を省略する"
// observable = "returned storage の実型、audit artifact、schema hook と V1 factory の呼出し回数"
// observation_boundary = "public-boundary"
// scope = "persistent-store-v3-storage-boundary"
// lifecycle = "permanent"
// @end-test-value
test("PersistentStoreLifecycleService は V3 DB では V1 storages を生成せず V3 storages を返して schema hook を呼ぶ", async () => {
  const activeModelCatalog = { revision: 6, providers: [] } as ModelCatalogSnapshot;
  let ensureV3SchemaCallCount = 0;
  let createSessionStorageCallCount = 0;
  let createAuditLogStorageCallCount = 0;
  let createSessionMemoryStorageCallCount = 0;
  let createProjectMemoryStorageCallCount = 0;
  let createCharacterStorageCallCount = 0;

  await withTempV3Database(async (dbPath) => {
    const service = new PersistentStoreLifecycleService({
      createModelCatalogStorage: () =>
        ({
          ensureSeeded: () => activeModelCatalog,
          close() {},
        }) as never,
      createSessionStorage: () => {
        createSessionStorageCallCount += 1;
        throw new Error("V3 DB では V1 session storage を生成しない");
      },
      createSessionMemoryStorage: () => {
        createSessionMemoryStorageCallCount += 1;
        return { close() {} } as never;
      },
      createProjectMemoryStorage: () => {
        createProjectMemoryStorageCallCount += 1;
        return { close() {} } as never;
      },
      createCharacterStorage: () => {
        createCharacterStorageCallCount += 1;
        return createCharacterStorageStub();
      },
      createAuditLogStorage: () => {
        createAuditLogStorageCallCount += 1;
        throw new Error("V3 DB では V1 audit log storage を生成しない");
      },
      createAppSettingsStorage: () => ({ close() {} }) as never,
      createMateStorage: () => ({ close() {} }) as never,
      ensureV3Schema(pathToDb) {
        assert.equal(pathToDb, dbPath);
        ensureV3SchemaCallCount += 1;
      },
      onBeforeClose: () => {},
      truncateWal() {},
      async removeFile() {},
    });

    const bundle = await service.initialize(dbPath, "model-catalog.json");
    try {
      assert.equal(bundle.activeModelCatalog, activeModelCatalog);
      assert.equal(bundle.sessionStorage instanceof SessionStorageV3, true);
      assert.equal(bundle.auditLogStorage instanceof AuditLogStorageV3, true);
      assert.deepEqual(bundle.sessions, []);
      insertV3SessionHeader(dbPath, "session-v3-lifecycle");
      const createdAuditLog = await (bundle.auditLogStorage as AuditLogStorageV3).createAuditLog({
        sessionId: "session-v3-lifecycle",
        createdAt: "2026-04-27T10:00:00.000Z",
        phase: "completed",
        provider: "codex",
        model: "gpt-5.4-mini",
        reasoningEffort: "medium",
        approvalMode: DEFAULT_APPROVAL_MODE,
        threadId: "thread-v3",
        logicalPrompt: {
          systemText: "system",
          inputText: "input",
          composedText: "system\ninput",
        },
        transportPayload: null,
        assistantText: "assistant",
        operations: [],
        rawItemsJson: "[]",
        usage: null,
        errorMessage: "",
      });
      const expectedBlobRoot = path.join(path.dirname(dbPath), "blobs", "v3");
      const blobEntries = await readdir(expectedBlobRoot, { recursive: true });
      assert.equal(createdAuditLog.sessionId, "session-v3-lifecycle");
      assert.equal(blobEntries.some((entry) => entry.toString().endsWith(".br")), true);
      assert.equal(ensureV3SchemaCallCount, 1);
      assert.equal(createSessionStorageCallCount, 0);
      assert.equal(createAuditLogStorageCallCount, 0);
      assert.equal(createSessionMemoryStorageCallCount, 0);
      assert.equal(createProjectMemoryStorageCallCount, 0);
      assert.equal(createCharacterStorageCallCount, 0);
    } finally {
      service.close(bundle, dbPath);
    }
  });
});

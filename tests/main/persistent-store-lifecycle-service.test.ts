import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type { Session } from "../../src-shared/session/session-state.js";
import {
  APP_DATABASE_V2_FILENAME,
  CREATE_V2_SCHEMA_SQL,
} from "../../src-electron/storage/database-schema-v2.js";
import { APP_DATABASE_V1_FILENAME } from "../../src-electron/storage/database-schema-v1.js";
import {
  APP_DATABASE_V3_FILENAME,
  CREATE_V3_SCHEMA_SQL,
} from "../../src-electron/storage/database-schema-v3.js";
import { APP_DATABASE_V4_FILENAME } from "../../src-electron/storage/database-schema-v4.js";
import { APP_DATABASE_V6_FILENAME } from "../../src-electron/storage/database-schema-v6.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/storage/app-database-v6-bootstrap.js";
import { MateStorage } from "../../src-electron/mate/mate-storage.js";
import { SessionStorage } from "../../src-electron/session/session-storage.js";
import { SessionStorageV2 } from "../../src-electron/session/session-storage-v2.js";
import { SessionStorageV3 } from "../../src-electron/session/session-storage-v3.js";
import {
  PersistentStoreLifecycleService,
  createPersistentStoreLifecycleService,
  type CharacterStorageAccess,
  type PersistentStoreBundleLike,
} from "../../src-electron/storage/persistent-store-lifecycle-service.js";

/** 終了したストア名を共有ログへ追加できるストアを作る。 */
function createClosableStore(name: string, closeCalls: string[]) {
  return {
    name,
    /** ストアの終了を記録して、呼び出しの順序を検査できるようにする。 */
    close() {
      closeCalls.push(name);
    },
  };
}

/** 終了だけを差し替え、試験対象外の Character 操作を許可しない代替ストアを作る。 */
function createCharacterStorageStub(
  onClose: () => void = () => undefined,
): CharacterStorageAccess {
  /** Character 操作がこの試験に混入した場合は直ちに失敗させる。 */
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
    refreshRuntimeSnapshot: unavailable,
    deleteCharacterRootDirectory: unavailable,
    close: onClose,
  };
}

/** 実 V2 スキーマを適用した一時 DB のパスを渡し、利用後に一時領域を片付ける。 */
async function withTempV2Database<T>(
  fn: (dbPath: string) => T | Promise<T>,
): Promise<T> {
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
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
}

/** 実 V3 スキーマを適用した一時 DB を用意し、検査後に削除する。 */
async function withTempV3Database<T>(
  fn: (dbPath: string) => T | Promise<T>,
): Promise<T> {
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
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
}

/** V2 のファイル名だが必須テーブルがない DB を作り、名前だけで形式を選ばないことを試せるようにする。 */
async function withTempEmptyV2NamedDatabase<T>(
  fn: (dbPath: string) => T | Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(
    path.join(tmpdir(), "withmate-v2-empty-lifecycle-"),
  );
  const dbPath = path.join(dir, APP_DATABASE_V2_FILENAME);
  const db = new DatabaseSync(dbPath);
  db.close();

  try {
    return await fn(dbPath);
  } finally {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
}

/** 未初期化の V4 DB とユーザーデータの一時パスを渡し、試験後に双方を片付ける。 */
async function withTempDatabaseAndUserData<T>(
  fn: (dbPath: string, userDataPath: string) => T | Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "withmate-v4-lifecycle-"));
  const dbPath = path.join(dir, "withmate-v4.db");
  const userDataPath = path.join(dir, "user-data");

  try {
    return await fn(dbPath, userDataPath);
  } finally {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
}

/** 既存の空 V1 DB とユーザーデータの一時パスを用意する。 */
async function withTempLegacyDatabase<T>(
  fn: (dbPath: string, userDataPath: string) => T | Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "withmate-v1-lifecycle-"));
  const dbPath = path.join(dir, APP_DATABASE_V1_FILENAME);
  const userDataPath = path.join(dir, "user-data");
  const db = new DatabaseSync(dbPath);
  db.close();

  try {
    return await fn(dbPath, userDataPath);
  } finally {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
}

/** DB を書き換えずテーブル名を順序固定で読み、起動前後のスキーマを比較できるようにする。 */
function readTableNames(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
  } finally {
    db.close();
  }
}

/** V6 の親に属する補助セッションを作り、他版の拒否試験では親などを上書きできるようにする。 */
function createAuxiliarySessionFixture(
  overrides: Partial<AuxiliarySession> = {},
): AuxiliarySession {
  return {
    id: "aux-v6",
    parentSessionId: "session-v6",
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
    threadId: "",
    composerDraft: "",
    messages: [],
    displayAfterMessageIndex: null,
    createdAt: "2026-07-02T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    ...overrides,
  };
}

// @test-value v2
// kind = "contract"
// claim = "initialize は model catalog と session summary を bundle に反映する"
// oracle = { type = "contract", ref = "src-electron/storage/persistent-store-lifecycle-service.ts#initialize" }
// fault = "初期化後の bundle が model catalog または session summary を失う"
// observable = "activeModelCatalog、sessions、listSessionSummaries の呼出し回数"
// observation_boundary = "public-boundary"
// scope = "persistent-store-initialize-close"
// lifecycle = "permanent"
// @end-test-value
/** 初期化時にカタログの参照と一度だけ取得したセッション要約を返し、履歴とストリームは未取得の空配列とすることを確認する。 */
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
  const activeModelCatalog = { providers: [] } as ModelCatalogSnapshot;
  let listSessionSummariesCallCount = 0;

  const service = new PersistentStoreLifecycleService({
    /** 起動時のカタログ取得と終了を記録できる代替ストアを返す。 */
    createModelCatalogStorage: () =>
      ({
        /** 初期化が保持すべきカタログの参照を返す。 */
        getCatalog: () => activeModelCatalog,
        /** カタログストアが閉じられたことを記録する。 */
        close() {
          closeCalls.push("model");
        },
      }) as never,
    /** 要約読取と全履歴読取を区別できるセッションストアを返す。 */
    createSessionStorage: () =>
      ({
        /** 全セッションの読取には要約と異なる空結果を返す。 */
        listSessions: () => [],
        /** 保存済み要約を返し、初期化による取得回数を数える。 */
        listSessionSummaries: () => {
          listSessionSummariesCallCount += 1;
          return sessionSummaries;
        },
        /** セッションストアの終了をログに残す。 */
        close() {
          closeCalls.push("session");
        },
      }) as never,
    /** Character の終了を共通ストアログに接続する。 */
    createCharacterStorage: () =>
      createCharacterStorageStub(() => closeCalls.push("character-memory")),
    /** 設定ストアの終了を同じログに接続する。 */
    createAppSettingsStorage: () =>
      createClosableStore("settings", closeCalls) as never,
    /** Mate ストアの終了を他ストアと区別して記録する。 */
    createMateStorage: () => createClosableStore("mate", closeCalls) as never,
    /** ストアを閉じる前のフックをログに含める。 */
    onBeforeClose: () => {
      closeCalls.push("before-close");
    },
    /** 初期化に実 WAL 操作が混ざらないよう終了メンテナンスを差し替える。 */
    truncateWal() {},
    /** 初期化の試験ではファイル削除を行わない。 */
    async removeFile() {},
  });

  const bundle = await service.initialize("withmate.db");

  assert.equal(bundle.activeModelCatalog, activeModelCatalog);
  assert.deepEqual(
    bundle.sessions.map((session) => ({
      id: session.id,
      taskTitle: session.taskTitle,
      messages: session.messages,
      stream: session.stream,
    })),
    [
      { id: "session-1", taskTitle: "Session 1", messages: [], stream: [] },
      { id: "session-2", taskTitle: "Session 2", messages: [], stream: [] },
    ],
  );
  assert.equal(listSessionSummariesCallCount, 1);
});

// @test-value v2
// kind = "contract"
// claim = "起動時の Mate projection 復元は mismatch を警告し、保存された profile を失わない"
// oracle = { type = "contract", ref = "src-electron/storage/persistent-store-lifecycle-service.ts#recoverActiveMateProfileProjection" }
// fault = "projection mismatch を黙って無視する、または起動時に profile を上書きする"
// observable = "復元後の Mate profile と console.warn の mismatch 内容"
// observation_boundary = "public-boundary"
// scope = "persistent-store-mate-projection"
// lifecycle = "permanent"
// @end-test-value
/** 再起動後にも保存済み Mate の表示名と有効改訂を維持し、復元後の不一致を内容付きの一件の警告として残すことを確認する。 */
test("PersistentStoreLifecycleService は起動時に Mate projection を復元し、残存 mismatch を警告ログに残す", async () => {
  await withTempDatabaseAndUserData(async (dbPath, userDataPath) => {
    const warnCalls: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
    let mateFactoryCalls = 0;
    let firstProfile: Awaited<
      ReturnType<MateStorage["getMateProfile"]>
    > | null = null;
    const service = new PersistentStoreLifecycleService({
      /** Mate の復元に無関係なカタログを実ストアから切り離す。 */
      createModelCatalogStorage: () =>
        ({
          /** 表示モデルのないカタログを返す。 */ getCatalog: () => ({
            providers: [],
          }),
          /** SQLite 接続を持たないカタログ代替を閉じる。 */ close() {},
        }) as never,
      /** セッション履歴を用意せず、Mate の起動処理だけを通す。 */
      createSessionStorage: () =>
        ({
          /** セッション全件を要求された場合は空として扱う。 */
          listSessions: () => [],
          /** 起動時に読むセッション要約は用意しない。 */
          listSessionSummaries: () => [],
          /** セッション代替には閉じるべき実接続がない。 */
          close() {},
        }) as never,
      /** 起動時の Character 操作を検出できる代替を用意する。 */
      createCharacterStorage: () => createCharacterStorageStub(),
      /** 実設定ストアを開かず終了契約だけを満たす。 */
      createAppSettingsStorage: () =>
        ({
          /** 設定ストアに実接続がないため終了時に処理しない。 */ close() {},
        }) as never,
      /** 実 Mate ストアを使い、二度目だけ復元処理から残存不一致を返す。 */
      createMateStorage: (nextDbPath, nextUserDataPath) => {
        const storage = new MateStorage(nextDbPath, nextUserDataPath);
        mateFactoryCalls += 1;
        if (mateFactoryCalls === 2) {
          storage.recoverMateProfileFilesFromActiveRevision = async () => [
            {
              sectionKey: "core",
              filePath: "mate/core.md",
              expectedHash: "expected",
              actualHash: "actual",
              expectedByteSize: 10,
              actualByteSize: 9,
              reason: "hash_mismatch",
            },
          ];
        }
        return storage;
      },
      /** 再起動の検証に追加の終了前副作用を入れない。 */
      onBeforeClose: () => {},
      /** Mate の不一致警告とは別の WAL 操作を省く。 */
      truncateWal() {},
      /** プロファイルを次の起動で読むため、終了時に試験ファイルを消さない。 */
      async removeFile() {},
    });

    try {
      const firstBundle = await service.initialize(dbPath, userDataPath);
      try {
        await firstBundle.mateStorage.createMate({ displayName: "Mika" });
        await firstBundle.mateStorage.applyProfileFiles({
          summary: "seed core",
          files: [
            {
              sectionKey: "core",
              relativePath: "mate/core.md",
              content: "# Core\n- Stable\n",
            },
          ],
        });
        firstProfile = await firstBundle.mateStorage.getMateProfile();
      } finally {
        await service.close(firstBundle, dbPath);
      }

      const secondBundle = await service.initialize(dbPath, userDataPath);
      try {
        const restoredProfile = await secondBundle.mateStorage.getMateProfile();
        assert.equal(restoredProfile?.displayName, firstProfile?.displayName);
        assert.equal(
          restoredProfile?.activeRevisionId,
          firstProfile?.activeRevisionId,
        );
        assert.equal(warnCalls.length, 1);
        assert.equal(
          warnCalls[0]?.[0],
          "Mate profile projection recovery has remaining mismatches",
        );
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
        await service.close(secondBundle, dbPath);
      }
    } finally {
      console.warn = originalWarn;
    }
  });
});

// @test-value v2
// kind = "invariant"
// claim = "V4 DB の initialize は Mate schema を作成して再利用可能にする"
// oracle = { type = "contract", ref = "src-electron/storage/persistent-store-lifecycle-service.ts#initialize" }
// fault = "V4 DB 起動で Mate schema を初期化しない"
// observable = "初期化後のMate schemaの存在とdb path"
// observation_boundary = "public-boundary"
// scope = "persistent-store-v4-schema"
// lifecycle = "permanent"
// @end-test-value
/** V4 起動で Mate のテーブルを作成し、新規プロフィールは未作成のまま、legacy の補助セッション書き込みは拒否することを確認する。 */
test("PersistentStoreLifecycleService は v4 DB 起動時に Mate schema を初期化する", async () => {
  await withTempDatabaseAndUserData(async (dbPath, userDataPath) => {
    const service = new PersistentStoreLifecycleService({
      /** Mate のスキーマ初期化とモデル保存を切り離す。 */
      createModelCatalogStorage: () =>
        ({
          /** モデルに依存しない空カタログを返す。 */
          getCatalog: () => ({ providers: [] }),
          /** カタログ代替の終了には実 DB を使わない。 */
          close() {},
        }) as never,
      /** Mate テーブルの作成をセッションストア由来の変更から切り離す。 */
      createSessionStorage: () =>
        ({
          /** 既存セッションを設けず空一覧を返す。 */
          listSessions: () => [],
          /** 初期化用のセッション要約も空とする。 */
          listSessionSummaries: () => [],
          /** 閉じる実セッション接続を持たない。 */
          close() {},
        }) as never,
      /** Character の永続化を使わず Mate スキーマを確認する。 */
      createCharacterStorage: () => createCharacterStorageStub(),
      /** 設定を保存せず終了だけできる代替を返す。 */
      createAppSettingsStorage: () =>
        ({
          /** 永続化していない設定の終了には処理が不要。 */ close() {},
        }) as never,
      /** V4 の DB とユーザーデータに実 Mate ストアを接続する。 */
      createMateStorage: (nextDbPath, nextUserDataPath) =>
        new MateStorage(nextDbPath, nextUserDataPath),
      /** スキーマ確認後の終了に追加フック処理を持ち込まない。 */
      onBeforeClose: () => {},
      /** V4 の Mate テーブル確認を WAL メンテナンスと切り離す。 */
      truncateWal() {},
      /** ディレクトリの後始末は一時 DB の fixture に任せる。 */
      async removeFile() {},
    });

    const bundle = await service.initialize(dbPath, userDataPath);

    assert.equal(bundle.mateStorage.getMateState(), "not_created");
    assert.throws(
      () =>
        bundle.auxiliarySessionStorage.upsertAuxiliarySession(
          createAuxiliarySessionFixture({ parentSessionId: "session-v4" }),
        ),
      /Auxiliary Sessions are not available in legacy databases/,
    );

    const db = new DatabaseSync(dbPath);
    try {
      const mateProfileTable = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mate_profile'",
        )
        .get();
      assert.ok(mateProfileTable);
    } finally {
      db.close();
    }

    await service.close(bundle, dbPath);
  });
});

// @test-value v2
// kind = "invariant"
// claim = "legacy DB の initialize は V4 専用の Mate schemaを追加作成しない"
// oracle = { type = "contract", ref = "src-electron/storage/persistent-store-lifecycle-service.ts#initialize" }
// fault = "legacy DB 起動時に V4 schema を追加作成する"
// observable = "初期化後にV4専用Mate schemaが存在しないこと"
// observation_boundary = "public-boundary"
// scope = "persistent-store-legacy-schema"
// lifecycle = "permanent"
// impact = "legacy DBへV4専用のMate永続化表を追加すると、既存DBのschema境界を変更し、未対応の書込みや将来のmigration判断に影響する"
// distinction = "schema sourceの静的確認では、legacy DB initialize前後のSQLite table集合が不変であることを確認できない"
// @end-test-value
/** V1 の既存 DB を起動しても Mate は利用不能を返し、テーブル一覧に V4 専用の追加を行わないことを確認する。 */
test("PersistentStoreLifecycleService は legacy DB 起動時に Mate schema を初期化しない", async () => {
  await withTempLegacyDatabase(async (dbPath, userDataPath) => {
    const service = new PersistentStoreLifecycleService({
      /** legacy スキーマをモデルストアの書き込みと切り離す。 */
      createModelCatalogStorage: () =>
        ({
          /** legacy の起動にモデル候補を必要としない。 */
          getCatalog: () => ({ providers: [] }),
          /** 実 DB を開かないカタログ代替を閉じる。 */
          close() {},
        }) as never,
      /** V1 のセッション読み出しを代替し、実表の追加を起こさない。 */
      createSessionStorage: () =>
        ({
          /** セッション全件取得の空結果を返す。 */
          listSessions: () => [],
          /** legacy 起動に必要な要約取得を空結果で満たす。 */
          listSessionSummaries: () => [],
          /** セッション代替の終了時には SQLite 接続を操作しない。 */
          close() {},
        }) as never,
      /** Character 由来の DB 変更が起きない代替を返す。 */
      createCharacterStorage: () => createCharacterStorageStub(),
      /** 設定表を作らず閉じることだけできる代替ストアを返す。 */
      createAppSettingsStorage: () =>
        ({
          /** 実設定資源がないので閉じる処理は空とする。 */ close() {},
        }) as never,
      /** V1 の DB を実 Mate ストアが未対応と判定するよう、指定されたパスをそのまま渡す。 */
      createMateStorage: (nextDbPath, nextUserDataPath) =>
        new MateStorage(nextDbPath, nextUserDataPath),
      /** テーブルの差分を確認する試験に終了前作業を加えない。 */
      onBeforeClose: () => {},
      /** スキーマ変更を観察する間は WAL 整理を行わない。 */
      truncateWal() {},
      /** テーブル比較用の DB 削除は一時領域の後始末へ委ねる。 */
      async removeFile() {},
    });

    const tableNamesBefore = readTableNames(dbPath);
    const bundle = await service.initialize(dbPath, userDataPath);
    try {
      assert.equal(bundle.mateStorage.getMateState(), "profile_unavailable");
      assert.deepEqual(readTableNames(dbPath), tableNamesBefore);
    } finally {
      await service.close(bundle, dbPath);
    }
  });
});

// @test-value v2
// kind = "invariant"
// claim = "V3 legacy DB の initialize は V4 専用の Mate schemaを追加作成しない"
// oracle = { type = "contract", ref = "src-electron/storage/persistent-store-lifecycle-service.ts#initialize" }
// fault = "V3 DB 起動時に V4 schema を追加作成する"
// observable = "初期化後にV4専用Mate schemaが存在しないこと"
// observation_boundary = "public-boundary"
// scope = "persistent-store-v3-schema"
// lifecycle = "permanent"
// impact = "V3 legacy DBへV4専用のMate永続化表を追加すると、未対応DB形式に新しい書込み境界が混入する"
// distinction = "schema sourceの静的確認では、実際のV3 DB initializeによるSQLite table副作用を確認できない"
// @end-test-value
/** 正規 V3 DB の起動でも Mate は利用不能を返し、起動前後の実テーブル集合を変えないことを確認する。 */
test("PersistentStoreLifecycleService は V3 legacy DB 起動時に Mate schema を初期化しない", async () => {
  await withTempV3Database(async (dbPath) => {
    const userDataPath = path.join(path.dirname(dbPath), "user-data");
    const service = new PersistentStoreLifecycleService({
      /** V3 の表に別のカタログ用テーブルを追加しない代替を提供する。 */
      createModelCatalogStorage: () =>
        ({
          /** V3 起動のためのモデル一覧は空とする。 */
          getCatalog: () => ({ providers: [] }),
          /** カタログ代替は DB 資源を持たず、終了時に操作しない。 */
          close() {},
        }) as never,
      /** 注入経路のセッション依存を満たしつつ追加テーブルを作らない。 */
      createSessionStorage: () =>
        ({
          /** 注入ストアには既存セッションを用意しない。 */
          listSessions: () => [],
          /** 注入ストアの要約一覧にはデータを入れない。 */
          listSessionSummaries: () => [],
          /** 注入経路でセッション用の実接続を閉じる必要はない。 */
          close() {},
        }) as never,
      /** Character 用の表を試験に持ち込まない代替を返す。 */
      createCharacterStorage: () => createCharacterStorageStub(),
      /** V3 の起動時に外部設定を持ち込まない代替を返す。 */
      createAppSettingsStorage: () =>
        ({
          /** 保存設定がないため取得の結果は null とする。 */
          get() {
            return null;
          },
          /** 設定書き込みで追加テーブルを作らない。 */
          set() {},
          /** 設定削除の呼び出しで永続化の副作用を起こさない。 */
          delete() {},
          /** 設定の列挙には空一覧を返す。 */
          listAll() {
            return [];
          },
          /** 実設定接続がないため閉じる処理は発生しない。 */
          close() {},
        }) as never,
      /** 実 Mate ストアに V3 のパスを渡して旧版の利用可否を検査する。 */
      createMateStorage: (nextDbPath, nextUserDataPath) =>
        new MateStorage(nextDbPath, nextUserDataPath),
      /** V3 のスキーマ維持を調べる終了に追加処理を行わない。 */
      onBeforeClose: () => {},
      /** WAL メンテナンスはスキーマ維持の試験範囲に含めない。 */
      truncateWal() {},
      /** V3 DB の片付けは一時 DB の fixture に任せる。 */
      async removeFile() {},
    });

    const tableNamesBefore = readTableNames(dbPath);
    const bundle = await service.initialize(dbPath, userDataPath);
    try {
      assert.equal(bundle.mateStorage.getMateState(), "profile_unavailable");
      assert.deepEqual(readTableNames(dbPath), tableNamesBefore);
    } finally {
      await service.close(bundle, dbPath);
    }
  });
});

// @test-value v2
// kind = "contract"
// claim = "V4 DB 起動時の Mate projection は active revision snapshot から復元される"
// oracle = { type = "contract", ref = "src-electron/storage/persistent-store-lifecycle-service.ts#recoverActiveMateProfileProjection" }
// fault = "active revision の profile を復元せず、古い projection を残す"
// observable = "initialize 後に読み出した Mate profile の revision と内容"
// observation_boundary = "public-boundary"
// scope = "persistent-store-v4-mate-projection"
// lifecycle = "permanent"
// @end-test-value
/** V4 の投影ファイルを停止中に書き換えても、次の起動で有効改訂の内容へ戻り、改訂 ID と検証結果が一致することを確認する。 */
test("PersistentStoreLifecycleService は v4 DB 起動時に Mate projection を active revision snapshot から復元する", async () => {
  await withTempDatabaseAndUserData(async (dbPath, userDataPath) => {
    const service = new PersistentStoreLifecycleService({
      /** Mate プロファイルの実データ以外のモデル依存を差し替える。 */
      createModelCatalogStorage: () =>
        ({
          /** 復元試験で使用しないモデル一覧は空とする。 */
          getCatalog: () => ({ providers: [] }),
          /** 実カタログ資源を持たず終了時に何もしない。 */
          close() {},
        }) as never,
      /** プロファイル以外の履歴を作らないセッション代替を返す。 */
      createSessionStorage: () =>
        ({
          /** セッション履歴のない初期状態を返す。 */
          listSessions: () => [],
          /** 既存セッションの要約を復元試験に混ぜない。 */
          listSessionSummaries: () => [],
          /** 実セッション接続を閉じる処理は不要。 */
          close() {},
        }) as never,
      /** Character の処理を Mate 投影の回復から切り離す。 */
      createCharacterStorage: () => createCharacterStorageStub(),
      /** 設定の書込みや読取をしない終了用の代替を返す。 */
      createAppSettingsStorage: () =>
        ({ /** 終了時も実設定に触れない。 */ close() {} }) as never,
      /** 復元前後で指定した DB とユーザーデータを使う実 Mate ストアを開く。 */
      createMateStorage: (nextDbPath, nextUserDataPath) =>
        new MateStorage(nextDbPath, nextUserDataPath),
      /** 再起動を跨ぐため、終了前フックで投影ファイルに変更を加えない。 */
      onBeforeClose: () => {},
      /** この復元試験では実 checkpoint を行わない。 */
      truncateWal() {},
      /** 次回起動の有効改訂を残すため、試験中はファイル削除を行わない。 */
      async removeFile() {},
    });

    const firstBundle = await service.initialize(dbPath, userDataPath);
    let firstProfile: Awaited<
      ReturnType<MateStorage["getMateProfile"]>
    > | null = null;
    try {
      await firstBundle.mateStorage.createMate({ displayName: "Mika" });
      await firstBundle.mateStorage.applyProfileFiles({
        summary: "seed core",
        files: [
          {
            sectionKey: "core",
            relativePath: "mate/core.md",
            content: "# Core\n- Stable\n",
          },
        ],
      });
      firstProfile = await firstBundle.mateStorage.getMateProfile();
      assert.ok(firstProfile?.activeRevisionId);
    } finally {
      await service.close(firstBundle, dbPath);
    }

    const corePath = path.join(userDataPath, "mate/core.md");
    await writeFile(corePath, "# Core\n- Broken\n", "utf8");

    const secondBundle = await service.initialize(dbPath, userDataPath);
    try {
      const restoredCore = await readFile(corePath, "utf8");
      const mismatches =
        await secondBundle.mateStorage.verifyMateProfileFiles();
      const restoredProfile = await secondBundle.mateStorage.getMateProfile();

      assert.equal(restoredCore, "# Core\n- Stable\n");
      assert.deepEqual(mismatches, []);
      assert.equal(
        restoredProfile?.activeRevisionId,
        firstProfile?.activeRevisionId,
      );
    } finally {
      await service.close(secondBundle, dbPath);
    }
  });
});

// @test-value v2
// kind = "contract"
// claim = "close は before-close hook の後に bundle の各 store を定義済み順で閉じる"
// oracle = { type = "contract", ref = "src-electron/storage/persistent-store-lifecycle-service.ts#close" }
// fault = "store を閉じ忘れる、または hook より先に close する"
// observable = "closeCalls の全要素と順序"
// observation_boundary = "public-boundary"
// scope = "persistent-store-close-order"
// lifecycle = "permanent"
// @end-test-value
/** 既存 bundle の終了時、事前フックから各ストアを閉じて WAL を整理するまでの全順序を確認する。 */
test("PersistentStoreLifecycleService は close 時に hook と各 store close を呼ぶ", async () => {
  const closeCalls: string[] = [];
  const service = new PersistentStoreLifecycleService({
    /** 既存 bundle の終了にはカタログを新規作成しない。 */
    createModelCatalogStorage: () => null as never,
    /** 終了対象のセッションストアは bundle から受け取るため、新規ストアは供給しない。 */
    createSessionStorage: () => null as never,
    /** 初期化用の Character 生成口を、終了対象のストアとは別に満たす。 */
    createCharacterStorage: () => createCharacterStorageStub(),
    /** 設定ストアの再初期化を含まない終了ケースにする。 */
    createAppSettingsStorage: () => null as never,
    /** Mate を新たに開かず、bundle の既存ストアだけを閉じる。 */
    createMateStorage: () => null as never,
    /** ストアを閉じるより先にフックが呼ばれたことを記録する。 */
    onBeforeClose: () => {
      closeCalls.push("before-close");
    },
    /** すべてのストアを閉じた後に WAL 操作が来たかを記録する。 */
    truncateWal: () => {
      closeCalls.push("truncate-wal");
    },
    /** 既存 bundle の終了だけなのでファイルは削除しない。 */
    async removeFile() {},
  });

  const bundle: PersistentStoreBundleLike = {
    modelCatalogStorage: createClosableStore("model", closeCalls) as never,
    sessionStorage: createClosableStore("session", closeCalls) as never,
    characterStorage: createCharacterStorageStub(() =>
      closeCalls.push("character"),
    ),
    sessionTurnStorage: createClosableStore("turn", closeCalls) as never,
    auxiliarySessionStorage: createClosableStore(
      "auxiliary",
      closeCalls,
    ) as never,
    appSettingsStorage: createClosableStore("settings", closeCalls) as never,
    mateStorage: createClosableStore("mate", closeCalls) as never,
  };

  await service.close(bundle, "withmate.db");

  assert.deepEqual(closeCalls, [
    "before-close",
    "model",
    "character",
    "session",
    "turn",
    "auxiliary",
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
/** V6 は Worker がないと Main で WAL を操作せず、Worker があるときは checkpoint 完了を待ってからその接続を閉じることを確認する。 */
test("PersistentStoreLifecycleService は V6 WAL の終了処理を Worker の所有境界内で行う", async () => {
  const calls: string[] = [];
  const service = new PersistentStoreLifecycleService({
    /** V6 終了時に初期化用のカタログを供給しない。 */
    createModelCatalogStorage: () => null as never,
    /** V6 終了時に legacy セッション接続を作らない。 */
    createSessionStorage: () => null as never,
    /** Worker の終了順だけを検査するため設定ストアを用意しない。 */
    createAppSettingsStorage: () => null as never,
    /** V6 終了に legacy Mate ストアを持ち込まない。 */
    createMateStorage: () => null as never,
    /** Worker の有無に関係なく事前フックが通ったことを記録する。 */
    onBeforeClose: () => {
      calls.push("before-close");
    },
    /** V6 で禁止される Main 側 WAL 操作が試みられた場合に検出する。 */
    truncateWal: () => {
      calls.push("main-wal");
    },
    /** Worker の終了時には DB を削除しない。 */
    async removeFile() {},
  });
  const dbPath = path.join("user-data", APP_DATABASE_V6_FILENAME);
  await service.close({ storageWorker: null }, dbPath);
  assert.deepEqual(calls, ["before-close"]);

  calls.length = 0;
  let finishCheckpoint!: () => void;
  const checkpoint = new Promise<void>((resolve) => {
    finishCheckpoint = resolve;
  });
  const closing = service.close(
    {
      storageWorker: {
        /** Worker 所有の checkpoint を保留して、完了まで接続を閉じないか観察できるようにする。 */
        async truncateWal() {
          calls.push("worker-wal");
          await checkpoint;
          calls.push("checkpoint-complete");
        },
        client: {
          /** Worker クライアントへ終了が届いた時点をログに残す。 */
          async close() {
            calls.push("worker-close");
          },
        },
      } as never,
    },
    dbPath,
  );
  try {
    assert.deepEqual(calls, ["before-close", "worker-wal"]);
  } finally {
    finishCheckpoint();
    await closing;
  }
  assert.deepEqual(calls, [
    "before-close",
    "worker-wal",
    "checkpoint-complete",
    "worker-close",
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "WAL truncate の失敗は警告に記録されるが close の呼び出し元へは伝播しない"
// oracle = { type = "contract", ref = "src-electron/storage/persistent-store-lifecycle-service.ts#close" }
// fault = "終了処理の WAL 失敗で close が例外終了する"
// observable = "awaitしたcloseの非reject（assert.doesNotReject）、before-close呼出し、console.warn の内容"
// observation_boundary = "public-boundary"
// scope = "persistent-store-wal-error"
// lifecycle = "permanent"
// @end-test-value
/** WAL の checkpoint に失敗しても終了は reject せず、事前フックと警告一件を観測できることを確認する。 */
test("PersistentStoreLifecycleService は WAL truncate 失敗を close 呼び出し元へ伝播しない", async () => {
  const closeCalls: string[] = [];
  const warnCalls: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };

  try {
    const service = new PersistentStoreLifecycleService({
      /** 空 bundle の終了にカタログストアを作らない。 */
      createModelCatalogStorage: () => null as never,
      /** checkpoint の失敗以外のセッション資源を持たない。 */
      createSessionStorage: () => null as never,
      /** 起動用依存は Character の代替で満たし、終了対象には含めない。 */
      createCharacterStorage: () => createCharacterStorageStub(),
      /** 設定を開かず、WAL 障害の経路だけを通す。 */
      createAppSettingsStorage: () => null as never,
      /** 終了時に Mate の生成を必要としない依存を供給する。 */
      createMateStorage: () => null as never,
      /** WAL エラーが起きても事前フックが実行されたか記録する。 */
      onBeforeClose: () => {
        closeCalls.push("before-close");
      },
      /** checkpoint から例外を起こし、終了処理が吸収すべき失敗を再現する。 */
      truncateWal: () => {
        throw new Error("checkpoint failed");
      },
      /** 通常終了なので再生成用のファイル削除を行わない。 */
      async removeFile() {},
    });

    await assert.doesNotReject(() => service.close({}, "withmate.db"));
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
// oracle = { type = "contract", ref = "src-electron/storage/persistent-store-lifecycle-service.ts#recreate" }
// fault = "WAL 失敗を理由に DB 再生成を中断する"
// observable = "truncateWal呼出し、active model catalog と削除された3つの path"
// observation_boundary = "public-boundary"
// scope = "persistent-store-recreate-wal-error"
// lifecycle = "permanent"
// @end-test-value
/** WAL 切り詰めに失敗しても、WAL・SHM・DB の削除要求を続けてカタログを持つ新 bundle を作ることを確認する。 */
test("PersistentStoreLifecycleService は WAL truncate 失敗後も DB 再生成へ進む", async () => {
  const removedPaths: string[] = [];
  const truncateWalCalls: string[] = [];
  const service = new PersistentStoreLifecycleService({
    /** 障害後の再初期化でカタログが取得できる代替を返す。 */
    createModelCatalogStorage: () =>
      ({
        /** 再初期化された bundle と比較する空カタログを返す。 */
        getCatalog: () => ({ providers: [] }),
        /** カタログ代替に実接続はなく、終了処理は空とする。 */
        close() {},
      }) as never,
    /** DB を開き直さず、再生成後の起動を可能にするセッション代替を返す。 */
    createSessionStorage: () =>
      ({
        /** 再生成後の全セッションは空とする。 */
        listSessions: () => [],
        /** 復旧開始時に引き継ぐ要約はない。 */
        listSessionSummaries: () => [],
        /** 実セッション資源がないため閉じる処理は行わない。 */
        close() {},
      }) as never,
    /** 再初期化の Character 操作を通常経路から切り離す。 */
    createCharacterStorage: () => createCharacterStorageStub(),
    /** WAL 障害の試験に設定用 DB 接続を追加しない。 */
    createAppSettingsStorage: () =>
      ({
        /** 新しい設定代替は実接続を保持しないため終了処理は不要。 */ close() {},
      }) as never,
    /** Mate 用の実書き込みを行わない代替を使う。 */
    createMateStorage: () =>
      ({ /** Mate 代替の終了で DB を操作しない。 */ close() {} }) as never,
    /** WAL の切り詰め失敗以前に起きる別障害を持ち込まない。 */
    onBeforeClose: () => {},
    /** checkpoint の対象を記録したうえで失敗を発生させる。 */
    truncateWal(dbPath) {
      truncateWalCalls.push(dbPath);
      throw new Error("checkpoint failed");
    },
    /** 実ファイルを消さず、WAL・SHM・DB の削除要求を観察する。 */
    async removeFile(filePath) {
      removedPaths.push(filePath);
    },
  });
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    const bundle = await service.recreate("withmate.db", {});
    assert.deepEqual(bundle.activeModelCatalog, { providers: [] });
    assert.deepEqual(truncateWalCalls, ["withmate.db"]);
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
// oracle = { type = "contract", ref = "src-electron/storage/persistent-store-lifecycle-service.ts#recreate" }
// fault = "再生成前の DB を残す、または新 bundle を初期化しない"
// observable = "truncate path、removeFile path、active model catalog"
// observation_boundary = "public-boundary"
// scope = "persistent-store-recreate"
// lifecycle = "permanent"
// @end-test-value
/** 指定した DB に checkpoint を要求し、付随ファイルから順に削除した後、新しいカタログを含む bundle を初期化することを確認する。 */
test("PersistentStoreLifecycleService は DB を再生成して再初期化する", async () => {
  const removedPaths: string[] = [];
  const truncateWalCalls: string[] = [];
  const service = new PersistentStoreLifecycleService({
    /** 再生成後に取得するモデルカタログ用の代替を提供する。 */
    createModelCatalogStorage: () =>
      ({
        /** 新しい bundle に反映されるモデル候補なしのカタログを返す。 */
        getCatalog: () => ({ providers: [] }),
        /** カタログの fixture に閉じる実接続はない。 */
        close() {},
      }) as never,
    /** 再生成直後の空 DB を模擬するセッションストアを返す。 */
    createSessionStorage: () =>
      ({
        /** 再生成直後は保存済みセッションを持たない。 */
        listSessions: () => [],
        /** 初期化用の要約取得にも空一覧を返す。 */
        listSessionSummaries: () => [],
        /** 再生成のセッション代替は資源を確保していない。 */
        close() {},
      }) as never,
    /** 新しい bundle のために Character 代替を供給する。 */
    createCharacterStorage: () => createCharacterStorageStub(),
    /** 設定 DB を開かず再初期化に必要な生成口を埋める。 */
    createAppSettingsStorage: () =>
      ({ /** 設定代替は終了しても保存を行わない。 */ close() {} }) as never,
    /** 再生成テストを Mate の実 DB から切り離す。 */
    createMateStorage: () =>
      ({ /** 実 Mate 接続を持たない代替を終了する。 */ close() {} }) as never,
    /** 削除と再初期化の順で終了前フックは追加の仕事をしない。 */
    onBeforeClose: () => {},
    /** 再生成前の checkpoint が対象とした DB を記録する。 */
    truncateWal(dbPath) {
      truncateWalCalls.push(dbPath);
    },
    /** 削除順と対象の確認に使うパスを記録する。 */
    async removeFile(filePath) {
      removedPaths.push(filePath);
    },
  });

  const bundle = await service.recreate("withmate.db", {});

  assert.deepEqual(removedPaths, [
    "withmate.db-wal",
    "withmate.db-shm",
    "withmate.db",
  ]);
  assert.deepEqual(truncateWalCalls, ["withmate.db"]);
  assert.deepEqual(bundle.activeModelCatalog, { providers: [] });
});

// @test-value v2
// kind = "contract"
// claim = "V2 DB の recreate は V2 schema を確保してから bundle を初期化する"
// oracle = { type = "contract", ref = "src-electron/storage/persistent-store-lifecycle-service.ts#recreate" }
// fault = "V2 schema hook を呼ばず、空 DB を V2 storage として開く"
// observable = "ensureV2Schema の path と再初期化後の bundle"
// observation_boundary = "public-boundary"
// scope = "persistent-store-v2-recreate"
// lifecycle = "permanent"
// @end-test-value
/** V2 を再生成すると指定パスに実スキーマが作られ、V2 ストアで空の一覧を開けることを確認する。 */
test("PersistentStoreLifecycleService は V2 DB 再生成後に V2 schema を作成して再初期化する", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "withmate-v2-recreate-"));
  const dbPath = path.join(dir, APP_DATABASE_V2_FILENAME);

  try {
    const service = new PersistentStoreLifecycleService({
      /** V2 スキーマの再作成に無関係なカタログ依存を代替する。 */
      createModelCatalogStorage: () =>
        ({
          /** 再初期化後の bundle で観察する空のカタログを返す。 */
          getCatalog: () => ({ providers: [] }),
          /** カタログ代替の終了は実 SQLite に触れない。 */
          close() {},
        }) as never,
      /** V2 の再生成が旧セッションの生成口を利用した場合は失敗させる。 */
      createSessionStorage: () => {
        throw new Error("V2 DB では V1 session storage を生成しない");
      },
      /** Character 永続化とは独立して V2 のセッションスキーマを検査する。 */
      createCharacterStorage: () => createCharacterStorageStub(),
      /** 再生成した V2 にこの代替から設定テーブルを混ぜない。 */
      createAppSettingsStorage: () =>
        ({
          /** 設定代替を閉じる際に追加 DB 操作を行わない。 */ close() {},
        }) as never,
      /** 実 Mate 初期化ではなく、V2 ストアの選択だけを試す。 */
      createMateStorage: () =>
        ({
          /** V2 の Mate 代替は終了時に何も保存しない。 */ close() {},
        }) as never,
      /** 再生成対象へ V2 の SQL を適用し、空でも正しい V2 として開けるようにする。 */
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
      /** V2 スキーマの再生成前に別のフック処理は行わない。 */
      onBeforeClose: () => {},
      /** 実ファイル再生成の検査から checkpoint の影響を除く。 */
      truncateWal() {},
      /** 指定された一時 DB の関連ファイルを、既になくても失敗せず削除する。 */
      async removeFile(filePath) {
        await rm(filePath, { force: true });
      },
    });

    const bundle = await service.recreate(dbPath, {});

    assert.deepEqual(bundle.activeModelCatalog, { providers: [] });
    assert.equal(bundle.sessionStorage instanceof SessionStorageV2, true);
    assert.deepEqual(bundle.sessions, []);
    await service.close(bundle, dbPath);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
        )
        .get();
      assert.ok(row);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "V3 DB の recreate は DB と関連 blob root を削除して再初期化する"
// oracle = { type = "contract", ref = "src-electron/storage/persistent-store-lifecycle-service.ts#recreate" }
// fault = "V3 blob root を残したまま DB だけ再生成する"
// observable = "removedDirectories と再初期化 bundle"
// observation_boundary = "public-boundary"
// scope = "persistent-store-v3-recreate"
// lifecycle = "permanent"
// @end-test-value
/** V3 再生成では DB だけでなく対応する blob root の削除を要求し、再初期化された V3 ストアを返すことを確認する。 */
test("PersistentStoreLifecycleService は V3 DB 再生成時に blob root も削除する", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "withmate-v3-recreate-"));
  const dbPath = path.join(dir, APP_DATABASE_V3_FILENAME);
  const removedDirectories: string[] = [];

  try {
    const service = new PersistentStoreLifecycleService({
      /** 再生成したスキーマの検査用にカタログストアを差し替える。 */
      createModelCatalogStorage: () =>
        ({
          /** V3 の再初期化で返ったカタログを比較するため、空の候補を供給する。 */
          getCatalog: () => ({ providers: [] }),
          /** カタログの補助接続を実 DB に作らない。 */
          close() {},
        }) as never,
      /** V3 の実ストア以外への書き込みを避けるためフォールバックを代替する。 */
      createSessionStorage: () =>
        ({
          /** フォールバックに保存済みセッションはない。 */
          listSessions: () => [],
          /** フォールバックが要求されても要約は供給しない。 */
          listSessionSummaries: () => [],
          /** フォールバックの終了には実接続を持ち込まない。 */
          close() {},
        }) as never,
      /** Character 用データを作らず V3 の blob 削除に絞る。 */
      createCharacterStorage: () => createCharacterStorageStub(),
      /** V3 の再生に設定用 DB 資源を持たない代替を渡す。 */
      createAppSettingsStorage: () =>
        ({ /** 設定代替は終了時に追加処理を行わない。 */ close() {} }) as never,
      /** V3 の blob 削除と無関係な Mate 初期化を切り離す。 */
      createMateStorage: () =>
        ({
          /** Mate の代替を閉じるときに保存先を操作しない。 */ close() {},
        }) as never,
      /** 削除後の一時 DB に V3 スキーマの SQL を適用する。 */
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
      /** 再生成前に blob へ独自の終了処理を加えない。 */
      onBeforeClose: () => {},
      /** 実 checkpoint をせず V3 の再作成を通す。 */
      truncateWal() {},
      /** 再生成対象の一時ファイルを、存在しない場合も許容して削除する。 */
      async removeFile(filePath) {
        await rm(filePath, { force: true });
      },
      /** 削除領域を記録し、指定された一時 blob root を実際に除去する。 */
      async removeDirectory(directoryPath) {
        removedDirectories.push(directoryPath);
        await rm(directoryPath, { recursive: true, force: true });
      },
    });

    const bundle = await service.recreate(dbPath, {});

    assert.deepEqual(bundle.activeModelCatalog, { providers: [] });
    assert.deepEqual(removedDirectories, [path.join(dir, "blobs", "v3")]);
    assert.equal(bundle.sessionStorage instanceof SessionStorageV3, true);
    await service.close(bundle, dbPath);
  } finally {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "V4 DB の recreate は blob root と Character root を削除して再初期化する"
// oracle = { type = "contract", ref = "src-electron/storage/persistent-store-lifecycle-service.ts#recreate" }
// fault = "V4 に紐づく character data を残したまま DB を再生成する"
// observable = "removedDirectories の blob と characters path"
// observation_boundary = "public-boundary"
// scope = "persistent-store-v4-recreate"
// lifecycle = "permanent"
// @end-test-value
/** V4 再生成では DB に対応する blob root とユーザーデータの Character root の両方を削除対象にすることを確認する。 */
test("PersistentStoreLifecycleService は V4 DB 再生成時に blob root と Character root を削除する", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "withmate-v4-recreate-"));
  const dbPath = path.join(dir, APP_DATABASE_V4_FILENAME);
  const userDataPath = path.join(dir, "user-data");
  const removedDirectories: string[] = [];

  try {
    const service = new PersistentStoreLifecycleService({
      /** V4 再生成に必要なカタログを実 DB と切り離す。 */
      createModelCatalogStorage: () =>
        ({
          /** 再作成した bundle と比較する空のカタログを返す。 */
          getCatalog: () => ({ providers: [] }),
          /** カタログ代替には閉じる SQLite 接続がない。 */
          close() {},
        }) as never,
      /** blob と Character の削除以外にセッション永続化を持ち込まない。 */
      createSessionStorage: () =>
        ({
          /** 再生成したセッション一覧は空のままにする。 */
          listSessions: () => [],
          /** 初期化時に引き継ぐセッション要約を用意しない。 */
          listSessionSummaries: () => [],
          /** 実接続を開かないセッション代替で終了処理を満たす。 */
          close() {},
        }) as never,
      /** Character root の削除を、Character 自身の保存処理とは独立して観察する。 */
      createCharacterStorage: () => createCharacterStorageStub(),
      /** 設定表を作らず終了契約だけを満たす代替を返す。 */
      createAppSettingsStorage: () =>
        ({
          /** 設定代替が閉じる際の書き込みを行わない。 */ close() {},
        }) as never,
      /** Mate ファイルの操作を再生成時の削除に追加しない。 */
      createMateStorage: () =>
        ({
          /** Mate の代替終了がユーザーデータを変更しないようにする。 */ close() {},
        }) as never,
      /** blob と Character の削除時に独自の事前フックを加えない。 */
      onBeforeClose: () => {},
      /** この例では DB 削除対象だけを確かめ、checkpoint の副作用を加えない。 */
      truncateWal() {},
      /** 指定された一時 DB の付随ファイルと本体を削除する。 */
      async removeFile(filePath) {
        await rm(filePath, { force: true });
      },
      /** 再生成処理が要求したディレクトリを記録してから、一時領域内のその対象を削除する。 */
      async removeDirectory(directoryPath) {
        removedDirectories.push(directoryPath);
        await rm(directoryPath, { recursive: true, force: true });
      },
    });

    const bundle = await service.recreate(dbPath, {}, userDataPath);

    assert.deepEqual(bundle.activeModelCatalog, { providers: [] });
    assert.deepEqual(removedDirectories, [
      path.join(dir, "blobs", "v3"),
      path.join(userDataPath, "characters"),
    ]);
    await service.close(bundle, dbPath);
  } finally {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "required V2 tables がない withmate-v2.db は injected V1-compatible storages を選択する"
// oracle = { type = "contract", ref = "src-electron/storage/persistent-store-lifecycle-service.ts#initialize" }
// fault = "不完全な V2 DB に V2 storage を誤選択する"
// observable = "SessionStorageV2 の非使用と injected factory の呼出し回数"
// observation_boundary = "public-boundary"
// scope = "persistent-store-v2-compatibility"
// lifecycle = "permanent"
// @end-test-value
/** V2 の名前でも必須表がない DB は V2 ストアで開かず、注入した V1 互換ストアを一度生成することを確認する。 */
test("PersistentStoreLifecycleService は required V2 tables がない withmate-v2.db では V1-compatible injected storages を使う", async () => {
  const activeModelCatalog = { providers: [] } as ModelCatalogSnapshot;
  let createSessionStorageCallCount = 0;

  await withTempEmptyV2NamedDatabase(async (dbPath) => {
    const service = new PersistentStoreLifecycleService({
      /** セッション形式の選択と独立してカタログの参照を提供する。 */
      createModelCatalogStorage: () =>
        ({
          /** 互換経路でも同一参照を維持するか照合できるようにする。 */
          getCatalog: () => activeModelCatalog,
          /** 互換経路のカタログ代替は閉じる実接続を持たない。 */
          close() {},
        }) as never,
      /** 不完全な DB が注入経路を選んだことを生成回数で記録する。 */
      createSessionStorage: () => {
        createSessionStorageCallCount += 1;
        return {
          /** 互換ストアでは全セッションを空として扱う。 */
          listSessions: () => [],
          /** 互換経路の初期化で使う保存要約は空とする。 */
          listSessionSummaries: () => [],
          /** 互換ストアの代替は SQLite を開かず終了できる。 */
          close() {},
        } as never;
      },
      /** V2 テーブルがない状態を保つため Character 永続化を代替する。 */
      createCharacterStorage: () => createCharacterStorageStub(),
      /** 互換経路を選んでも実設定表を書き足さない代替を返す。 */
      createAppSettingsStorage: () =>
        ({
          /** 実設定ストアを使わないため終了時には何もしない。 */ close() {},
        }) as never,
      /** ファイル名の検査を Mate ストアの実初期化から切り離す。 */
      createMateStorage: () =>
        ({ /** Mate 代替には閉じるべき資源がない。 */ close() {} }) as never,
      /** 互換ストアの選択に終了前の追加処理を持ち込まない。 */
      onBeforeClose: () => {},
      /** 不完全なスキーマの起動検査では WAL 操作を行わない。 */
      truncateWal() {},
      /** 再生成せず既存の空 DB を初期化するだけなのでファイル削除をしない。 */
      async removeFile() {},
    });

    const bundle = await service.initialize(dbPath);

    assert.equal(bundle.activeModelCatalog, activeModelCatalog);
    assert.equal(bundle.sessionStorage instanceof SessionStorageV2, false);
    assert.equal(createSessionStorageCallCount, 1);
  });
});

// @test-value v2
// kind = "contract"
// claim = "有効な V2 DB の initialize は SessionStorageV2 を選択し、その session summary を読む"
// oracle = { type = "contract", ref = "src-electron/storage/persistent-store-lifecycle-service.ts#initialize" }
// fault = "V2 DB で V1 session storage を開く、または summary を失う"
// observable = "SessionStorageV2の実型と非空 summary の session identity/content"
// observation_boundary = "public-boundary"
// scope = "persistent-store-v2-session-read"
// lifecycle = "permanent"
// @end-test-value
/** 有効な V2 では旧ストアを生成せず、実 V2 ストアが保存要約の ID・タイトル・workspace・モデルを読み、本文とストリームは空で返すことを確認する。 */
test("PersistentStoreLifecycleService は V2 DB では SessionStorageV2 を使ってセッション要約を読む", async () => {
  const activeModelCatalog = { providers: [] } as ModelCatalogSnapshot;

  await withTempV2Database(async (dbPath) => {
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(
        `
        INSERT INTO sessions (
          id,
          task_title,
          status,
          updated_at,
          provider,
          workspace_label,
          workspace_path,
          branch,
          character_id,
          character_name,
          character_icon_path,
          run_state,
          approval_mode,
          model,
          reasoning_effort,
          thread_id,
          last_active_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        "session-v2-summary",
        "V2 summary",
        "idle",
        "2026-04-27T00:00:00.000Z",
        "codex",
        "Workspace V2",
        "workspace-v2",
        "main",
        "char-v2",
        "V2",
        "",
        "idle",
        "never",
        "gpt-5.4-mini",
        "medium",
        "thread-v2",
        42,
      );
    } finally {
      db.close();
    }

    const v1SessionStorageControl = {
      value: undefined as
        | {
            /** 誤って V1 ストアを作った場合も後始末で接続を閉じられるようにする。 */ close(): void;
          }
        | undefined,
    };
    let v1SessionStorageFactoryCalls = 0;

    const service = new PersistentStoreLifecycleService({
      /** V2 要約を読むときのカタログ依存を差し替える。 */
      createModelCatalogStorage: () =>
        ({
          /** 起動に必要な空カタログを同じ参照で返す。 */
          getCatalog: () => activeModelCatalog,
          /** カタログの実接続を保持しないので終了処理は空とする。 */
          close() {},
        }) as never,
      /** 旧経路が実 V1 ストアを生成した場合に回数と接続を保持する。 */
      createSessionStorage: () => {
        v1SessionStorageFactoryCalls += 1;
        const storage = new SessionStorage(dbPath);
        v1SessionStorageControl.value = storage;
        return storage as never;
      },
      /** V2 の要約読み出しに Character のストア操作を混ぜない。 */
      createCharacterStorage: () => createCharacterStorageStub(),
      /** 要約を読む DB に実 App Settings の保存処理を加えない。 */
      createAppSettingsStorage: () =>
        ({
          /** 設定用接続を作っていないため終了時の処理も不要。 */ close() {},
        }) as never,
      /** V2 要約の検査では Mate 側の実接続を使わない。 */
      createMateStorage: () =>
        ({
          /** Mate 代替は終了時に V2 ファイルに触れない。 */ close() {},
        }) as never,
      /** V2 読取後の終了に別処理を追加しない。 */
      onBeforeClose: () => {},
      /** 読取りを終えた一時 V2 に実 checkpoint を要求しない。 */
      truncateWal() {},
      /** このケースでは既存 V2 データを再生成せず、削除は fixture の後始末で行う。 */
      async removeFile() {},
    });

    let bundle: Awaited<ReturnType<typeof service.initialize>> | null = null;
    try {
      bundle = await service.initialize(dbPath);
      assert.equal(bundle.sessionStorage instanceof SessionStorageV2, true);
      assert.deepEqual(
        bundle.sessions.map((session) => ({
          id: session.id,
          taskTitle: session.taskTitle,
          workspacePath: session.workspacePath,
          model: session.model,
          messages: session.messages,
          stream: session.stream,
        })),
        [
          {
            id: "session-v2-summary",
            taskTitle: "V2 summary",
            workspacePath: "workspace-v2",
            model: "gpt-5.4-mini",
            messages: [],
            stream: [],
          },
        ],
      );
      assert.equal(v1SessionStorageFactoryCalls, 0);
    } finally {
      if (bundle) {
        await service.close(bundle, dbPath);
      }
      v1SessionStorageControl.value?.close();
    }
  });
});

// @test-value v2
// kind = "invariant"
// claim = "有効な V2 DB の initialize は V1 Session/Character factory を呼ばず V2 storages を返す"
// oracle = { type = "contract", ref = "src-electron/storage/persistent-store-lifecycle-service.ts#initialize" }
// fault = "V2 DB に V1 writer を接続し、旧 schema へ書き込む"
// observable = "returned storage の実型と V1 Session/Character factory 呼出し回数"
// observation_boundary = "public-boundary"
// scope = "persistent-store-v2-writer-boundary"
// lifecycle = "permanent"
// @end-test-value
/** 有効な V2 の起動では V1 用 Session・Character の生成口をどちらも呼ばず、V2 の実 Session ストアを返すことを確認する。 */
test("PersistentStoreLifecycleService は V2 DB では V1 write-capable storages を生成せず V2 storages を返す", async () => {
  const activeModelCatalog = { providers: [] } as ModelCatalogSnapshot;
  let createSessionStorageCallCount = 0;
  let createCharacterStorageCallCount = 0;

  await withTempV2Database(async (dbPath) => {
    const service = new PersistentStoreLifecycleService({
      /** ストアの版選択に必要なカタログの生成だけを代替する。 */
      createModelCatalogStorage: () =>
        ({
          /** V1 の書込み経路とは別のカタログ依存を一定値で満たす。 */
          getCatalog: () => activeModelCatalog,
          /** カタログ終了に SQLite を使わず版選択の副作用を限定する。 */
          close() {},
        }) as never,
      /** 禁止された V1 セッション生成口が呼ばれた場合に回数を数える。 */
      createSessionStorage: () => {
        createSessionStorageCallCount += 1;
        return {
          /** 意図しない旧生成が発生してもデータを書かないよう空一覧を返す。 */
          listSessions: () => [],
          /** 旧ストアが誤選択された場合にも要約は空一覧として返す。 */
          listSessionSummaries: () => [],
          /** 呼ばれるべきでない旧セッション代替の終了は副作用を持たない。 */
          close() {},
        } as never;
      },
      /** 旧 Character の生成口が使われた場合に呼び出しを数える。 */
      createCharacterStorage: () => {
        createCharacterStorageCallCount += 1;
        return createCharacterStorageStub();
      },
      /** V2 書込み境界の試験で実設定の書込みをしない代替を返す。 */
      createAppSettingsStorage: () =>
        ({
          /** 設定ストアの終了処理は fixture に実装しない。 */ close() {},
        }) as never,
      /** V2 の実ストアの選択を Mate の初期化と切り離す。 */
      createMateStorage: () =>
        ({
          /** Mate 代替の終了に実データ操作を持ち込まない。 */ close() {},
        }) as never,
      /** ストア選択の試験に独自の事前終了処理は含めない。 */
      onBeforeClose: () => {},
      /** 一時 V2 の終了に実 WAL 処理を持ち込まない。 */
      truncateWal() {},
      /** V2 書込み経路の選択だけを見て、DB を再生成しない。 */
      async removeFile() {},
    });

    const bundle = await service.initialize(dbPath);
    try {
      assert.equal(bundle.sessionStorage instanceof SessionStorageV2, true);
      assert.equal(createSessionStorageCallCount, 0);
      assert.equal(createCharacterStorageCallCount, 0);
    } finally {
      await service.close(bundle, dbPath);
    }
  });
});

// @test-value v2
// kind = "invariant"
// claim = "V6 lifecycle は限定された storage Worker だけを初期化し、legacy session/audit/memory/Mate table を作成しない"
// oracle = { type = "contract", ref = "src-electron/storage/persistent-store-lifecycle-service.ts#initialize" }
// fault = "V6起動時にMain側またはlegacy storageが同期接続し、既存V6 DBへlegacy schemaを追加する"
// observable = "一時V6 DBのWorker経由storage操作と終了後のsqlite_master table一覧"
// observation_boundary = "public-boundary"
// scope = "persistent-store-worker-lifecycle"
// lifecycle = "permanent"
// impact = "V6 DBの所有者をWorkerに限定し、既存データ形式とlegacy table不在を維持する"
// distinction = "型検査では実Workerの初期化、awaitされたproxy呼出し、SQLite schema副作用を確認できない"
// @end-test-value
/** 実 V6 Worker から補助セッションを保存・列挙でき、終了後のテーブルに旧 session・audit・memory・Mate の表が増えないことを確認する。 */
test("PersistentStoreLifecycleService は V6 DB に legacy session/audit/memory/Mate table を作成しない", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "withmate-v6-lifecycle-"));
  try {
    const userDataPath = path.join(dir, "user-data");
    const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
    assert.equal(path.basename(dbPath), APP_DATABASE_V6_FILENAME);

    const service = createPersistentStoreLifecycleService();
    const bundle = await service.initialize(dbPath, userDataPath);
    try {
      const auxiliary =
        await bundle.auxiliarySessionStorage.upsertAuxiliarySession(
          createAuxiliarySessionFixture(),
        );
      assert.equal(auxiliary.id, "aux-v6");
      assert.equal(
        (
          await bundle.auxiliarySessionStorage.listAuxiliarySessions(
            "session-v6",
          )
        )[0]?.id,
        "aux-v6",
      );
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
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "V3 DB の initialize は V3 session storage と schema hook を選択し、V1 factory を呼ばない"
// oracle = { type = "contract", ref = "src-electron/storage/persistent-store-lifecycle-service.ts#initialize" }
// fault = "V3 DB に V1 storage を接続する、または V3 schema hook を省略する"
// observable = "returned storage の実型、schema hook と V1 factory の呼出し回数"
// observation_boundary = "public-boundary"
// scope = "persistent-store-v3-storage-boundary"
// lifecycle = "permanent"
// @end-test-value
/** 実 V3 ストアの選択と指定パスでのスキーマフック一回を確認し、V1 用 Session・Character の生成口は使わないことを確認する。 */
test("PersistentStoreLifecycleService は V3 DB では V1 storages を生成せず V3 storages を返して schema hook を呼ぶ", async () => {
  const activeModelCatalog = { providers: [] } as ModelCatalogSnapshot;
  let ensureV3SchemaCallCount = 0;
  let createSessionStorageCallCount = 0;
  let createCharacterStorageCallCount = 0;

  await withTempV3Database(async (dbPath) => {
    const service = new PersistentStoreLifecycleService({
      /** V3 ストアの選択と独立したカタログ代替を準備する。 */
      createModelCatalogStorage: () =>
        ({
          /** V3 bundle に引き継がれるカタログ参照を返す。 */
          getCatalog: () => activeModelCatalog,
          /** カタログの実資源を持たない fixture の終了口。 */
          close() {},
        }) as never,
      /** 禁止された V1 セッション生成が試行されたら、回数を記録して直ちに失敗させる。 */
      createSessionStorage: () => {
        createSessionStorageCallCount += 1;
        throw new Error("V3 DB では V1 session storage を生成しない");
      },
      /** 禁止された V1 Character 生成を回数に反映し、実データの操作は行わない。 */
      createCharacterStorage: () => {
        createCharacterStorageCallCount += 1;
        return createCharacterStorageStub();
      },
      /** 実設定表を増やさず、V3 のスキーマフックの検査に集中する。 */
      createAppSettingsStorage: () =>
        ({
          /** 設定用 DB のない代替は終了時に副作用を持たない。 */ close() {},
        }) as never,
      /** V3 へのストア選択を Mate の実処理と切り離す。 */
      createMateStorage: () =>
        ({
          /** 実 Mate 資源を持たないため閉じる処理を行わない。 */ close() {},
        }) as never,
      /** スキーマフックが対象 V3 パスを受け取ったことを確かめ、呼び出し回数を記録する。 */
      ensureV3Schema(pathToDb) {
        assert.equal(pathToDb, dbPath);
        ensureV3SchemaCallCount += 1;
      },
      /** V3 のストア選択に独自の終了前処理を追加しない。 */
      onBeforeClose: () => {},
      /** フック選択の試験では実 WAL の切り詰めを行わない。 */
      truncateWal() {},
      /** 初期化のみを試すため再生成用のファイル削除を発生させない。 */
      async removeFile() {},
    });

    const bundle = await service.initialize(dbPath);
    try {
      assert.equal(bundle.activeModelCatalog, activeModelCatalog);
      assert.equal(bundle.sessionStorage instanceof SessionStorageV3, true);
      assert.deepEqual(bundle.sessions, []);
      assert.equal(ensureV3SchemaCallCount, 1);
      assert.equal(createSessionStorageCallCount, 0);
      assert.equal(createCharacterStorageCallCount, 0);
    } finally {
      await service.close(bundle, dbPath);
    }
  });
});

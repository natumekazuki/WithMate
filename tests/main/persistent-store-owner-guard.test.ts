import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import {
  buildNewSession,
  type Session,
} from "../../src-shared/session/session-state.js";
import { SessionPersistenceService } from "../../src-electron/session/session-persistence-service.js";
import {
  assertPersistentStoreOwnerActive,
  capturePersistentStoreOwner,
} from "../../src-electron/storage/persistent-store-owner-guard.js";

/** ストア更新と表示用キャッシュを照合するため、指定 ID を持つ Codex セッションを作る。 */
function createSession(id: string): Session {
  return buildNewSession({
    id,
    taskTitle: id,
    workspaceLabel: id,
    workspacePath: `C:\\${id}`,
    branch: "main",
    characterId: "character:test",
    character: "Test",
    characterIconPath: "",
    characterThemeColors: { main: "#111111", sub: "#222222" },
    approvalMode: DEFAULT_APPROVAL_MODE,
    provider: "codex",
    messages: undefined,
  } as never);
}

/** 永続ストアの所有者が交代した後の更新の扱いを検証する。 */
describe("persistent store owner guard", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "永続storeのowner切替後に、旧Session mutation queueの遅延応答が新storageまたは新cacheへ反映されない"
  // oracle = { type = "contract", ref = "docs/design/database-schema.md#storage-overview" }
  // fault = "旧ownerのstorage応答後に新ownerのcacheへSessionを投影する"
  // observable = "旧storageのwrite数、新storageのwrite数、cacheのSession一覧、mutation promiseの拒否"
  // observation_boundary = "public-boundary"
  // scope = "session-persistence-generation-boundary"
  // lifecycle = "permanent"
  // impact = "DB reset/recreate中の遅延writeによる新generationデータ汚染と表示不整合を防ぐ"
  // distinction = "通常のSessionPersistenceService testではowner切替後の旧queueとlate acknowledgementを観測しない"
  // @end-test-value
  /** 旧ストアへの保存と次の更新を保留したまま所有者を替えると、両方が拒否され、旧応答も新ストアやキャッシュへ反映されない。 */
  it("rejects late old-owner acknowledgements without projecting into the new owner", async () => {
    const oldOwner = { id: "old" };
    const newOwner = { id: "new" };
    let activeOwner: typeof oldOwner | typeof newOwner | null = oldOwner;
    const captured = capturePersistentStoreOwner(
      () => activeOwner,
      "Session persistence test",
    );
    const session = createSession("session-old");
    let cachedSessions = [session];
    let oldWrites = 0;
    let newWrites = 0;
    let storageStarted!: () => void;
    const storageStartedPromise = new Promise<void>((resolve) => {
      storageStarted = resolve;
    });
    let releaseStorage!: (stored: Session) => void;
    const storageResponse = new Promise<Session>((resolve) => {
      releaseStorage = resolve;
    });

    const persistence = new SessionPersistenceService({
      /** キャッシュ参照が開始時の所有者に属する場合だけ一覧を返す。 */
      getSessions: () => {
        captured.assertActive("test cache read");
        return cachedSessions;
      },
      /** 有効な所有者によるキャッシュ更新だけを記録する。 */
      setSessions: (nextSessions) => {
        captured.assertActive("test cache write");
        cachedSessions = nextSessions;
      },
      /** 既存セッションを ID で検出し、未登録のセッションは見つからない状態を返す。 */
      getSession: (sessionId) =>
        cachedSessions.find((entry) => entry.id === sessionId) ?? null,
      /** 実行中のターンによる更新制限は発生しない条件にする。 */
      isSessionRunInFlight: () => false,
      /** 世代ごとの書き込みを数え、保存応答を外部から解放した時点でも所有者を確認する。 */
      upsertStoredSession: async (nextSession) => {
        captured.assertActive("test storage write");
        if (activeOwner === oldOwner) oldWrites += 1;
        else newWrites += 1;
        storageStarted();
        const stored = await storageResponse;
        captured.assertActive("test storage acknowledgement");
        return stored;
      },
      /** 全件置換を行わず、単一セッションの更新経路に限定する。 */
      replaceStoredSessions: () => undefined,
      /** 追加の保存レコードがない状態を返す。 */
      listStoredSessions: () => [],
      /** 更新を妨げる設定値を与えない。 */
      getAppSettings: () => ({}) as never,
      /** 候補のないモデルカタログを返し、保存の比較からモデル選択を外す。 */
      getModelCatalogSnapshot: () => ({ revision: 1, providers: [] }),

      /** この更新テストではテレメトリを保存しない。 */
      clearSessionContextTelemetry: () => undefined,

      /** プロバイダーのスレッド管理を実行せず、ストアの世代交代に検証を絞る。 */
      invalidateProviderSessionThread: () => undefined,
      /** 実ウィンドウを持たないため、閉じる処理を実行しない。 */
      closeSessionWindow: () => undefined,
      /** 表示通知の配信先を持たず、キャッシュの実値を直接比較する。 */
      broadcastSessions: () => undefined,
    });

    const first = persistence.upsertSession({
      ...session,
      messages: [{ role: "user", text: "old" }],
    });
    await storageStartedPromise;
    const second = persistence.upsertSession({
      ...session,
      id: "session-queued",
      messages: [{ role: "user", text: "queued" }],
    });
    activeOwner = newOwner;
    releaseStorage({ ...session, messages: [{ role: "user", text: "late" }] });

    await assert.rejects(first, /古い永続store世代/);
    await assert.rejects(second, /古い永続store世代/);
    assert.equal(oldWrites, 1);
    assert.equal(newWrites, 0);
    assert.deepEqual(cachedSessions, [session]);
    assertPersistentStoreOwnerActive(
      () => activeOwner,
      newOwner,
      "new owner remains active",
    );
  });
});

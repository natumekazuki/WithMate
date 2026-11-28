import assert from "node:assert/strict";
import { it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import {
  buildNewSession,
  projectSessionSummary,
  type Session,
} from "../../src-shared/session/session-state.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { SessionPersistenceService } from "../../src-electron/session/session-persistence-service.js";

/** 通常の Session を土台に、開始・クリア前後の差分だけを上書きできるようにする。 */
function createSession(overrides?: Partial<Session>): Session {
  return {
    ...buildNewSession({
      taskTitle: "Persistence Test",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "char-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
    }),
    ...overrides,
  };
}

// @test-value v2
// kind = "invariant"
// claim = "authoring snapshotのnull入力をstorageへ保持して渡し、canonical resultをfull runtime、summary cache、broadcastへ反映する"
// oracle = { type = "contract", ref = "running-turn-start-persistence#5,#8,#10" }
// fault = "nullをundefinedへ変換してsnapshot clearを失うか、commit後にstaleなpin、title、snapshotをcacheへ戻す"
// observable = "storage引数のnull snapshotとmessage数、返却Sessionのsnapshot/title/pin/thread/messages、cacheとbroadcast対象ID"
// observation_boundary = "component-behavior"
// scope = "SessionPersistenceService.persistRunningTurnStart"
// lifecycle = "permanent"
// distinction = "storage atomicityではなく三状態DTOのnull伝播とcommit後のcanonical result合成を観測する"
// @end-test-value
/** 開始時の明示 null を専用ストレージへ渡し、確定結果の同時更新済みタイトルと pin を戻り値・キャッシュに反映したうえで対象 ID だけを通知する。 */
it("authoring snapshotのnull入力を保持し、canonical resultをcacheへ反映してbroadcastする", async () => {
  const oldSnapshot = {
    characterId: "char-a",
    name: "Old",
    description: "",
    iconFilePath: "",
    theme: { main: "#111111", sub: "#222222" },
    definitionMarkdown: "# Old",
    definitionSha256: "old",
    definitionByteSize: 5,
    snapshotAt: "old",
  };
  const initial = createSession({
    id: "running-start-projection",
    taskTitle: "Stale title",
    isPinned: false,
    sessionKind: "character-authoring",
    characterRuntimeSnapshot: oldSnapshot,
    threadId: "thread-old",
    messages: [{ role: "assistant", text: "existing" }],
  });
  const running = createSession({
    ...initial,
    status: "running",
    runState: "running",
    updatedAt: "2026-08-30T00:01:00.000Z",
    characterRuntimeSnapshot: null,
    threadId: "",
    messages: [...initial.messages, { role: "user", text: "new prompt" }],
  });
  let cachedSessions = [initial];
  const broadcasts: string[][] = [];
  let genericUpsertCalled = false;
  const service = new SessionPersistenceService({
    /** 現在の summary の配列を返す。 */
    getSessions: () => cachedSessions,
    /** 開始結果から作り直された summary を読み出せるよう保持する。 */
    setSessions: (next) => {
      cachedSessions = next;
    },
    /** メモリ上の Session を ID で特定する。 */
    getSession: (sessionId) =>
      cachedSessions.find((session) => session.id === sessionId) ?? null,
    /** 開始済みの実行が存在する前提を設定する。 */
    isSessionRunInFlight: () => true,
    /** 全体保存への誤った分岐をフラグで検出する。 */
    upsertStoredSession: (next) => {
      genericUpsertCalled = true;
      return next;
    },
    /** 入力メッセージと明示 null を照合し、永続側で同時に変わったタイトルと pin を返す。 */
    appendStoredRunningTurnStart(input) {
      assert.equal(input.expectedMessageCount, 1);
      assert.deepEqual(input.userMessage, { role: "user", text: "new prompt" });
      assert.equal(input.characterRuntimeSnapshot, null);
      return {
        summary: {
          ...projectSessionSummary(running),
          taskTitle: "Concurrent title",
          isPinned: true,
        },
        characterRuntimeSnapshot: running.characterRuntimeSnapshot,
      };
    },
    /** 対象外の一括置換は副作用を起こさない。 */
    replaceStoredSessions: () => undefined,
    /** 開始前の永続 Session を一覧として返す。 */
    listStoredSessions: () => [initial],
    /** 開始パスの設定参照に既定値を供給する。 */
    getAppSettings: () => normalizeAppSettings({}),
    /** 設定検証に不要な Provider 候補を増やさない。 */
    getModelCatalogSnapshot: () => ({ revision: 1, providers: [] }),

    /** この開始テストではテレメトリを持たない。 */
    clearSessionContextTelemetry: () => undefined,

    /** 実 Provider のスレッドにはアクセスしない。 */
    invalidateProviderSessionThread: () => undefined,
    /** ウィンドウの生存状態は開始テストの観測対象外とする。 */
    closeSessionWindow: () => undefined,
    /** 開始の確定後に通知された Session ID を控える。 */
    broadcastSessions: (sessionIds) =>
      broadcasts.push(Array.from(sessionIds ?? [])),
  });

  const stored = await service.persistRunningTurnStart(running, 1);

  assert.equal(genericUpsertCalled, false);
  assert.equal(stored.taskTitle, "Concurrent title");
  assert.equal(stored.isPinned, true);
  assert.equal(stored.characterRuntimeSnapshot, null);
  assert.equal(stored.threadId, "");
  assert.deepEqual(stored.messages, running.messages);
  assert.equal(cachedSessions[0]?.taskTitle, "Concurrent title");
  assert.equal(cachedSessions[0]?.isPinned, true);
  assert.equal(cachedSessions[0]?.runState, "running");
  assert.deepEqual(cachedSessions[0]?.messages, []);
  assert.deepEqual(broadcasts, [[initial.id]]);
});

// @test-value v2
// kind = "invariant"
// claim = "Character authoring runtime clearは専用storage resultからfull runtimeとsummary cacheを構築し、generic upsertやrunning開始保存を使わない"
// oracle = { type = "adr", ref = "ADR-010#Authoring-snapshot-lifecycle" }
// fault = "validation前clearがfull-session rewriteに退行するか、commit後のcacheに古いsnapshotまたはthreadを残す"
// observable = "generic/running-start callback未実行、返却Sessionのsnapshot/thread/messages/runState、cacheとbroadcast対象ID"
// observation_boundary = "component-behavior"
// scope = "SessionPersistenceService.clearCharacterAuthoringRuntimeState"
// lifecycle = "permanent"
// distinction = "running開始のnull伝播ではなく、messageを所有しない専用metadata clearのcanonical projectionを観測する"
// @end-test-value
/** Authoring の clear は専用保存だけで snapshot と thread を消し、既存履歴を保った戻り値と summary キャッシュを作り、対象だけを通知する。 */
it("authoring runtime clearは専用storageだけを使いcanonical resultをcacheへ反映する", async () => {
  const oldSnapshot = {
    characterId: "char-a",
    name: "Old",
    description: "",
    iconFilePath: "old.png",
    theme: { main: "#111111", sub: "#222222" },
    definitionMarkdown: "# Old",
    definitionSha256: "old",
    definitionByteSize: 5,
    snapshotAt: "old",
  };
  const initial = createSession({
    id: "authoring-runtime-clear-projection",
    sessionKind: "character-authoring",
    characterRuntimeSnapshot: oldSnapshot,
    threadId: "thread-old",
    messages: [{ role: "assistant", text: "existing" }],
  });
  const resolved = { ...initial, characterRuntimeSnapshot: null, threadId: "" };
  let cachedSessions = [initial];
  const broadcasts: string[][] = [];
  let genericUpsertCalled = false;
  let runningStartCalled = false;
  const service = new SessionPersistenceService({
    /** クリア前の状態または直近の投影を取り出す。 */
    getSessions: () => cachedSessions,
    /** クリア後の summary を assertion から観測可能にする。 */
    setSessions: (next) => {
      cachedSessions = next;
    },
    /** 既存の Authoring Session を ID で解決する。 */
    getSession: (sessionId) =>
      cachedSessions.find((session) => session.id === sessionId) ?? null,
    /** 実行前に行うクリアなので実行中の turn はない。 */
    isSessionRunInFlight: () => false,
    /** 専用クリアが Session 全体の保存へ退行した場合を記録する。 */
    upsertStoredSession: (next) => {
      genericUpsertCalled = true;
      return next;
    },
    /** クリア中に新規メッセージ保存を呼んだ場合は直ちに失敗させる。 */
    appendStoredRunningTurnStart: () => {
      runningStartCalled = true;
      throw new Error("running start must not run");
    },
    /** 対象 ID を検査し、永続層が返す確定済みの空 thread と null snapshot を再現する。 */
    clearStoredCharacterAuthoringRuntimeState(input) {
      assert.equal(input.sessionId, initial.id);
      return {
        summary: {
          ...projectSessionSummary(initial),
          threadId: "",
        },
        characterRuntimeSnapshot: null,
      };
    },
    /** クリアと無関係な一括置換には永続効果を持たせない。 */
    replaceStoredSessions: () => undefined,
    /** リセット前の DB 側 Session を固定値で返す。 */
    listStoredSessions: () => [initial],
    /** アプリ設定に依存しないケースとして既定設定を返す。 */
    getAppSettings: () => normalizeAppSettings({}),
    /** Model 解決に影響する候補を投入しない。 */
    getModelCatalogSnapshot: () => ({ revision: 1, providers: [] }),

    /** コンテキストの実テレメトリは用意しない。 */
    clearSessionContextTelemetry: () => undefined,

    /** 実行前クリアのダブルでは Provider への接続を省く。 */
    invalidateProviderSessionThread: () => undefined,
    /** Authoring ウィンドウを実際には閉じない。 */
    closeSessionWindow: () => undefined,
    /** クリアの通知対象を保存して対象外 Session の混入を検出する。 */
    broadcastSessions: (sessionIds) =>
      broadcasts.push(Array.from(sessionIds ?? [])),
  });

  const stored = await service.clearCharacterAuthoringRuntimeState(resolved);

  assert.equal(genericUpsertCalled, false);
  assert.equal(runningStartCalled, false);
  assert.equal(stored.characterRuntimeSnapshot, null);
  assert.equal(stored.threadId, "");
  assert.deepEqual(stored.messages, initial.messages);
  assert.equal(stored.runState, "idle");
  assert.equal(cachedSessions[0]?.characterRuntimeSnapshot, null);
  assert.equal(cachedSessions[0]?.threadId, "");
  assert.deepEqual(cachedSessions[0]?.messages, []);
  assert.deepEqual(broadcasts, [[initial.id]]);
});

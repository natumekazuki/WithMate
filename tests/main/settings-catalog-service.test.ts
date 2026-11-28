import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { Session } from "../../src-shared/session/session-state.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import {
  createDefaultAppSettings,
  type AppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import { getSessionIncarnationId } from "../../src-shared/session/session-state.js";
import type { SessionThreadPatchInput } from "../../src-electron/session/session-storage-v6.js";
import type { AuxiliarySessionThreadPatchInput } from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import { AppSettingsStorage } from "../../src-electron/app/app-settings-storage.js";
import { SettingsCatalogService as SettingsCatalogServiceImpl } from "../../src-electron/settings/settings-catalog-service.js";
import type { SettingsCatalogServiceDeps } from "../../src-electron/settings/settings-catalog-service.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/providers/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import { runWithRuntimeTurnAdmission } from "../../src-electron/platform/agent-runtime/runtime-turn-admission.js";

/** 設定サービスの本番依存型を、フィクスチャの組み立てにも使う。 */
type SettingsCatalogDeps = SettingsCatalogServiceDeps;
/** 個別ケースで上書きできる既定依存のキーを列挙する。 */
type DefaultedSettingsCatalogDependency =
  | "updateChatLayoutPreference"
  | "runProviderRuntimeOperationExclusive"
  | "listSessionCredentialThreads"
  | "listAuxiliaryCredentialThreads"
  | "updateSessionThreadIfMatches"
  | "updateAuxiliarySessionThreadIfMatches"
  | "replaceAllSessions"
  | "resetAppSettings"
  | "resetSessionRuntime"
  | "clearAllProviderQuotaTelemetry"
  | "clearAllSessionContextTelemetry"
  | "invalidateAllProviderSessionThreads"
  | "closeResetTargetWindows"
  | "dismissSessionTurnNotification"
  | "recreateDatabaseFile";
/** 必須の本番依存に加え、既定で補える依存だけ省略できる。 */
type SettingsCatalogTestDeps = Omit<
  SettingsCatalogDeps,
  DefaultedSettingsCatalogDependency
> &
  Partial<Pick<SettingsCatalogDeps, DefaultedSettingsCatalogDependency>>;

const defaultSettingsCatalogDependencies: Pick<
  SettingsCatalogDeps,
  DefaultedSettingsCatalogDependency
> = {
  /** 表示チェックポイントを扱わないケースでは追加の保存を行わない。 */
  updateChatLayoutPreference() {},
  /** 本物の実行バリアを指定しないケースでは操作を直接実行する。 */
  runProviderRuntimeOperationExclusive: async (operation) => await operation(),
  /** Main の認証情報参照を提供していない場合の予期せぬ問い合わせを拒否する。 */
  listSessionCredentialThreads: async () => {
    throw new Error("unexpected listSessionCredentialThreads");
  },
  /** Auxiliary の認証情報参照を提供していない場合の問い合わせを拒否する。 */
  listAuxiliaryCredentialThreads: async () => {
    throw new Error("unexpected listAuxiliaryCredentialThreads");
  },
  /** Main のスレッド更新を用意していないケースで使われたら失敗する。 */
  updateSessionThreadIfMatches: async () => {
    throw new Error("unexpected updateSessionThreadIfMatches");
  },
  /** Auxiliary のスレッド更新が暗黙に行われた場合を検出する。 */
  updateAuxiliarySessionThreadIfMatches: async () => {
    throw new Error("unexpected updateAuxiliarySessionThreadIfMatches");
  },
  /** 部分更新が意図せず全セッション置換に変わった場合を検出する。 */
  replaceAllSessions: async () => {
    throw new Error("unexpected replaceAllSessions");
  },
  /** 設定初期化を検証しないケースからの初期化を拒否する。 */
  resetAppSettings: async () => {
    throw new Error("unexpected resetAppSettings");
  },
  /** 実行基盤の初期化が必要なケースで明示の代替実装を要求する。 */
  resetSessionRuntime: () => {
    throw new Error("unexpected resetSessionRuntime");
  },
  /** 全プロバイダーの使用量消去を想定外の副作用として検出する。 */
  clearAllProviderQuotaTelemetry: () => {
    throw new Error("unexpected clearAllProviderQuotaTelemetry");
  },
  /** 全セッションのコンテキスト消去を想定外の副作用として検出する。 */
  clearAllSessionContextTelemetry: () => {
    throw new Error("unexpected clearAllSessionContextTelemetry");
  },
  /** スレッドの全消去を行うケースだけ明示実装を要求する。 */
  invalidateAllProviderSessionThreads: async () => {
    throw new Error("unexpected invalidateAllProviderSessionThreads");
  },
  /** 対象ウィンドウの閉鎖を想定外のケースでは拒否する。 */
  closeResetTargetWindows: () => {
    throw new Error("unexpected closeResetTargetWindows");
  },
  /** ターン通知を閉じる検証では観測用の依存を要求する。 */
  dismissSessionTurnNotification: () => {
    throw new Error("unexpected dismissSessionTurnNotification");
  },
  /** DB 再作成が必要なケースで明示の代替実装を要求する。 */
  recreateDatabaseFile: async () => {
    throw new Error("unexpected recreateDatabaseFile");
  },
};

/** 既定依存を補い、認証情報の照会と条件付きスレッド更新を簡易ストアで試せるようにする。 */
class SettingsCatalogService extends SettingsCatalogServiceImpl {
  /** 個別ケースの依存を優先し、未指定のスレッド照会・更新をセッション一覧から組み立てる。 */
  constructor(deps: SettingsCatalogTestDeps) {
    const completeDeps: SettingsCatalogDeps = {
      ...defaultSettingsCatalogDependencies,
      ...deps,
      listSessionCredentialThreads:
        deps.listSessionCredentialThreads ??
        (async () =>
          (await deps.listSessions()).map((session) => ({
            id: session.id,
            incarnationId: getSessionIncarnationId(session),
            provider: session.provider,
            threadId: session.threadId,
            status: session.status,
            runState: session.runState,
          }))),
      listAuxiliaryCredentialThreads:
        deps.listAuxiliaryCredentialThreads ??
        (async () =>
          (await deps.listAuxiliarySessions()).map((session) => ({
            id: session.id,
            parentSessionId: session.parentSessionId,
            createdAt: session.createdAt,
            provider: session.provider,
            threadId: session.threadId,
            runState: session.runState,
          }))),
      updateSessionThreadIfMatches:
        deps.updateSessionThreadIfMatches ??
        (async (input: SessionThreadPatchInput) => {
          const sessions = await deps.listSessions();
          const target = sessions.find(
            (session) =>
              session.id === input.sessionId &&
              getSessionIncarnationId(session) === input.incarnationId &&
              session.provider === input.provider &&
              session.threadId === input.expectedThreadId,
          );
          if (!target) return null;
          const next = {
            ...target,
            threadId: input.nextThreadId,
            updatedAt: input.updatedAt,
          };
          if (deps.replaceAllSessions) {
            const replaced = await deps.replaceAllSessions(
              sessions.map((session) =>
                session.id === next.id ? next : session,
              ),
              { broadcast: false },
            );
            return replaced.find((session) => session.id === next.id) ?? next;
          }
          Object.assign(target, next);
          return next;
        }),
      updateAuxiliarySessionThreadIfMatches:
        deps.updateAuxiliarySessionThreadIfMatches ??
        (async (input: AuxiliarySessionThreadPatchInput) => {
          const sessions = await deps.listAuxiliarySessions();
          const target = sessions.find(
            (session) =>
              session.id === input.auxiliarySessionId &&
              session.parentSessionId === input.parentSessionId &&
              session.provider === input.provider &&
              session.threadId === input.expectedThreadId &&
              (input.createdAt === undefined ||
                session.createdAt === input.createdAt),
          );
          if (!target) return null;
          const next = {
            ...target,
            threadId: input.nextThreadId,
            updatedAt: input.updatedAt,
          };

          Object.assign(target, next);
          return next;
        }),
    };
    super(completeDeps);
  }
}

/** 並行処理の待機点をテスト側から開放するための Promise を返す。 */
function createDeferred(): {
  promise: Promise<void>;
  /** 待機中の処理を引数なしで再開する。 */
  resolve(): void;
} {
  /** 待機点を開放する Promise の解決関数を捕捉する。 */
  let resolve: () => void = () => {};
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

/** 既存スレッドと本文を持つ停止中の Codex Main を組み立てる。 */
function createSession(overrides?: Partial<Session>): Session {
  return {
    id: "session-1",
    provider: "codex",
    catalogRevision: 1,
    model: "gpt-5.4",
    reasoningEffort: "high",
    taskTitle: "task",
    workspaceLabel: "workspace",
    workspacePath: "C:/workspace",
    branch: "main",
    characterId: "char",
    character: "A",
    characterIconPath: "",
    characterThemeColors: { main: "#000", sub: "#111" },
    isPinned: false,
    sessionKind: "default",
    accessMode: "active",
    sourceSchemaVersion: 5,
    characterRuntimeSnapshot: null,
    approvalMode: "on-request",
    codexSandboxMode: "workspace-write",
    codexSpeed: "standard",
    codexReviewer: "user",
    customAgentName: "",
    status: "idle",
    runState: "idle",
    threadId: "thread-1",
    updatedAt: "2026-03-28T00:00:00.000Z",
    messages: [{ role: "user", text: "hello" }],
    stream: [],
    allowedAdditionalDirectories: [],
    ...overrides,
  };
}

/** 親に所属し独自のスレッドと結果を持つ停止中の Auxiliary を組み立てる。 */
function createAuxiliarySession(
  overrides?: Partial<AuxiliarySession>,
): AuxiliarySession {
  return {
    id: "aux-1",
    parentSessionId: "session-1",
    runState: "idle",
    title: "Auxiliary",
    provider: "codex",
    catalogRevision: 1,
    model: "gpt-5.4",
    reasoningEffort: "high",
    approvalMode: "on-request",
    codexSandboxMode: "workspace-write",
    codexSpeed: "standard",
    codexReviewer: "user",
    customAgentName: "",
    threadId: "aux-thread-1",
    composerDraft: "",
    messages: [{ role: "assistant", text: "aux result" }],
    displayAfterMessageIndex: 0,
    createdAt: "2026-03-28T00:00:00.000Z",
    updatedAt: "2026-03-28T00:00:00.000Z",
    ...overrides,
  };
}

/** 対象の Codex と非対象の Copilot を比較できるモデル一覧を作る。 */
function createCatalogSnapshot(): ModelCatalogSnapshot {
  return {
    providers: [
      {
        id: "codex",
        label: "Codex",
        defaultModelId: "gpt-5.4",
        defaultReasoningEffort: "high",
        models: [
          {
            id: "gpt-5.4",
            label: "GPT-5.4",
            reasoningEfforts: ["medium", "high"],
          },
          {
            id: "gpt-5.4-mini",
            label: "GPT-5.4 Mini",
            reasoningEfforts: ["low", "medium"],
          },
        ],
      },
      {
        id: "copilot",
        label: "Copilot",
        defaultModelId: "gpt-5",
        defaultReasoningEffort: "medium",
        models: [
          { id: "gpt-5", label: "GPT-5", reasoningEfforts: ["low", "medium"] },
        ],
      },
    ],
  };
}

/** 設定と表示選択の保存、認証変更時のスレッド処理、DB リセットの実行順を検証する。 */
describe("SettingsCatalogService", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "任意のchat layout checkpointが保留・失敗しDB読込応答が遅れても、再読込・Settings保存は現在の表示選択を返す"
  // oracle = { type = "contract", ref = "docs/design/electron-session-store.md#settingscatalogservice" }
  // fault = "再open時やSettings保存結果がDBの旧layoutへ戻る、またはcheckpoint失敗を診断できない"
  // observable = "serviceのsettings projection、broadcast、DB値、失敗診断"
  // observation_boundary = "public-boundary"
  // scope = "settings-catalog-chat-layout-current"
  // lifecycle = "permanent"
  // impact = "保存失敗によって利用者が選択した表示が同一アプリ内の再表示で失われる"
  // distinction = "Renderer局所stateとSQLite単体testでは検出できないMainの現在値projectionを確認する"
  // @end-test-value
  /** 表示のチェックポイントが未保存・失敗中でも設定の再読込と変更通知は現在選択を返し、古い読込応答で新しい選択を巻き戻さない。 */
  it("chat layout checkpoint が失敗しても再読込とSettings保存は現在値を維持する", async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "withmate-layout-current-"),
    );
    const storage = new AppSettingsStorage(
      path.join(tempDirectory, "withmate.db"),
    );
    const writeStarted = createDeferred();
    const rejectWrite = createDeferred();
    const diagnosticReceived = createDeferred();
    const allowRetryWrite = createDeferred();
    const secondWriteCompleted = createDeferred();
    const allowFinalWrite = createDeferred();
    const finalWriteCompleted = createDeferred();
    const delayedReadStarted = createDeferred();
    const releaseDelayedRead = createDeferred();
    const newerWriteCompleted = createDeferred();
    const diagnostics: string[] = [];
    const broadcasts: AppSettings[] = [];
    let writeAttempt = 0;
    let delayNextRead = false;
    try {
      const service = new SettingsCatalogService({
        /** 全体の実行状態による設定更新の制限を外す。 */
        hasInFlightSessionRuns: () => false,
        /** 個別のセッションに実行中のターンを持たせない。 */
        isSessionRunInFlight: () => false,
        /** 実行中のセッションを検出しない状態でレイアウトを変更する。 */
        isRunningSession: () => false,
        /** レイアウトと設定だけのテストに Main を用意しない。 */
        listSessions: () => [],
        /** 設定保存の試行に Auxiliary を含めない。 */
        listAuxiliarySessions: () => [],
        /** SQLite の読み取り結果を保持し、指定時は古い結果の返却を一時停止する。 */
        async getAppSettings() {
          const snapshot = storage.getSettings();
          if (delayNextRead) {
            delayNextRead = false;
            delayedReadStarted.resolve();
            await releaseDelayedRead.promise;
          }
          return snapshot;
        },
        /** レイアウトの差し替えを受けない通常設定の保存を実ストアへ渡す。 */
        updateAppSettings: (settings) => storage.updateSettings(settings),
        /** 初回のレイアウト保存を意図的に失敗させ、後続の実ストア更新を待機点で制御する。 */
        async updateChatLayoutPreference(update) {
          writeAttempt += 1;
          if (writeAttempt === 1) {
            writeStarted.resolve();
            await rejectWrite.promise;
            throw new Error(`checkpoint failed: ${update.target}`);
          }
          if (writeAttempt === 2) await allowRetryWrite.promise;
          if (writeAttempt === 4) await allowFinalWrite.promise;
          storage.updateChatLayoutPreference(update);
          if (writeAttempt === 3) secondWriteCompleted.resolve();
          if (writeAttempt === 4) finalWriteCompleted.resolve();
          if (writeAttempt === 5) newerWriteCompleted.resolve();
        },
        /** レイアウト保存の対象と失敗理由を記録し、診断受領を知らせる。 */
        onChatLayoutPreferenceSaveError(update, error) {
          diagnostics.push(`${update.target}: ${String(error)}`);
          diagnosticReceived.resolve();
        },
        /** 設定応答に必要なモデル候補を返す。 */
        getModelCatalog: () => createCatalogSnapshot(),

        /** レイアウトの保存ではプロバイダー使用量の消去を観測しない。 */
        clearProviderQuotaTelemetry: () => {},
        /** レイアウトの検証にはセッションのコンテキスト計測を使わない。 */
        clearSessionContextTelemetry: () => {},
        /** 変更する認証情報がないので実スレッドの無効化は行わない。 */
        invalidateProviderSessionThread: () => {},
        /** 通知されるセッションを持たない条件で設定を保存する。 */
        broadcastSessions: () => {},
        /** 設定保存時に配信されるレイアウトを比較できるよう応答を記録する。 */
        broadcastAppSettings: (settings) => {
          if (settings) broadcasts.push(settings);
        },
        /** カタログ再配信を実行せず、設定の配信だけを観測する。 */
        broadcastModelCatalog: () => {},
      });

      service.updateChatLayoutPreference({
        target: "header",
        value: "visible",
      });
      await writeStarted.promise;
      assert.equal(
        (await service.getAppSettings()).chatLayoutPreference.header,
        "visible",
      );
      assert.equal(storage.getSettings().chatLayoutPreference.header, "hidden");

      const saved = await service.updateAppSettings({
        ...storage.getSettings(),
        launchAtLoginEnabled: true,
      });
      assert.equal(saved.chatLayoutPreference.header, "visible");
      assert.equal(broadcasts.at(-1)?.chatLayoutPreference.header, "visible");
      assert.equal(storage.getSettings().chatLayoutPreference.header, "hidden");

      rejectWrite.resolve();
      await diagnosticReceived.promise;
      assert.match(
        diagnostics[0] ?? "",
        /header: Error: checkpoint failed: header/,
      );
      assert.equal(
        (await service.getAppSettings()).chatLayoutPreference.header,
        "visible",
      );
      assert.equal(storage.getSettings().chatLayoutPreference.header, "hidden");

      service.updateChatLayoutPreference({
        target: "header",
        value: "visible",
      });
      service.updateChatLayoutPreference({ target: "header", value: "hidden" });
      service.updateChatLayoutPreference({
        target: "header",
        value: "visible",
      });
      allowRetryWrite.resolve();
      await secondWriteCompleted.promise;
      assert.equal(storage.getSettings().chatLayoutPreference.header, "hidden");
      assert.equal(
        (await service.getAppSettings()).chatLayoutPreference.header,
        "visible",
      );
      allowFinalWrite.resolve();
      await finalWriteCompleted.promise;
      assert.equal(
        storage.getSettings().chatLayoutPreference.header,
        "visible",
      );

      delayNextRead = true;
      const delayedRead = service.getAppSettings();
      await delayedReadStarted.promise;
      service.updateChatLayoutPreference({ target: "header", value: "hidden" });
      await newerWriteCompleted.promise;
      releaseDelayedRead.resolve();
      assert.equal((await delayedRead).chatLayoutPreference.header, "hidden");
    } finally {
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "明示的なApp Settings resetは任意chat layout checkpointの完了を待たず、未dispatchの旧checkpointを適用しない"
  // oracle = { type = "contract", ref = "docs/design/electron-session-store.md#settingscatalogservice" }
  // fault = "任意保存が未完了の間resetが停止する、またはreset後に旧表示選択が戻る"
  // observable = "reset実行到達、settings projection、storage write呼出数"
  // observation_boundary = "public-boundary"
  // scope = "settings-catalog-chat-layout-reset"
  // lifecycle = "permanent"
  // impact = "利用者の明示resetを任意checkpointが妨げるか、resetの表示結果が覆る"
  // distinction = "通常のSettings reset testでは任意保存が未完了の条件を通さない"
  // @end-test-value
  /** 保留中の任意チェックポイントを待たずに設定を初期化し、旧キューから二件目が保存されないことを確認する。 */
  it("App Settings reset は任意chat layout checkpointを待たず旧queueを破棄する", async () => {
    let storedSettings = createDefaultAppSettings();
    let writes = 0;
    const checkpointStarted = createDeferred();
    const releaseCheckpoint = createDeferred();
    const resetReached = createDeferred();
    const failedCheckpointObserved = createDeferred();
    const service = new SettingsCatalogService({
      /** 動作中ターンがリセットを妨げない状態にする。 */
      hasInFlightSessionRuns: () => false,
      /** 個別のランタイム実行はないものとする。 */
      isSessionRunInFlight: () => false,
      /** 実行中のセッションを含めずレイアウトだけを初期化する。 */
      isRunningSession: () => false,
      /** 設定だけを初期化するため Main の一覧は空にする。 */
      listSessions: () => [],
      /** 設定リセットに影響する Auxiliary を登録しない。 */
      listAuxiliarySessions: () => [],
      /** 初期化前後に保存された設定を返す。 */
      getAppSettings: () => storedSettings,
      /** 通常設定の保存を現在値へ反映する。 */
      updateAppSettings: (settings) => {
        storedSettings = settings;
        return settings;
      },
      /** 一件目のチェックポイントの送信を数え、リセットの検証が終わるまで待ってから失敗させる。 */
      async updateChatLayoutPreference() {
        writes += 1;
        checkpointStarted.resolve();
        await releaseCheckpoint.promise;
        throw new Error("checkpoint unavailable");
      },
      /** 旧チェックポイントの失敗が報告された時点を通知する。 */
      onChatLayoutPreferenceSaveError: () => failedCheckpointObserved.resolve(),
      /** 保存済み設定を既定値へ戻し、リセット開始を観測可能にする。 */
      resetAppSettings: () => {
        storedSettings = createDefaultAppSettings();
        resetReached.resolve();
        return storedSettings;
      },
      /** 初期化後に返す通常のカタログを提供する。 */
      getModelCatalog: () => createCatalogSnapshot(),

      /** 個別プロバイダーの計測は扱わない。 */
      clearProviderQuotaTelemetry: () => {},
      /** 設定リセットに伴う全プロバイダーの計測消去を受け入れる。 */
      clearAllProviderQuotaTelemetry: () => {},
      /** 初期化ケースに個別セッション計測は用意しない。 */
      clearSessionContextTelemetry: () => {},
      /** レイアウトのリセットから実スレッドを変更しない。 */
      invalidateProviderSessionThread: () => {},
      /** 実セッションの更新通知は送らない。 */
      broadcastSessions: () => {},
      /** 配信ではなく設定の再読込から初期化を検証する。 */
      broadcastAppSettings: () => {},
      /** カタログを外部へ再配信しない。 */
      broadcastModelCatalog: () => {},
    });

    service.updateChatLayoutPreference({ target: "header", value: "visible" });
    await checkpointStarted.promise;
    service.updateChatLayoutPreference({
      target: "sidePane",
      value: "context",
    });
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const reset = service.resetAppDatabase({ targets: ["appSettings"] });
      await Promise.race([
        resetReached.promise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  "App Settings reset waited for an optional checkpoint",
                ),
              ),
            500,
          );
        }),
      ]);
      await reset;
      assert.deepEqual(
        (await service.getAppSettings()).chatLayoutPreference,
        createDefaultAppSettings().chatLayoutPreference,
      );
    } finally {
      if (timeout) clearTimeout(timeout);
      releaseCheckpoint.resolve();
    }
    await failedCheckpointObserved.promise;
    await Promise.resolve();
    assert.equal(writes, 1);
    assert.deepEqual(
      (await service.getAppSettings()).chatLayoutPreference,
      createDefaultAppSettings().chatLayoutPreference,
    );
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "旧storage ownerの未dispatch chat layout checkpointは新しいstorage generationへ送られない"
  // oracle = { type = "contract", ref = "docs/design/electron-session-store.md#settingscatalogservice" }
  // fault = "旧serviceのqueueが遅延後にrequireAppSettingsStorageを再解決し新DBへ旧選択を書き込む"
  // observable = "checkpoint callbackの呼出回数と取得したstorage identity"
  // observation_boundary = "component-behavior"
  // scope = "settings-catalog-chat-layout-storage-owner"
  // lifecycle = "permanent"
  // impact = "DB再生成後の初期表示設定が閉鎖前の古い選択で上書きされる"
  // distinction = "reset epochのtestではservice owner自体が置換された場合を検出できない"
  // @end-test-value
  /** 旧ストアで保留されたレイアウト更新を、ストア交代後の次のチェックポイントとして送らないことを確認する。 */
  it("旧storage ownerの未dispatch chat layout checkpointは新generationへ送らない", async () => {
    const oldOwner = {};
    let currentOwner = oldOwner;
    const dispatchedOwners: object[] = [];
    const firstWriteStarted = createDeferred();
    const releaseFirstWrite = createDeferred();
    const firstWriteFinished = createDeferred();
    const service = new SettingsCatalogService({
      /** レイアウトの更新を受け付けた現行ストアの識別子を捕捉する。 */
      captureStorageIdentity: () => currentOwner,
      /** 切替済みの現行所有者と、受付時の識別子を比較する。 */
      isStorageIdentityCurrent: (identity) => identity === currentOwner,
      /** 全体の実行有無に依存せずチェックポイントを処理する。 */
      hasInFlightSessionRuns: () => false,
      /** ストア交代中に個別ターンの実行はないものとする。 */
      isSessionRunInFlight: () => false,
      /** 会話が実行中でない条件を与える。 */
      isRunningSession: () => false,
      /** 認証変更対象の Main は存在しない。 */
      listSessions: () => [],
      /** 対象の Auxiliary も存在しない。 */
      listAuxiliarySessions: () => [],
      /** ストア交代前後で同じ既定設定を読み込めるようにする。 */
      getAppSettings: () => createDefaultAppSettings(),
      /** 通常設定の保存に外部の副作用を持たせない。 */
      updateAppSettings: (settings) => settings,
      /** 保存操作を開始した世代を記録し、旧世代から続く処理を保留する。 */
      async updateChatLayoutPreference() {
        const dispatchOwner = currentOwner;
        dispatchedOwners.push(dispatchOwner);
        firstWriteStarted.resolve();
        await releaseFirstWrite.promise;
        firstWriteFinished.resolve();
      },
      /** ストア交代で変わらないモデル一覧を返す。 */
      getModelCatalog: () => createCatalogSnapshot(),

      /** プロバイダー別の使用量の記録は用意しない。 */
      clearProviderQuotaTelemetry: () => {},
      /** セッションのコンテキスト計測は持たせない。 */
      clearSessionContextTelemetry: () => {},
      /** 表示設定の世代チェックでは実スレッドを破棄しない。 */
      invalidateProviderSessionThread: () => {},
      /** ストア交代の観測と無関係なセッション配信は行わない。 */
      broadcastSessions: () => {},
      /** レイアウトの送信先はチェックポイントの記録のみで比較する。 */
      broadcastAppSettings: () => {},
      /** カタログ通知の送信先を持たない。 */
      broadcastModelCatalog: () => {},
    });

    service.updateChatLayoutPreference({ target: "header", value: "visible" });
    await firstWriteStarted.promise;
    service.updateChatLayoutPreference({
      target: "sidePane",
      value: "context",
    });
    currentOwner = {};
    releaseFirstWrite.resolve();
    await firstWriteFinished.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(dispatchedOwners, [oldOwner]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "credential変更は対象providerのMain実行・Auxiliary実行・Auxiliary admission予約が完了するまで保存しない"
  // oracle = { type = "contract", ref = "docs/design/electron-session-store.md#settingscatalogservice" }
  // fault = "親と異なるproviderのAuxiliaryまたはstarting予約を見落として使用中credentialを変更する"
  // observable = "実行中エラーとsettings保存回数0"
  // observation_boundary = "component-behavior"
  // scope = "settings-credential-running-guard"
  // lifecycle = "permanent"
  // impact = "実行中Turnの認証設定とthreadが途中で切り替わる"
  // distinction = "Mainのproviderだけを見ても検出できないAuxiliaryの実行と予約を個別に確認する"
  // @end-test-value
  /** 認証情報を更新する前に、同じプロバイダーの Main 実行、Auxiliary 実行、開始予約をすべて検出して書き込みゼロで拒否する。 */
  it("API key 変更対象 provider に実行中 session があると settings 更新を拒否する", async () => {
    for (const running of [
      "main",
      "auxiliary",
      "auxiliary-starting",
    ] as const) {
      const previousSettings = createDefaultAppSettings();
      const session = createSession({
        provider: running === "main" ? "codex" : "copilot",
      });
      const auxiliary = createAuxiliarySession({
        parentSessionId: session.id,
        runState: running === "auxiliary" ? "running" : "idle",
      });
      let writes = 0;
      const service = new SettingsCatalogService({
        /** 全体の実行判定を使わず、対象プロバイダーの確認経路だけを検証する。 */
        hasInFlightSessionRuns: () => false,
        /** Main または開始予約中の Auxiliary の実行ガードを ID 単位で返す。 */
        isSessionRunInFlight: (id) =>
          running === "main"
            ? id === session.id
            : running === "auxiliary-starting" && id === auxiliary.id,
        /** 通常の実行中判定では Main の場合だけ真とする。 */
        isRunningSession: () => running === "main",
        /** 認証情報を共有する実行候補の Main を返す。 */
        listSessions: () => [session],
        /** 実行と開始予約の両方を試す Auxiliary を返す。 */
        listAuxiliarySessions: () => [auxiliary],
        /** 認証変更の比較元となる保存済み設定を返す。 */
        getAppSettings: () => previousSettings,
        /** 実行中でも誤って設定保存に達した場合に回数を記録する。 */
        updateAppSettings: (settings) => {
          writes += 1;
          return settings;
        },
        /** 対象のプロバイダーを含むカタログを使う。 */
        getModelCatalog: () => createCatalogSnapshot(),

        /** 全件置換が必要な成功経路には達しない条件とする。 */
        replaceAllSessions: () => [],
        /** プロバイダー使用量の消去は実行しない。 */
        clearProviderQuotaTelemetry: () => {},
        /** セッション計測に外部の副作用を作らない。 */
        clearSessionContextTelemetry: () => {},
        /** スレッド無効化の実クライアントを起動しない。 */
        invalidateProviderSessionThread: () => {},
        /** 拒否されたセッション変更を外へ配信しない。 */
        broadcastSessions: () => {},
        /** 設定の成功通知先を用意しない。 */
        broadcastAppSettings: () => {},
        /** モデル候補の通知先を持たない。 */
        broadcastModelCatalog: () => {},
      });
      await assert.rejects(
        service.updateAppSettings({
          ...previousSettings,
          codingProviderSettings: {
            ...previousSettings.codingProviderSettings,
            codex: {
              ...previousSettings.codingProviderSettings.codex,
              apiKey: "changed-key",
            },
          },
        }),
        /A session is using the provider whose Coding Agent credentials are changing/,
      );
      assert.equal(writes, 0, running);
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "credential不変の通常 settings 更新はSession/Aux一覧を読まず、並行保存された chat layout を巻き戻さない"
  // oracle = { type = "contract", ref = "Concurrent settings projection" }
  // fault = "不要な全Session/Aux一覧を読み、またはstale snapshot が最新 layout を上書きする"
  // observable = "一覧読取なしで完了した settings 更新後の chatLayoutPreference"
  // observation_boundary = "public-boundary"
  // scope = "settings-catalog-layout-concurrency"
  // lifecycle = "permanent"
  // impact = "別 window の layout 操作が失われる"
  // distinction = "storage update と catalog projection の race を確認する"
  // @end-test-value
  /** 通常設定が保存待ちの間に実 SQLite で変えたレイアウト三項目が保持され、認証情報を変えない更新では会話一覧を読み込まない。 */
  it("待機中の通常 settings 更新は並行して保存された chat layout を巻き戻さない", async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "withmate-settings-catalog-"),
    );
    const dbPath = path.join(tempDirectory, "withmate.db");
    const storage = new AppSettingsStorage(dbPath);
    const auxiliarySessionsRequested = createDeferred();
    const resumeAuxiliarySessions = createDeferred();

    try {
      const previousSettings = storage.getSettings();
      const service = new SettingsCatalogService({
        /** 通常保存を拒否する全体実行はないものとする。 */
        hasInFlightSessionRuns() {
          return false;
        },
        /** 認証変更のない保存で個別ターンの競合を作らない。 */
        isSessionRunInFlight() {
          return false;
        },
        /** 停止中として通常設定の書き込みを進める。 */
        isRunningSession() {
          return false;
        },
        /** 設定更新から Main の実体一覧を読もうとした場合に失敗させる。 */
        listSessions() {
          throw new Error(
            "credential-unchanged settings save must not hydrate Sessions",
          );
        },
        /** 認証不変なのに Auxiliary の実体を読んだ場合に失敗させる。 */
        listAuxiliarySessions() {
          throw new Error(
            "credential-unchanged settings save must not hydrate Auxiliary sessions",
          );
        },
        /** 並行更新を反映できる実 SQLite の設定を読む。 */
        getAppSettings() {
          return storage.getSettings();
        },
        /** 書き込み前に一時停止し、その間に別の操作でレイアウトを更新できるようにする。 */
        async updateAppSettings(settings) {
          auxiliarySessionsRequested.resolve();
          await resumeAuxiliarySessions.promise;
          return storage.updateSettings(settings);
        },
        /** 通常設定へ返すモデル一覧を提供する。 */
        getModelCatalog() {
          return createCatalogSnapshot();
        },

        /** 代替ストアでは受け取ったセッション配列をそのまま返す。 */
        replaceAllSessions(nextSessions) {
          return nextSessions;
        },

        /** プロバイダー使用量は通常保存との競合対象に含めない。 */
        clearProviderQuotaTelemetry() {},
        /** レイアウトテストでセッション計測値は扱わない。 */
        clearSessionContextTelemetry() {},
        /** 通常保存で外部ランタイムを操作しない。 */
        invalidateProviderSessionThread() {},
        /** 実セッションへの通知を送信しない。 */
        broadcastSessions() {},
        /** 配信ではなく保存値と返却値の一致を観測する。 */
        broadcastAppSettings() {},
        /** モデル一覧の配信は検証範囲に含めない。 */
        broadcastModelCatalog() {},
      });

      const updating = service.updateAppSettings({
        ...previousSettings,
        launchAtLoginEnabled: true,
      });
      await auxiliarySessionsRequested.promise;
      storage.updateChatLayoutPreference({
        target: "header",
        value: "visible",
      });
      storage.updateChatLayoutPreference({
        target: "actionDock",
        value: "expanded",
      });
      storage.updateChatLayoutPreference({
        target: "sidePane",
        value: "context",
      });
      resumeAuxiliarySessions.resolve();

      const updated = await updating;

      assert.equal(updated.launchAtLoginEnabled, true);
      assert.deepEqual(updated.chatLayoutPreference, {
        header: "visible",
        actionDock: "expanded",
        sidePane: "context",
      });
      assert.deepEqual(
        storage.getSettings().chatLayoutPreference,
        updated.chatLayoutPreference,
      );
    } finally {
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "通常 settings 保存後の layout 更新を最新 projection へ反映する"
  // oracle = { type = "adr", ref = "docs/adr/032-chat-layout-preference-boundary.md" }
  // fault = "保存待機中の layout 更新が broadcast projection から欠落する"
  // observable = "updated/broadcast chatLayoutPreference"
  // observation_boundary = "public-boundary"
  // scope = "settings-catalog-latest-layout"
  // lifecycle = "permanent"
  // impact = "新しい Session Window が古い layout を受け取る"
  // distinction = "保存完了後の最新 layout 反映を確認する"
  // @end-test-value
  /** 設定保存後に認証変更の処理が待機している間のレイアウト変更を、保存結果と設定の配信結果にも反映する。 */
  it("通常 settings 保存後の待機中に更新された chat layout を最新の projection へ反映する", async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "withmate-settings-catalog-"),
    );
    const dbPath = path.join(tempDirectory, "withmate.db");
    const storage = new AppSettingsStorage(dbPath);
    const sessionReplacementStarted = createDeferred();
    const resumeSessionReplacement = createDeferred();
    const broadcast = { settings: null as AppSettings | null };

    try {
      const previousSettings = storage.getSettings();
      const previousSessions = [createSession()];
      const service = new SettingsCatalogService({
        /** 更新開始時には全体の実行ガードを立てない。 */
        hasInFlightSessionRuns() {
          return false;
        },
        /** 対象のスレッドを編集中の個別ターンはないものとする。 */
        isSessionRunInFlight() {
          return false;
        },
        /** 認証更新を妨げない停止中の状態を返す。 */
        isRunningSession() {
          return false;
        },
        /** スレッド変更対象の Main 一件を返す。 */
        listSessions() {
          return previousSessions;
        },
        /** 待機するスレッド更新を Main に限定する。 */
        listAuxiliarySessions() {
          return [];
        },
        /** レイアウトの並行変更を含む現在設定を SQLite から読む。 */
        getAppSettings() {
          return storage.getSettings();
        },
        /** スレッド処理へ進む前に通常設定を SQLite へ保存する。 */
        updateAppSettings(settings) {
          return storage.updateSettings(settings);
        },
        /** 認証更新後に参照するモデル一覧を提供する。 */
        getModelCatalog() {
          return createCatalogSnapshot();
        },

        /** Main のスレッド変更を適用し、処理が再開する前にレイアウトを上書きできる待機点を設ける。 */
        async updateSessionThreadIfMatches(input) {
          const current = previousSessions[0];
          current.threadId = input.nextThreadId;
          current.updatedAt = input.updatedAt;
          sessionReplacementStarted.resolve();
          await resumeSessionReplacement.promise;
          return { ...current };
        },

        /** このケースではプロバイダーの計測消去を観測しない。 */
        clearProviderQuotaTelemetry() {},
        /** スレッド変更の前後で外部コンテキスト計測を用意しない。 */
        clearSessionContextTelemetry() {},
        /** クライアントの終了待ちを追加せず、保存後の待機をスレッド更新に限定する。 */
        invalidateProviderSessionThread() {},
        /** セッション通知は外部に送らない。 */
        broadcastSessions() {},
        /** 設定を配信する時点で使われたレイアウトの投影を保持する。 */
        broadcastAppSettings(settings) {
          broadcast.settings = settings ?? storage.getSettings();
        },
        /** モデル候補の通知を記録対象にしない。 */
        broadcastModelCatalog() {},
      });

      const updating = service.updateAppSettings({
        ...previousSettings,
        launchAtLoginEnabled: true,
        codingProviderSettings: {
          ...previousSettings.codingProviderSettings,
          codex: {
            ...previousSettings.codingProviderSettings.codex,
            apiKey: "changed-key",
          },
        },
      });
      await sessionReplacementStarted.promise;
      storage.updateChatLayoutPreference({
        target: "header",
        value: "visible",
      });
      storage.updateChatLayoutPreference({
        target: "actionDock",
        value: "expanded",
      });
      storage.updateChatLayoutPreference({
        target: "sidePane",
        value: "files",
      });
      resumeSessionReplacement.resolve();

      const updated = await updating;

      assert.equal(updated.launchAtLoginEnabled, true);
      assert.deepEqual(updated.chatLayoutPreference, {
        header: "visible",
        actionDock: "expanded",
        sidePane: "files",
      });
      assert.ok(broadcast.settings);
      const observedBroadcastSettings = broadcast.settings;
      assert.deepEqual(
        observedBroadcastSettings.chatLayoutPreference,
        updated.chatLayoutPreference,
      );
      assert.deepEqual(
        storage.getSettings().chatLayoutPreference,
        updated.chatLayoutPreference,
      );
    } finally {
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "通常 settings 更新の rollback は並行保存された chat layout を巻き戻さない"
  // oracle = { type = "adr", ref = "docs/adr/032-chat-layout-preference-boundary.md" }
  // fault = "失敗 rollback が最新 layout まで復元前値へ戻す"
  // observable = "rollback 後の chatLayoutPreference"
  // observation_boundary = "public-boundary"
  // scope = "settings-catalog-layout-rollback"
  // lifecycle = "permanent"
  // impact = "layout 操作が失敗した settings 保存に巻き込まれる"
  // distinction = "settings failure と独立した layout persistence を確認する"
  // @end-test-value
  /** 認証変更後のスレッド更新を失敗させても、待機中に別操作で保存したレイアウトをロールバックで消さない。 */
  it("通常 settings 更新の rollback は並行して保存された chat layout を巻き戻さない", async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "withmate-settings-catalog-"),
    );
    const dbPath = path.join(tempDirectory, "withmate.db");
    const storage = new AppSettingsStorage(dbPath);
    const firstSessionReplacementStarted = createDeferred();
    const rejectFirstSessionReplacement = createDeferred();
    let replaceCallCount = 0;

    try {
      const previousSettings = storage.getSettings();
      const previousSessions = [createSession()];
      const service = new SettingsCatalogService({
        /** 全体の実行がないため、設定を保存してから更新の失敗経路に進める。 */
        hasInFlightSessionRuns() {
          return false;
        },
        /** 更新対象のスレッドに実行中のターンはない。 */
        isSessionRunInFlight() {
          return false;
        },
        /** セッションは停止中として扱う。 */
        isRunningSession() {
          return false;
        },
        /** スレッド更新の対象になる Main の保存前一覧を返す。 */
        listSessions() {
          return previousSessions;
        },
        /** ロールバックと競合する更新を Main に限定する。 */
        listAuxiliarySessions() {
          return [];
        },
        /** 設定の読込先を並行変更に使う SQLite と揃える。 */
        getAppSettings() {
          return storage.getSettings();
        },
        /** 正常に保存できる通常設定は実 SQLite へ反映する。 */
        updateAppSettings(settings) {
          return storage.updateSettings(settings);
        },
        /** 設定に対応するカタログを返し、失敗をスレッド処理で起こす。 */
        getModelCatalog() {
          return createCatalogSnapshot();
        },

        /** 最初だけスレッドを書き換えてから待機し、保存結果が不明な例外を投げる。 */
        async updateSessionThreadIfMatches(input) {
          replaceCallCount += 1;
          const current = previousSessions[0];
          current.threadId = input.nextThreadId;
          current.updatedAt = input.updatedAt;
          if (replaceCallCount === 1) {
            firstSessionReplacementStarted.resolve();
            await rejectFirstSessionReplacement.promise;
            throw new Error("session replacement failed");
          }
          return { ...current };
        },

        /** 使用量の更新を失敗理由に含めない。 */
        clearProviderQuotaTelemetry() {},
        /** セッション計測はロールバックの対象に含めない。 */
        clearSessionContextTelemetry() {},
        /** スレッド更新以外の外部停止処理は実行しない。 */
        invalidateProviderSessionThread() {},
        /** セッション通知を持たず、保存結果を直接比較する。 */
        broadcastSessions() {},
        /** 設定通知によって追加の例外を発生させない。 */
        broadcastAppSettings() {},
        /** モデルカタログを配信しない。 */
        broadcastModelCatalog() {},
      });

      const updating = service.updateAppSettings({
        ...previousSettings,
        codingProviderSettings: {
          ...previousSettings.codingProviderSettings,
          codex: {
            ...previousSettings.codingProviderSettings.codex,
            apiKey: "changed-key",
          },
        },
      });
      await firstSessionReplacementStarted.promise;
      storage.updateChatLayoutPreference({
        target: "header",
        value: "visible",
      });
      storage.updateChatLayoutPreference({
        target: "actionDock",
        value: "expanded",
      });
      storage.updateChatLayoutPreference({
        target: "sidePane",
        value: "context",
      });
      rejectFirstSessionReplacement.resolve();

      await assert.rejects(() => updating, /session replacement failed/);
      assert.equal(replaceCallCount, 1);
      assert.deepEqual(storage.getSettings().chatLayoutPreference, {
        header: "visible",
        actionDock: "expanded",
        sidePane: "context",
      });
    } finally {
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "settingsのみの失敗 rollback は並行する Session と Auxiliary の更新を巻き戻さない"
  // oracle = { type = "contract", ref = "docs/design/electron-session-store.md#settingscatalogservice" }
  // fault = "Session/Auxiliary の書き込みを伴わない settings 失敗で全 snapshot rollback が実行される"
  // observable = "rollback 後の settings、元のerror、Session削除とAuxiliary更新後のcollection"
  // observation_boundary = "component-behavior"
  // scope = "settings-catalog-collection-rollback-boundary"
  // lifecycle = "permanent"
  // impact = "並行した削除・更新が settings 操作により復活・巻き戻しされる"
  // distinction = "thread reset の有無で collection rollback の所有範囲を分ける"
  // @end-test-value
  /** 設定通知の失敗後に設定だけを戻し、保存待ちの間に削除した Main と更新した Auxiliary の履歴をそのまま保持する。 */
  it(
    "settingsのみの失敗 rollback は並行する Session と Auxiliary の更新を巻き戻さない",
    { timeout: 10_000 },
    async () => {
      const previousSettings = createDefaultAppSettings();
      let currentSessions = [{ ...createSession(), provider: "copilot" }];
      let currentAuxiliarySessions = [
        createAuxiliarySession({ provider: "copilot" }),
      ];
      const savedSettingsEntered = createDeferred();
      const savedSettingsResume = createDeferred();
      let savedSettings: AppSettings | null = null;

      const service = new SettingsCatalogService({
        /** 全体の実行による先行拒否を発生させない。 */
        hasInFlightSessionRuns() {
          return false;
        },
        /** 認証更新を拒む個別ターンは存在しない状態にする。 */
        isSessionRunInFlight() {
          return false;
        },
        /** セッションの実行中判定による失敗は発生させない。 */
        isRunningSession() {
          return false;
        },
        /** 保存待ちの間に削除された Main を反映した一覧を返す。 */
        listSessions() {
          return currentSessions;
        },
        /** 並行するメッセージ更新を反映した Auxiliary の一覧を返す。 */
        listAuxiliarySessions() {
          return currentAuxiliarySessions;
        },
        /** 保存済み設定がなければ変更前設定を使う。 */
        getAppSettings() {
          return savedSettings ?? previousSettings;
        },
        /** 設定を記録した直後で処理を保留し、別操作によるセッション更新を挟む。 */
        async updateAppSettings(settings) {
          savedSettings = settings;
          savedSettingsEntered.resolve();
          await savedSettingsResume.promise;
          return settings;
        },
        /** 認証情報の異なるプロバイダーが共存するモデル一覧を使う。 */
        getModelCatalog() {
          return createCatalogSnapshot();
        },

        /** 全件置換が呼ばれた場合には一覧を変え、削除が巻き戻る回帰を観測できるようにする。 */
        replaceAllSessions(nextSessions) {
          currentSessions = nextSessions;
          return nextSessions;
        },

        /** 設定通知の失敗に検証を限り、使用量の消去は実行しない。 */
        clearProviderQuotaTelemetry() {},
        /** テストに外部のコンテキスト指標を用意しない。 */
        clearSessionContextTelemetry() {},
        /** 変更対象外のスレッドの実クライアントを操作しない。 */
        invalidateProviderSessionThread() {},
        /** 並行変更は一覧を直接観測し、セッションの通知を使わない。 */
        broadcastSessions() {},
        /** 永続化後の設定投影を意図的に失敗させ、設定だけのロールバックを起こす。 */
        broadcastAppSettings() {
          throw new Error("settings projection failed");
        },
        /** モデル一覧への配信を失敗条件に含めない。 */
        broadcastModelCatalog() {},
      });

      const updating = service.updateAppSettings({
        ...previousSettings,
        codingProviderSettings: {
          ...previousSettings.codingProviderSettings,
          codex: {
            ...previousSettings.codingProviderSettings.codex,
            apiKey: "changed-key",
          },
        },
      });
      await savedSettingsEntered.promise;
      currentSessions = [];
      const updatedAuxiliarySessions = [
        createAuxiliarySession({
          provider: "copilot",
          messages: [{ role: "assistant", text: "concurrent update" }],
        }),
      ];
      currentAuxiliarySessions = updatedAuxiliarySessions;
      savedSettingsResume.resolve();

      await assert.rejects(() => updating, /settings projection failed/);
      assert.deepEqual(savedSettings, previousSettings);
      assert.deepEqual(currentSessions, []);
      assert.deepEqual(currentAuxiliarySessions, updatedAuxiliarySessions);
    },
  );

  // @test-value v2
  // kind = "invariant"
  // claim = "credential変更時は対象Sessionのthreadを条件付き更新し、provider runtime invalidationを実行する"
  // oracle = { type = "contract", ref = "docs/design/electron-session-store.md#settingscatalogservice" }
  // fault = "全Session snapshot replaceを使う、または空threadのprovider runtime invalidationを省略する"
  // observable = "threadId、messages、telemetry clear、provider invalidation、旧collection replace呼出し"
  // observation_boundary = "component-behavior"
  // scope = "settings-credential-session-thread"
  // lifecycle = "permanent"
  // distinction = "thread patchとprovider invalidationのservice orchestrationを直接確認する"
  // @end-test-value
  /** Codex の認証変更で本文を保ったまま旧スレッドだけを消し、スレッドがない行も含めて対象のランタイムと計測を無効化する。 */
  it("settings 更新時に API key 変更 provider の thread と telemetry を無効化する", async () => {
    const previousSettings = createDefaultAppSettings();
    const previousSessions = [
      createSession(),
      createSession({ id: "session-empty-thread", threadId: "" }),
    ];
    const patchedIds: string[] = [];
    const clearQuotaCalls: string[] = [];
    const clearContextCalls: string[] = [];
    const invalidated: string[] = [];
    let replacedSessions: Session[] = [];
    const saved = { settings: null as AppSettings | null };

    const service = new SettingsCatalogService({
      /** 全体の実行を停止中として認証更新を許可する。 */
      hasInFlightSessionRuns() {
        return false;
      },
      /** スレッドを更新できるよう個別の実行ガードを解除しておく。 */
      isSessionRunInFlight() {
        return false;
      },
      /** いずれの Main も実行中でない値を返す。 */
      isRunningSession() {
        return false;
      },
      /** スレッドありと空スレッドの Main を両方返す。 */
      listSessions() {
        return previousSessions;
      },
      /** Main の認証変更だけを検証するため Auxiliary は空にする。 */
      listAuxiliarySessions() {
        return [];
      },
      /** 認証変更後の保存値を優先して読み込む。 */
      getAppSettings() {
        return saved.settings ?? previousSettings;
      },
      /** 新しい認証設定を保存し、返却値との比較に使う。 */
      updateAppSettings(settings) {
        saved.settings = settings;
        return settings;
      },
      /** 認証変更対象に対応するモデル一覧を返す。 */
      getModelCatalog() {
        return createCatalogSnapshot();
      },

      /** 認証変更がスレッドだけでなく全会話を書き換えようとしたら失敗する。 */
      replaceAllSessions() {
        throw new Error(
          "credential thread test must not replace the full Session collection",
        );
      },
      /** 所有者と旧スレッドが一致する行だけを更新し、更新に渡された ID を記録する。 */
      updateSessionThreadIfMatches(input) {
        patchedIds.push(input.sessionId);
        const current = previousSessions.find(
          (session) =>
            session.id === input.sessionId &&
            getSessionIncarnationId(session) === input.incarnationId &&
            session.provider === input.provider &&
            session.threadId === input.expectedThreadId,
        );
        if (!current) return null;
        current.threadId = input.nextThreadId;
        current.updatedAt = input.updatedAt;
        replacedSessions = previousSessions;
        return { ...current };
      },

      /** Auxiliary の条件付き更新では一致する行がないと返す。 */
      updateAuxiliarySessionThreadIfMatches() {
        return null;
      },
      /** 使用量を消去したプロバイダーの ID を記録する。 */
      clearProviderQuotaTelemetry(providerId) {
        clearQuotaCalls.push(providerId);
      },
      /** コンテキストを消去したセッション ID を記録する。 */
      clearSessionContextTelemetry(sessionId) {
        clearContextCalls.push(sessionId);
      },
      /** 無効化の対象となったプロバイダーとセッションの組を記録する。 */
      invalidateProviderSessionThread(providerId, sessionId) {
        invalidated.push(`${providerId}:${sessionId}`);
      },
      /** 会話への実配信なしで更新済みスレッドを比べる。 */
      broadcastSessions() {},
      /** 設定の読込先へ保存された結果を直接使う。 */
      broadcastAppSettings() {},
      /** モデル一覧の再配信は観測しない。 */
      broadcastModelCatalog() {},
    });

    const next = await service.updateAppSettings({
      ...previousSettings,
      codingProviderSettings: {
        ...previousSettings.codingProviderSettings,
        codex: {
          ...previousSettings.codingProviderSettings.codex,
          apiKey: "changed-key",
        },
      },
    });

    assert.ok(saved.settings);
    assert.equal(
      saved.settings.codingProviderSettings["codex"]?.apiKey,
      "changed-key",
    );
    assert.equal(next.codingProviderSettings.codex.apiKey, "changed-key");
    assert.deepEqual(clearQuotaCalls, ["codex"]);
    assert.deepEqual(clearContextCalls, ["session-1", "session-empty-thread"]);
    assert.deepEqual(patchedIds, ["session-1"]);
    assert.equal(replacedSessions[0]?.threadId, "");
    assert.deepEqual(
      replacedSessions[0]?.messages,
      previousSessions[0].messages,
    );
    assert.deepEqual(invalidated, [
      "codex:session-1",
      "codex:session-empty-thread",
    ]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "credential変更時は対象Auxiliaryのthreadを条件付き更新し、親Sessionを含むprovider runtime invalidationを実行する"
  // oracle = { type = "contract", ref = "docs/design/electron-session-store.md#settingscatalogservice" }
  // fault = "Auxiliaryの条件付きthread更新または親Sessionのprovider invalidationを省略する"
  // observable = "Auxiliary threadId、messages、telemetry clear、provider invalidation"
  // observation_boundary = "component-behavior"
  // scope = "settings-credential-auxiliary-thread"
  // lifecycle = "permanent"
  // distinction = "Auxiliaryの条件付きpatchと全provider invalidationの境界を直接確認する"
  // @end-test-value
  /** 認証変更で Auxiliary のスレッドだけを消して履歴を保持し、空スレッドの親も含めてランタイムとコンテキストを無効化する。 */
  it("settings 更新時に API key 変更 provider の auxiliary thread も無効化する", async () => {
    const previousSettings = createDefaultAppSettings();
    const previousSessions = [createSession({ threadId: "" })];
    const previousAuxiliarySessions = [createAuxiliarySession()];
    const previousMessages = structuredClone(
      previousAuxiliarySessions[0].messages,
    );
    const clearContextCalls: string[] = [];
    const invalidated: string[] = [];

    const service = new SettingsCatalogService({
      /** 実行全体に対する認証変更の制限を解除しておく。 */
      hasInFlightSessionRuns() {
        return false;
      },
      /** Main と Auxiliary の実行予約がない値を返す。 */
      isSessionRunInFlight() {
        return false;
      },
      /** 対象会話のスレッド更新を止めないよう実行中でないと返す。 */
      isRunningSession() {
        return false;
      },
      /** 空スレッドを持つ親の Main 一覧を返す。 */
      listSessions() {
        return previousSessions;
      },
      /** スレッドを保持している子の一覧を返す。 */
      listAuxiliarySessions() {
        return previousAuxiliarySessions;
      },
      /** 認証変更の差分を取る元の設定を返す。 */
      getAppSettings() {
        return previousSettings;
      },
      /** このケースでは書き込み先の状態を持たず、渡された設定を返す。 */
      updateAppSettings(settings) {
        return settings;
      },
      /** 変更された認証と対応するモデルカタログを返す。 */
      getModelCatalog() {
        return createCatalogSnapshot();
      },

      /** Auxiliary のスレッド更新が全セッション置換に広がった場合に検出する。 */
      replaceAllSessions() {
        throw new Error(
          "credential thread test must not replace the full Session collection",
        );
      },
      /** Main は空スレッドなので更新対象なしと返す。 */
      updateSessionThreadIfMatches() {
        return null;
      },

      /** 親、作成時刻、プロバイダーと旧スレッドが一致する子の行だけを書き換える。 */
      updateAuxiliarySessionThreadIfMatches(input) {
        const current = previousAuxiliarySessions.find(
          (session) =>
            session.id === input.auxiliarySessionId &&
            session.parentSessionId === input.parentSessionId &&
            session.provider === input.provider &&
            session.threadId === input.expectedThreadId &&
            session.createdAt === input.createdAt,
        );
        if (!current) return null;
        current.threadId = input.nextThreadId;
        current.updatedAt = input.updatedAt;
        return { ...current };
      },
      /** プロバイダー使用量の記録は子スレッド更新の比較から外す。 */
      clearProviderQuotaTelemetry() {},
      /** Main と Auxiliary のどちらのコンテキスト消去かを ID で記録する。 */
      clearSessionContextTelemetry(sessionId) {
        clearContextCalls.push(sessionId);
      },
      /** 親と子の実行先無効化をプロバイダー付きで記録する。 */
      invalidateProviderSessionThread(providerId, sessionId) {
        invalidated.push(`${providerId}:${sessionId}`);
      },
      /** ランタイムの無効化を観測し、ウィンドウへの配信は行わない。 */
      broadcastSessions() {},
      /** 設定の外部通知はスレッド検証に使わない。 */
      broadcastAppSettings() {},
      /** モデル一覧の外部配信を省く。 */
      broadcastModelCatalog() {},
    });

    await service.updateAppSettings({
      ...previousSettings,
      codingProviderSettings: {
        ...previousSettings.codingProviderSettings,
        codex: {
          ...previousSettings.codingProviderSettings.codex,
          apiKey: "changed-key",
        },
      },
    });

    assert.equal(previousAuxiliarySessions[0]?.threadId, "");
    assert.deepEqual(previousAuxiliarySessions[0]?.messages, previousMessages);
    assert.deepEqual(clearContextCalls, ["session-1", "aux-1"]);
    assert.deepEqual(invalidated, ["codex:session-1", "codex:aux-1"]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "credential変更中の結果確定済みthread patchだけをCAS rollbackし、並行する本文・draft更新と別row削除を保持する"
  // fault = "invalidation失敗時に全Session/Auxiliary snapshotを復元して、並行更新または削除を失う"
  // observable = "settings error、threadId、Main本文、Auxiliary draft、削除済みrow、reverse patch対象"
  // observation_boundary = "component-behavior"
  // scope = "credential-thread-cas-rollback-preserves-concurrent-state"
  // oracle = { type = "contract", ref = "docs/design/electron-session-store.md#settingscatalogservice" }
  // lifecycle = "permanent"
  // impact = "credential更新失敗が同時編集内容を巻き戻す、または削除済みAuxiliaryを復活させる"
  // distinction = "storage単体の条件判定ではなく、serviceのsettings失敗・invalidation失敗・reverse CASの対象選択を検証する"
  // @end-test-value
  /** 無効化の失敗時に条件一致するスレッド更新だけを戻し、待機中に変更した本文・下書きと削除した別の行を維持する。 */
  it("credential更新のinvalidation失敗はthreadだけをCAS rollbackし並行状態を保持する", async () => {
    const previousSettings = createDefaultAppSettings();
    const main = createSession();
    const auxiliary = createAuxiliarySession();
    const deletedAuxiliary = createAuxiliarySession({
      id: "aux-deleted",
      threadId: "deleted-thread",
    });
    const sessions = [main];
    const auxiliaries = [auxiliary, deletedAuxiliary];
    const invalidationStarted = createDeferred();
    const releaseInvalidation = createDeferred();
    const reverseInputs: string[] = [];
    let savedSettings = previousSettings;
    let invalidationCalls = 0;
    const service = new SettingsCatalogService({
      /** 全体の実行がない状態で認証情報の変更を始められるようにする。 */
      hasInFlightSessionRuns: () => false,
      /** 条件付き更新の対象に実行中ターンを持たせない。 */
      isSessionRunInFlight: () => false,
      /** 停止状態であることを返し、失敗を無効化処理に限定する。 */
      isRunningSession: () => false,
      /** 並行操作とスナップショットの本文配列が共有されないよう複製する。 */
      listSessions: () =>
        sessions.map((session) => ({
          ...session,
          messages: [...session.messages],
        })),
      /** 現在の子一覧と本文を複製し、後から削除しても古い一覧を検証できるようにする。 */
      listAuxiliarySessions: () =>
        auxiliaries.map((session) => ({
          ...session,
          messages: [...session.messages],
        })),
      /** ロールバックの前後で記録した設定を返す。 */
      getAppSettings: () => savedSettings,
      /** 認証変更とその巻き戻しを同じインメモリ設定へ保存する。 */
      updateAppSettings: (settings) => {
        savedSettings = settings;
        return settings;
      },
      /** 認証変更で対象になるプロバイダーを含むカタログを返す。 */
      getModelCatalog: () => createCatalogSnapshot(),

      /** 全会話の置換が使われると検証を失敗させ、スレッドだけの更新を要求する。 */
      replaceAllSessions: () => {
        throw new Error("must use thread patch");
      },

      /** Main の更新条件を照合し、元へ戻すスレッド ID を順序付きで記録する。 */
      updateSessionThreadIfMatches: (input) => {
        const current = sessions.find(
          (session) =>
            session.id === input.sessionId &&
            getSessionIncarnationId(session) === input.incarnationId &&
            session.provider === input.provider &&
            session.threadId === input.expectedThreadId,
        );
        if (!current) return null;
        if (input.expectedThreadId === "")
          reverseInputs.push(`main:${input.nextThreadId}`);
        current.threadId = input.nextThreadId;
        current.updatedAt = input.updatedAt;
        return { ...current };
      },
      /** 親や作成時刻が一致する子だけを更新し、削除済みなら更新せず、巻き戻した値を記録する。 */
      updateAuxiliarySessionThreadIfMatches: (input) => {
        const current = auxiliaries.find(
          (session) =>
            session.id === input.auxiliarySessionId &&
            session.parentSessionId === input.parentSessionId &&
            session.provider === input.provider &&
            session.threadId === input.expectedThreadId &&
            session.createdAt === input.createdAt,
        );
        if (!current) return null;
        if (input.expectedThreadId === "")
          reverseInputs.push(`aux:${input.nextThreadId}`);
        current.threadId = input.nextThreadId;
        current.updatedAt = input.updatedAt;
        return { ...current };
      },
      /** 使用量消去をロールバック失敗の要因にしない。 */
      clearProviderQuotaTelemetry: () => {},
      /** コンテキスト計測を保存対象に含めない。 */
      clearSessionContextTelemetry: () => {},
      /** 初回の無効化を待機させ、その間に本文編集と削除を挟んでから失敗させる。 */
      invalidateProviderSessionThread: async () => {
        invalidationCalls += 1;
        if (invalidationCalls === 1) {
          invalidationStarted.resolve();
          await releaseInvalidation.promise;
          throw new Error("invalidation failed");
        }
      },
      /** 配信結果ではなくスレッドと現在の内容を比較する。 */
      broadcastSessions: () => {},
      /** 設定通知に別の失敗を導入しない。 */
      broadcastAppSettings: () => {},
      /** モデルの再配信はロールバックの比較対象ではない。 */
      broadcastModelCatalog: () => {},
    });

    const updating = service.updateAppSettings({
      ...previousSettings,
      codingProviderSettings: {
        ...previousSettings.codingProviderSettings,
        codex: {
          ...previousSettings.codingProviderSettings.codex,
          apiKey: "changed-key",
        },
      },
    });
    await invalidationStarted.promise;
    main.messages = [{ role: "user", text: "concurrent body" }];
    auxiliary.composerDraft = "concurrent draft";
    auxiliaries.splice(1, 1);
    releaseInvalidation.resolve();

    await assert.rejects(() => updating);
    assert.equal(main.threadId, "thread-1");
    assert.deepEqual(main.messages, [
      { role: "user", text: "concurrent body" },
    ]);
    assert.equal(auxiliary.threadId, "aux-thread-1");
    assert.equal(auxiliary.composerDraft, "concurrent draft");
    assert.equal(
      auxiliaries.some((session) => session.id === "aux-deleted"),
      false,
    );
    assert.deepEqual(reverseInputs, ["main:thread-1", "aux:aux-thread-1"]);
    assert.equal(savedSettings.codingProviderSettings.codex.apiKey, "");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "provider cleanup barrier 中は affected provider の Turn だけを拒否し、完了後に admission を解放する"
  // fault = "cleanup 待機中に同一 provider の新規 Turn を許可する、または cleanup 完了後も拒否し続ける"
  // observable = "affected provider の拒否、別 provider の許可、cleanup failure、完了後の再許可"
  // observation_boundary = "component-behavior"
  // scope = "provider-cleanup-admission"
  // oracle = { type = "contract", ref = "docs/design/electron-session-store.md#settingscatalogservice" }
  // lifecycle = "permanent"
  // impact = "旧 provider cleanup が新 Turn の thread を無効化する競合を許可する"
  // distinction = "単なる cleanup 呼出し確認ではなく、同期 admission の保持期間を直接確認する"
  // @end-test-value
  /** 旧接続の後処理中は変更対象プロバイダーだけ新規ターンを拒否し、後処理に失敗しても完了後は受け付ける。 */
  it("provider cleanup barrier 中の affected provider admission を保持する", async () => {
    const previousSettings = createDefaultAppSettings();
    const session = createSession();
    let savedSettings = previousSettings;
    const cleanupStarted = createDeferred();
    const releaseCleanup = createDeferred();
    const service = new SettingsCatalogService({
      /** 全体の実行なしで認証変更を開始する。 */
      hasInFlightSessionRuns: () => false,
      /** 認証変更を待たせる既存ターンを持たせず、後処理だけを待つ。 */
      isSessionRunInFlight: () => false,
      /** セッション開始済みの判定を使わない。 */
      isRunningSession: () => false,
      /** スレッド無効化が発生する対象 Main の一覧を返す。 */
      listSessions: () => [session],
      /** 後処理対象を Main 一件に限定する。 */
      listAuxiliarySessions: () => [],
      /** 直前に書き込んだ認証設定を返す。 */
      getAppSettings: () => savedSettings,
      /** 認証の変更と復元をインメモリで受け付ける。 */
      updateAppSettings: (settings) => {
        savedSettings = settings;
        return settings;
      },
      /** 後処理中も両プロバイダーがカタログ上は利用できる条件にする。 */
      getModelCatalog: () => createCatalogSnapshot(),

      /** 代替の全件保存依存は固定の Main 一覧を返す。 */
      replaceAllSessions: () => [session],

      /** スレッド更新結果を返して後処理まで進める。 */
      updateSessionThreadIfMatches: (input) => ({
        ...session,
        threadId: input.nextThreadId,
      }),
      /** 子のスレッドを更新せず Main に限定する。 */
      updateAuxiliarySessionThreadIfMatches: () => null,
      /** 使用量計測は受付バリアに影響させない。 */
      clearProviderQuotaTelemetry: () => {},
      /** コンテキスト消去の完了は独立の待機点にしない。 */
      clearSessionContextTelemetry: () => {},
      /** 受付の制限を観測できるよう後処理を止め、解放時に例外を返す。 */
      invalidateProviderSessionThread: async () => {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
        throw new Error("cleanup failed");
      },
      /** 状態の配信ではなく実行受付の可否を直接見る。 */
      broadcastSessions: () => {},
      /** 設定の書き込み後に実配信を行わない。 */
      broadcastAppSettings: () => {},
      /** モデル一覧を実画面へ配信しない。 */
      broadcastModelCatalog: () => {},
    });

    const updating = service.updateAppSettings({
      ...previousSettings,
      codingProviderSettings: {
        ...previousSettings.codingProviderSettings,
        codex: {
          ...previousSettings.codingProviderSettings.codex,
          apiKey: "changed-key",
        },
      },
    });
    await cleanupStarted.promise;
    assert.throws(
      () => service.assertProviderAvailableForTurn("codex"),
      /A provider settings update is in progress/,
    );
    assert.doesNotThrow(() =>
      service.assertProviderAvailableForTurn("copilot"),
    );
    releaseCleanup.resolve();
    await assert.rejects(() => updating);
    assert.doesNotThrow(() => service.assertProviderAvailableForTurn("codex"));
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "storage交換またはappSettings-only reset後は設定が更新結果と同値でも旧credentialをrollbackしない"
  // fault = "storage owner交換や同一ownerでのreset後に旧credentialをrollbackする"
  // observable = "reset後の設定値、更新回数、rollback拒否原因"
  // observation_boundary = "component-behavior"
  // scope = "settings-rollback-reset-epoch"
  // oracle = { type = "contract", ref = "docs/design/electron-session-store.md#settingscatalogservice" }
  // lifecycle = "permanent"
  // impact = "database reset後へ旧credentialを再導入する"
  // distinction = "同値の設定を持つstorage交換と同一ownerのresetを分け、値のCASだけでは防げない旧rollbackを確認する"
  // @end-test-value
  /** ストア交代または設定だけのリセット後は、値が更新結果と同じでも旧認証情報を復元せず、追加書き込みを拒否する。 */
  it("appSettings-only reset後のsettings rollbackを拒否する", async () => {
    for (const invalidation of ["owner", "settings-reset"] as const) {
      const previous: AppSettings = {
        ...createDefaultAppSettings(),
        codingProviderSettings: {
          ...createDefaultAppSettings().codingProviderSettings,
          codex: {
            ...createDefaultAppSettings().codingProviderSettings.codex,
            apiKey: "old-key",
          },
        },
      };
      const resetSettings = createDefaultAppSettings();
      const session = createSession();
      let current = previous;
      let updateCount = 0;
      let storageGeneration = 1;
      const cleanupStarted = createDeferred();
      const releaseCleanup = createDeferred();
      const service = new SettingsCatalogService({
        /** 世代交代や設定初期化で変わり得る保存済み設定を読み取る。 */
        getAppSettings: () => current,
        /** 設定の書き込みを数え、旧処理のロールバックによる余分な書き込みを検出する。 */
        updateAppSettings: (settings) => {
          updateCount += 1;
          current = settings;
          return settings;
        },
        /** 初期化を妨げる全体の実行はない状態にする。 */
        hasInFlightSessionRuns: () => false,
        /** 認証変更時に個別ターンが実行中でないと返す。 */
        isSessionRunInFlight: () => false,
        /** セッションが停止中の状態を返す。 */
        isRunningSession: () => false,
        /** 後処理が必要なスレッドを持つ Main を返す。 */
        listSessions: () => [session],
        /** 後処理の待機を Main に限定する。 */
        listAuxiliarySessions: () => [],
        /** 設定リセット後も参照できるモデル一覧を返す。 */
        getModelCatalog: () => createCatalogSnapshot(),

        /** 会話一覧を変更しない設定だけのリセットとして代替依存を用意する。 */
        replaceAllSessions: () => [],
        /** 個別の使用量を消去する外部サービスを持たない。 */
        clearProviderQuotaTelemetry: () => {},
        /** コンテキスト消去の結果を検証対象に含めない。 */
        clearSessionContextTelemetry: () => {},
        /** 世代変更か設定リセットを挟めるよう後処理を保留し、解放時に失敗させる。 */
        invalidateProviderSessionThread: async () => {
          cleanupStarted.resolve();
          await releaseCleanup.promise;
          throw new Error("cleanup failed");
        },
        /** 設定リセット時の会話配信は実行しない。 */
        broadcastSessions: () => {},
        /** ロールバックが走ったかは書き込み回数で観測し、設定配信は使わない。 */
        broadcastAppSettings: () => {},
        /** カタログ再配信の副作用は発生させない。 */
        broadcastModelCatalog: () => {},
        /** 更新開始時に参照するストア世代を返す。 */
        captureStorageIdentity: () => storageGeneration,
        /** 捕捉した世代が現行であるときだけ旧処理の継続を許す。 */
        isStorageIdentityCurrent: (identity) => identity === storageGeneration,
        /** 一時ストアに既定設定を適用して設定だけのリセットを模擬する。 */
        resetAppSettings: () => {
          current = resetSettings;
          return current;
        },
        /** リセットの全使用量消去に実計測を使わない。 */
        clearAllProviderQuotaTelemetry: () => {},
        /** 全コンテキストの消去に外部データを使わない。 */
        clearAllSessionContextTelemetry: () => {},
        /** リセット対象を閉じる実ウィンドウを用意しない。 */
        closeResetTargetWindows: () => {},
        /** フィクスチャは実セッションランタイムを初期化しない。 */
        resetSessionRuntime: () => {},
        /** 初期化後のモデル一覧だけを返し、実 DB を作らない。 */
        recreateDatabaseFile: async () => createCatalogSnapshot(),
      });
      const updating = service.updateAppSettings(resetSettings);
      await cleanupStarted.promise;
      assert.deepEqual(current, resetSettings);
      const rejection = assert.rejects(updating, (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(
          String(error.errors[1]),
          invalidation === "owner"
            ? /Saved data changed/
            : /Rollback was canceled because a reset started/,
        );
        return true;
      });
      if (invalidation === "owner") {
        storageGeneration += 1;
        current = structuredClone(resetSettings);
      } else {
        await service.resetAppDatabase({ targets: ["appSettings"] });
      }
      assert.deepEqual(current, resetSettings);
      releaseCleanup.resolve();
      await rejection;
      assert.deepEqual(current, resetSettings);
      assert.equal(updateCount, 1);
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "cleanup失敗rollback後はsettingsを再broadcastし、Auxiliary単独更新も親Sessionへ通知する"
  // fault = "成功側broadcast後のrollbackで永続値だけ戻しrenderer投影を更新しない"
  // observable = "更新とrollbackのsettings、およびAuxiliaryの親Session IDへの通知"
  // observation_boundary = "component-behavior"
  // scope = "settings-rollback-rebroadcast"
  // oracle = { type = "contract", ref = "docs/design/electron-session-store.md#settingscatalogservice" }
  // lifecycle = "permanent"
  // impact = "rendererが保存されていないcredentialを表示し続ける"
  // distinction = "cleanup失敗を伝播しつつrollback後の正本broadcastを確認する"
  // @end-test-value
  /** 後処理の失敗後は復元した設定を再配信し、Auxiliary のスレッド更新と復元の両方を親へ通知する。 */
  it("settings rollback後に正本を再broadcastする", async () => {
    const previous = createDefaultAppSettings();
    const session = createSession({ provider: "copilot" });
    const auxiliary = createAuxiliarySession({ parentSessionId: session.id });
    let current = previous;
    const broadcasted: AppSettings[] = [];
    const sessionNotifications: string[][] = [];
    const service = new SettingsCatalogService({
      /** 更新・復元に伴って変わる現在の設定を返す。 */
      getAppSettings: () => current,
      /** 認証情報の変更と復元を同じ変数に保存する。 */
      updateAppSettings: (settings) => {
        current = settings;
        return settings;
      },
      /** 全体の実行による拒否は発生させない。 */
      hasInFlightSessionRuns: () => false,
      /** 対象の子に実行中ターンはない状態にする。 */
      isSessionRunInFlight: () => false,
      /** 親子とも停止状態として後処理まで進める。 */
      isRunningSession: () => false,
      /** 認証変更の対象外プロバイダーを使う親を返す。 */
      listSessions: () => [session],
      /** 認証変更の対象プロバイダーを使う子を返す。 */
      listAuxiliarySessions: () => [auxiliary],
      /** 親と子の両プロバイダーを含む一覧を返す。 */
      getModelCatalog: () => createCatalogSnapshot(),

      /** 会話の全置換結果は用意しない。 */
      replaceAllSessions: () => [],
      /** 使用量の消去を追加の失敗要因にしない。 */
      clearProviderQuotaTelemetry: () => {},
      /** セッション計測は配信順序の比較から外す。 */
      clearSessionContextTelemetry: () => {},
      /** 成功通知が出た後の後処理を失敗させ、復元の経路を通す。 */
      invalidateProviderSessionThread: async () => {
        throw new Error("cleanup failed");
      },
      /** スレッド更新と復元を配信した親 ID の一覧を記録する。 */
      broadcastSessions: (ids) => {
        sessionNotifications.push(ids ? [...ids] : []);
      },
      /** 更新直後と失敗後に通知した設定を順に保持する。 */
      broadcastAppSettings: (settings) => {
        broadcasted.push(settings ?? current);
      },
      /** モデルの再配信は設定通知の記録に含めない。 */
      broadcastModelCatalog: () => {},
    });
    await assert.rejects(
      service.updateAppSettings({
        ...previous,
        codingProviderSettings: {
          ...previous.codingProviderSettings,
          codex: {
            ...previous.codingProviderSettings.codex,
            apiKey: "new-key",
          },
        },
      }),
      /cleanup failed/,
    );
    assert.equal(broadcasted.length, 2);
    assert.equal(broadcasted[0].codingProviderSettings.codex.apiKey, "new-key");
    assert.deepEqual(broadcasted.at(-1), previous);
    assert.deepEqual(current, previous);
    assert.deepEqual(sessionNotifications, [[session.id], [session.id]]);
    assert.equal(auxiliary.threadId, "aux-thread-1");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "同一providerの重複cleanupは最後のoperation完了までadmissionを保持し、最後の解放時だけ待機Turnへ通知する"
  // fault = "先行cleanup中に後続cleanupの完了でTurnを許可・通知するか、最後の解放を通知せずqueueを停止する"
  // observable = "重複cleanup完了順序、provider admission、解放通知providerと通知時の利用可否"
  // observation_boundary = "component-behavior"
  // scope = "provider-cleanup-admission-overlap"
  // oracle = { type = "contract", ref = "docs/design/electron-session-store.md#settingscatalogservice" }
  // lifecycle = "permanent"
  // impact = "旧cleanupが後続Turnのthreadを無効化する"
  // distinction = "同一providerのin-flight countをoperation単位で保持する"
  // @end-test-value
  /** 同じプロバイダーの後処理が重なると、後発が先に終わっても受付を保持し、最後の終了時だけ利用可能を通知する。 */
  it("重複cleanupの最後までprovider admissionを保持する", async () => {
    const previous = createDefaultAppSettings();
    const session = createSession();
    let current = previous;
    let cleanupCount = 0;
    const available: Array<{ provider: string; admitted: boolean }> = [];
    const firstCleanup = createDeferred();
    const firstCleanupRelease = createDeferred();
    const service = new SettingsCatalogService({
      /** 受付再開時の通知先と、その場で本当に受付可能かを記録する。 */
      onProviderTurnAvailable: (provider) => {
        available.push({
          provider,
          admitted: service.isProviderAvailableForTurn(provider),
        });
      },
      /** 二件の認証変更の間に最新設定を参照できるようにする。 */
      getAppSettings: () => current,
      /** 両方の認証更新を同じ設定保存先に適用する。 */
      updateAppSettings: (settings) => {
        current = settings;
        return settings;
      },
      /** 既存の実行を用意せず後処理同士の競合に限定する。 */
      hasInFlightSessionRuns: () => false,
      /** 既存ターン ID による受付拒否は発生させない。 */
      isSessionRunInFlight: () => false,
      /** 実行中の会話がない値を返す。 */
      isRunningSession: () => false,
      /** 同一プロバイダーの後処理を二回発生させる Main を返す。 */
      listSessions: () => [session],
      /** 複数の後処理は発行する操作の数で作り、子は使わない。 */
      listAuxiliarySessions: () => [],
      /** 影響を受けない Copilot も含むモデル一覧を返す。 */
      getModelCatalog: () => createCatalogSnapshot(),

      /** 会話全体の書き換えは行わない代替依存を用意する。 */
      replaceAllSessions: () => [],
      /** 受付バリアのテストで使用量は記録しない。 */
      clearProviderQuotaTelemetry: () => {},
      /** コンテキスト消去では個別処理を待機させない。 */
      clearSessionContextTelemetry: () => {},
      /** 初回の後処理だけを保留し、後発の完了後に失敗させる。 */
      invalidateProviderSessionThread: async () => {
        cleanupCount += 1;
        if (cleanupCount === 1) {
          firstCleanup.resolve();
          await firstCleanupRelease.promise;
          throw new Error("first cleanup failed");
        }
      },
      /** 会話配信でなく受付の可否から競合を判定する。 */
      broadcastSessions: () => {},
      /** 設定は保存先から比較し、通知は記録しない。 */
      broadcastAppSettings: () => {},
      /** モデル一覧の配信は実行しない。 */
      broadcastModelCatalog: () => {},
    });
    const first = service.updateAppSettings({
      ...previous,
      codingProviderSettings: {
        ...previous.codingProviderSettings,
        codex: { ...previous.codingProviderSettings.codex, apiKey: "first" },
      },
    });
    await firstCleanup.promise;
    const second = service.updateAppSettings({
      ...current,
      codingProviderSettings: {
        ...current.codingProviderSettings,
        codex: { ...current.codingProviderSettings.codex, apiKey: "second" },
      },
    });
    await second;
    assert.deepEqual(available, []);
    assert.equal(service.isProviderAvailableForTurn("codex"), false);
    assert.throws(
      () => service.assertProviderAvailableForTurn("codex"),
      /A provider settings update is in progress/,
    );
    assert.doesNotThrow(() =>
      service.assertProviderAvailableForTurn("copilot"),
    );
    firstCleanupRelease.resolve();
    await assert.rejects(first);
    assert.doesNotThrow(() => service.assertProviderAvailableForTurn("codex"));
    assert.deepEqual(available, [{ provider: "codex", admitted: true }]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "結果不明の credential thread patch を reverse せず元エラーとして伝播する"
  // fault = "write-then-throw を成功または推測 rollback として扱う"
  // observable = "元エラー、settings、thread、reverse 呼出し"
  // observation_boundary = "component-behavior"
  // scope = "settings-unknown-write"
  // oracle = { type = "contract", ref = "docs/design/electron-session-store.md#settingscatalogservice" }
  // lifecycle = "permanent"
  // impact = "結果不明の thread を誤って再利用・上書きする"
  // distinction = "成功戻り CAS の rollback ではなく結果不明 write を確認する"
  // @end-test-value
  /** スレッド書き込み後に結果不明のエラーが返った場合は推測で逆更新せず、設定は戻して元の失敗を伝える。 */
  it("credential更新の結果不明patchはreverseせず元errorを伝播する", async () => {
    const previousSettings = createDefaultAppSettings();
    const main = createSession();
    let savedSettings = previousSettings;
    let reverseCalls = 0;
    const service = new SettingsCatalogService({
      /** 全体の実行を止め、書き込み結果不明の経路へ進める。 */
      hasInFlightSessionRuns: () => false,
      /** 該当する個別ターンは実行中でないと返す。 */
      isSessionRunInFlight: () => false,
      /** 会話を停止状態として条件付き書き込みを許可する。 */
      isRunningSession: () => false,
      /** 結果不明の書き込みを受ける Main を返す。 */
      listSessions: () => [main],
      /** 書き込み結果が不明になる行を Main 一件に限定する。 */
      listAuxiliarySessions: () => [],
      /** 設定の復元を比較するため最後の保存値を返す。 */
      getAppSettings: () => savedSettings,
      /** スレッド保存とは別に設定の変更・復元を記録する。 */
      updateAppSettings: (settings) => {
        savedSettings = settings;
        return settings;
      },
      /** 設定変更が必要なプロバイダーを含む一覧を返す。 */
      getModelCatalog: () => createCatalogSnapshot(),

      /** 行単位の不明な書き込みを全件置換で補った場合に失敗させる。 */
      replaceAllSessions: () => {
        throw new Error("must use thread patch");
      },

      /** スレッドを書き換えてから例外を投げ、もし逆向きの操作を試みたら記録する。 */
      updateSessionThreadIfMatches: (input) => {
        if (input.expectedThreadId === "") reverseCalls += 1;
        main.threadId = input.nextThreadId;
        throw new Error("write result unknown");
      },
      /** 子のスレッドに一致する行はないと返す。 */
      updateAuxiliarySessionThreadIfMatches: () => null,
      /** 使用量の外部消去を失敗条件にしない。 */
      clearProviderQuotaTelemetry: () => {},
      /** コンテキスト計測の消去は観測しない。 */
      clearSessionContextTelemetry: () => {},
      /** スレッド更新後の実ランタイム処理では例外を追加しない。 */
      invalidateProviderSessionThread: () => {},
      /** 書き込み結果は実通知でなく行と呼び出し数で比較する。 */
      broadcastSessions: () => {},
      /** 更新・復元した設定は保存値から比較する。 */
      broadcastAppSettings: () => {},
      /** モデル一覧通知は書き込みの失敗と独立させる。 */
      broadcastModelCatalog: () => {},
    });

    await assert.rejects(
      () =>
        service.updateAppSettings({
          ...previousSettings,
          codingProviderSettings: {
            ...previousSettings.codingProviderSettings,
            codex: {
              ...previousSettings.codingProviderSettings.codex,
              apiKey: "changed-key",
            },
          },
        }),
      /write result unknown/,
    );
    assert.equal(savedSettings.codingProviderSettings.codex.apiKey, "");
    assert.equal(main.threadId, "");
    assert.equal(reverseCalls, 0);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Sessionsを含むpartial/full DB resetは親SessionとAuxiliaryの通知を永続化成功後に閉じる"
  // oracle = { type = "adr", ref = "docs/adr/006-windows-session-turn-notifications.md" }
  // fault = "reset失敗前に通知を閉じる、または成功したSessions reset後もAuxiliary通知を開いたままにする"
  // observable = "dismissSessionTurnNotificationへ渡されたIDと呼び出し順"
  // observation_boundary = "component-behavior"
  // scope = "settings-session-reset-notification-cleanup"
  // lifecycle = "permanent"
  // distinction = "Session単体削除とは異なるDB resetのpartial/full分岐で、保存成功後の親・Auxiliary通知撤去を検証する"
  // @end-test-value
  /** 部分リセットと全 DB リセットのどちらも、保存が成功した後にだけ全親子のターン通知を閉じる。 */
  it("session の partial/full reset は永続化成功後に全通知を閉じる", async () => {
    let sessions = [
      { ...createSession(), id: "session-partial-1" },
      { ...createSession(), id: "session-partial-2" },
    ];
    let auxiliarySessions = [
      createAuxiliarySession({
        id: "aux-partial-1",
        parentSessionId: "session-partial-1",
      }),
      createAuxiliarySession({
        id: "aux-partial-2",
        parentSessionId: "session-partial-2",
      }),
    ];
    const calls: string[] = [];
    const firstReplacementStarted = createDeferred();
    const rejectFirstReplacement = createDeferred();
    const firstRecreateStarted = createDeferred();
    const rejectFirstRecreate = createDeferred();
    let replaceCallCount = 0;
    let recreateCallCount = 0;
    const service = new SettingsCatalogService({
      /** 実行中の処理による初期化の拒否は発生させない。 */
      hasInFlightSessionRuns() {
        return false;
      },
      /** リセット対象の個別ターンが動作していない条件にする。 */
      isSessionRunInFlight() {
        return false;
      },
      /** リセット時点で各セッションは停止していると返す。 */
      isRunningSession() {
        return false;
      },
      /** 初期化対象の親一覧を、部分・全体の試行ごとの値で返す。 */
      listSessions() {
        return sessions;
      },
      /** ターン通知を撤去すべき子の一覧を返す。 */
      listAuxiliarySessions() {
        return auxiliarySessions;
      },
      /** 設定リセットに使う既定の設定を返す。 */
      getAppSettings() {
        return createDefaultAppSettings();
      },
      /** 設定を書き込む場合は同じ値を返す代替依存を用意する。 */
      updateAppSettings(settings) {
        return settings;
      },
      /** 全リセット後に通知できるモデル一覧を返す。 */
      getModelCatalog() {
        return createCatalogSnapshot();
      },

      /** 部分リセットの全件置換を記録し、一度目だけ通知を閉じる前に失敗させる。 */
      async replaceAllSessions(nextSessions) {
        replaceCallCount += 1;
        calls.push(`replace:${nextSessions.length}`);
        if (replaceCallCount === 1) {
          firstReplacementStarted.resolve();
          await rejectFirstReplacement.promise;
          throw new Error("replace sessions failed");
        }
        sessions = nextSessions;
        return nextSessions;
      },

      /** 個別プロバイダーの使用量消去が呼ばれた順序を記録する。 */
      clearProviderQuotaTelemetry(providerId) {
        calls.push(`clearQuota:${providerId}`);
      },
      /** 個別セッションのコンテキスト消去要求を ID とともに記録する。 */
      clearSessionContextTelemetry(sessionId) {
        calls.push(`clearContext:${sessionId}`);
      },
      /** 個別のスレッド無効化が発生した場合の対象を記録する。 */
      invalidateProviderSessionThread(providerId, sessionId) {
        calls.push(`invalidate:${providerId}:${sessionId}`);
      },
      /** 設定だけの初期化が呼ばれた場合は、その順序を記録して既定値を返す。 */
      resetAppSettings() {
        calls.push("resetAppSettings");
        return createDefaultAppSettings();
      },

      /** セッションを消した後にランタイムが初期化された時点を記録する。 */
      resetSessionRuntime() {
        calls.push("resetRuntime");
      },
      /** 全 DB 再作成後の使用量一括消去を記録する。 */
      clearAllProviderQuotaTelemetry() {
        calls.push("clearAllQuota");
      },
      /** 全 DB 再作成後のコンテキスト一括消去を記録する。 */
      clearAllSessionContextTelemetry() {
        calls.push("clearAllContext");
      },
      /** 会話初期化後に全プロバイダーのスレッドを無効化した時点を記録する。 */
      invalidateAllProviderSessionThreads() {
        calls.push("invalidateAllThreads");
      },
      /** 準備段階でのウィンドウ閉鎖を、保存成功後の通知撤去と区別して記録する。 */
      closeResetTargetWindows() {
        calls.push("closeResetWindows");
      },
      /** 実際に閉じるターン通知の識別子を親子ごとに記録する。 */
      dismissSessionTurnNotification(sessionId) {
        calls.push(`dismissNotification:${sessionId}`);
      },
      /** 初回だけ DB 再作成を待機後に失敗させ、再試行では会話を消してカタログを返す。 */
      async recreateDatabaseFile() {
        recreateCallCount += 1;
        calls.push("recreateDb");
        if (recreateCallCount === 1) {
          firstRecreateStarted.resolve();
          await rejectFirstRecreate.promise;
          throw new Error("recreate database failed");
        }
        sessions = [];
        return createCatalogSnapshot();
      },
      /** 会話一覧の再配信が初期化のどの段階で行われたか記録する。 */
      broadcastSessions() {
        calls.push("broadcastSessions");
      },
      /** 設定が再配信された順序を記録する。 */
      broadcastAppSettings() {
        calls.push("broadcastSettings");
      },
      /** カタログの再配信が後処理の後に行われたかを記録する。 */
      broadcastModelCatalog() {
        calls.push("broadcastCatalog");
      },
    });

    const failedPartialReset = service.resetAppDatabase({
      targets: ["sessions"],
    });
    await firstReplacementStarted.promise;
    assert.equal(
      calls.some((call) => call.startsWith("dismissNotification:")),
      false,
    );
    rejectFirstReplacement.resolve();
    await assert.rejects(failedPartialReset, /replace sessions failed/);
    assert.deepEqual(calls, ["closeResetWindows", "replace:0"]);

    calls.length = 0;
    const result = await service.resetAppDatabase({
      targets: ["sessions"],
    });

    assert.deepEqual(result.resetTargets, ["sessions"]);
    assert.deepEqual(calls, [
      "closeResetWindows",
      "replace:0",
      "dismissNotification:session-partial-1",
      "dismissNotification:session-partial-2",
      "dismissNotification:aux-partial-1",
      "dismissNotification:aux-partial-2",
      "resetRuntime",
      "invalidateAllThreads",
      "broadcastSessions",
      "broadcastSettings",
      "broadcastCatalog",
    ]);

    calls.length = 0;
    sessions = [
      { ...createSession(), id: "session-full-1" },
      { ...createSession(), id: "session-full-2" },
    ];
    auxiliarySessions = [
      createAuxiliarySession({
        id: "aux-full-1",
        parentSessionId: "session-full-1",
      }),
      createAuxiliarySession({
        id: "aux-full-2",
        parentSessionId: "session-full-2",
      }),
    ];

    const failedFullReset = service.resetAppDatabase();
    await firstRecreateStarted.promise;
    assert.equal(
      calls.some((call) => call.startsWith("dismissNotification:")),
      false,
    );
    rejectFirstRecreate.resolve();
    await assert.rejects(failedFullReset, /recreate database failed/);
    assert.deepEqual(calls, ["closeResetWindows", "recreateDb"]);

    calls.length = 0;
    const fullResult = await service.resetAppDatabase();

    assert.deepEqual(fullResult.resetTargets, ["sessions", "appSettings"]);
    assert.deepEqual(calls, [
      "closeResetWindows",
      "recreateDb",
      "dismissNotification:session-full-1",
      "dismissNotification:session-full-2",
      "dismissNotification:aux-full-1",
      "dismissNotification:aux-full-2",
      "resetRuntime",
      "invalidateAllThreads",
      "clearAllQuota",
      "clearAllContext",
      "broadcastSessions",
      "broadcastSettings",
      "broadcastCatalog",
    ]);
  });
});

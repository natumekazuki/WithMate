import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { Session } from "../../src-shared/session/session-state.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { createDefaultAppSettings, type AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import { getSessionIncarnationId } from "../../src-shared/session/session-state.js";
import type { SessionThreadPatchInput } from "../../src-electron/session/session-storage-v6.js";
import type { AuxiliarySessionThreadPatchInput } from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import { AppSettingsStorage } from "../../src-electron/app/app-settings-storage.js";
import { SettingsCatalogService as SettingsCatalogServiceImpl } from "../../src-electron/settings/settings-catalog-service.js";
import type { SettingsCatalogServiceDeps } from "../../src-electron/settings/settings-catalog-service.js";

type SettingsCatalogDeps = SettingsCatalogServiceDeps;
type DefaultedSettingsCatalogDependency =
  | "updateChatLayoutPreference"
  | "runProviderRuntimeOperationExclusive"
  | "listSessionCredentialThreads"
  | "listAuxiliaryCredentialThreads"
  | "updateSessionThreadIfMatches"
  | "updateAuxiliarySessionThreadIfMatches"
  | "replaceAllSessions"
  | "resetAppSettings"
  | "clearProjectMemories"
  | "resetSessionRuntime"
  | "clearAllProviderQuotaTelemetry"
  | "clearAllSessionContextTelemetry"
  | "clearAllSessionBackgroundActivities"
  | "invalidateAllProviderSessionThreads"
  | "closeResetTargetWindows"
  | "dismissSessionTurnNotification"
  | "recreateDatabaseFile";
type SettingsCatalogTestDeps = Omit<SettingsCatalogDeps, DefaultedSettingsCatalogDependency>
  & Partial<Pick<SettingsCatalogDeps, DefaultedSettingsCatalogDependency>>;

const defaultSettingsCatalogDependencies: Pick<SettingsCatalogDeps, DefaultedSettingsCatalogDependency> = {
  updateChatLayoutPreference() {},
  runProviderRuntimeOperationExclusive: async (operation) => await operation(),
  listSessionCredentialThreads: async () => { throw new Error("unexpected listSessionCredentialThreads"); },
  listAuxiliaryCredentialThreads: async () => { throw new Error("unexpected listAuxiliaryCredentialThreads"); },
  updateSessionThreadIfMatches: async () => { throw new Error("unexpected updateSessionThreadIfMatches"); },
  updateAuxiliarySessionThreadIfMatches: async () => { throw new Error("unexpected updateAuxiliarySessionThreadIfMatches"); },
  replaceAllSessions: async () => { throw new Error("unexpected replaceAllSessions"); },
  resetAppSettings: async () => { throw new Error("unexpected resetAppSettings"); },
  clearProjectMemories: () => { throw new Error("unexpected clearProjectMemories"); },
  resetSessionRuntime: () => { throw new Error("unexpected resetSessionRuntime"); },
  clearAllProviderQuotaTelemetry: () => { throw new Error("unexpected clearAllProviderQuotaTelemetry"); },
  clearAllSessionContextTelemetry: () => { throw new Error("unexpected clearAllSessionContextTelemetry"); },
  clearAllSessionBackgroundActivities: () => { throw new Error("unexpected clearAllSessionBackgroundActivities"); },
  invalidateAllProviderSessionThreads: async () => { throw new Error("unexpected invalidateAllProviderSessionThreads"); },
  closeResetTargetWindows: () => { throw new Error("unexpected closeResetTargetWindows"); },
  dismissSessionTurnNotification: () => { throw new Error("unexpected dismissSessionTurnNotification"); },
  recreateDatabaseFile: async () => { throw new Error("unexpected recreateDatabaseFile"); },
};

class SettingsCatalogService extends SettingsCatalogServiceImpl {
  constructor(deps: SettingsCatalogTestDeps) {
    const completeDeps: SettingsCatalogDeps = {
      ...defaultSettingsCatalogDependencies,
      ...deps,
      listSessionCredentialThreads: deps.listSessionCredentialThreads ?? (async () =>
        (await deps.listSessions()).map((session) => ({
          id: session.id,
          incarnationId: getSessionIncarnationId(session),
          provider: session.provider,
          threadId: session.threadId,
          status: session.status,
          runState: session.runState,
        }))),
      listAuxiliaryCredentialThreads: deps.listAuxiliaryCredentialThreads ?? (async () =>
        (await deps.listAuxiliarySessions()).map((session) => ({
          id: session.id,
          parentSessionId: session.parentSessionId,
          createdAt: session.createdAt,
          provider: session.provider,
          threadId: session.threadId,
          runState: session.runState,
        }))),
      updateSessionThreadIfMatches: deps.updateSessionThreadIfMatches ?? (async (input: SessionThreadPatchInput) => {
        const sessions = await deps.listSessions();
        const target = sessions.find((session) =>
          session.id === input.sessionId
          && getSessionIncarnationId(session) === input.incarnationId
          && session.provider === input.provider
          && session.threadId === input.expectedThreadId,
        );
        if (!target) return null;
        const next = { ...target, threadId: input.nextThreadId, updatedAt: input.updatedAt };
        if (deps.replaceAllSessions) {
          const replaced = await deps.replaceAllSessions(sessions.map((session) => session.id === next.id ? next : session), { broadcast: false });
          return replaced.find((session) => session.id === next.id) ?? next;
        }
        Object.assign(target, next);
        return next;
      }),
      updateAuxiliarySessionThreadIfMatches: deps.updateAuxiliarySessionThreadIfMatches ?? (async (input: AuxiliarySessionThreadPatchInput) => {
        const sessions = await deps.listAuxiliarySessions();
        const target = sessions.find((session) =>
          session.id === input.auxiliarySessionId
          && session.parentSessionId === input.parentSessionId
          && session.provider === input.provider
          && session.threadId === input.expectedThreadId
          && (input.createdAt === undefined || session.createdAt === input.createdAt),
        );
        if (!target) return null;
        const next = { ...target, threadId: input.nextThreadId, updatedAt: input.updatedAt };

        Object.assign(target, next);
        return next;
      }),
    };
    super(completeDeps);
  }
}

function createDeferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

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

function createAuxiliarySession(overrides?: Partial<AuxiliarySession>): AuxiliarySession {
  return {
    id: "aux-1",
    parentSessionId: "session-1",
    status: "active",
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
    closedAt: "",
    ...overrides,
  };
}

function createCatalogSnapshot(): ModelCatalogSnapshot {
  return {
    providers: [
      {
        id: "codex",
        label: "Codex",
        defaultModelId: "gpt-5.4",
        defaultReasoningEffort: "high",
        models: [
          { id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["medium", "high"] },
          { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", reasoningEfforts: ["low", "medium"] },
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

describe("SettingsCatalogService", () => {

  // @test-value v2
  // kind = "contract"
  // claim = "任意のchat layout checkpointが保留・失敗しDB読込応答が遅れても、再読込・Settings保存・表示設定以外のresetは現在の表示選択を返す"
  // oracle = { type = "contract", ref = "docs/design/electron-session-store.md#settingscatalogservice" }
  // fault = "再open時やSettings保存結果がDBの旧layoutへ戻る、またはcheckpoint失敗を診断できない"
  // observable = "serviceのsettings projection、broadcast、DB値、失敗診断"
  // observation_boundary = "public-boundary"
  // scope = "settings-catalog-chat-layout-current"
  // lifecycle = "permanent"
  // impact = "保存失敗によって利用者が選択した表示が同一アプリ内の再表示で失われる"
  // distinction = "Renderer局所stateとSQLite単体testでは検出できないMainの現在値projectionを確認する"
  // @end-test-value
  it("chat layout checkpoint が失敗しても再読込とSettings保存は現在値を維持する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-layout-current-"));
    const storage = new AppSettingsStorage(path.join(tempDirectory, "withmate.db"));
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
        hasInFlightSessionRuns: () => false,
        isSessionRunInFlight: () => false,
        isRunningSession: () => false,
        listSessions: () => [],
        listAuxiliarySessions: () => [],
        async getAppSettings() {
          const snapshot = storage.getSettings();
          if (delayNextRead) {
            delayNextRead = false;
            delayedReadStarted.resolve();
            await releaseDelayedRead.promise;
          }
          return snapshot;
        },
        updateAppSettings: (settings) => storage.updateSettings(settings),
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
        onChatLayoutPreferenceSaveError(update, error) {
          diagnostics.push(`${update.target}: ${String(error)}`);
          diagnosticReceived.resolve();
        },
        clearProjectMemories: () => {},
        getModelCatalog: () => createCatalogSnapshot(),

        clearProviderQuotaTelemetry: () => {},
        clearSessionContextTelemetry: () => {},
        invalidateProviderSessionThread: () => {},
        broadcastSessions: () => {},
        broadcastAppSettings: (settings) => { if (settings) broadcasts.push(settings); },
        broadcastModelCatalog: () => {},
      });

      service.updateChatLayoutPreference({ target: "header", value: "visible" });
      await writeStarted.promise;
      assert.equal((await service.getAppSettings()).chatLayoutPreference.header, "visible");
      assert.equal(storage.getSettings().chatLayoutPreference.header, "hidden");

      const saved = await service.updateAppSettings({ ...storage.getSettings(), launchAtLoginEnabled: true });
      assert.equal(saved.chatLayoutPreference.header, "visible");
      assert.equal(broadcasts.at(-1)?.chatLayoutPreference.header, "visible");
      assert.equal(storage.getSettings().chatLayoutPreference.header, "hidden");

      rejectWrite.resolve();
      await diagnosticReceived.promise;
      assert.match(diagnostics[0] ?? "", /header: Error: checkpoint failed: header/);
      assert.equal((await service.getAppSettings()).chatLayoutPreference.header, "visible");
      assert.equal(storage.getSettings().chatLayoutPreference.header, "hidden");

      const reset = await service.resetAppDatabase({ targets: ["projectMemory"] });
      assert.equal(reset.appSettings.chatLayoutPreference.header, "visible");
      assert.equal(broadcasts.at(-1)?.chatLayoutPreference.header, "visible");

      service.updateChatLayoutPreference({ target: "header", value: "visible" });
      service.updateChatLayoutPreference({ target: "header", value: "hidden" });
      service.updateChatLayoutPreference({ target: "header", value: "visible" });
      allowRetryWrite.resolve();
      await secondWriteCompleted.promise;
      assert.equal(storage.getSettings().chatLayoutPreference.header, "hidden");
      assert.equal((await service.getAppSettings()).chatLayoutPreference.header, "visible");
      allowFinalWrite.resolve();
      await finalWriteCompleted.promise;
      assert.equal(storage.getSettings().chatLayoutPreference.header, "visible");

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
  it("App Settings reset は任意chat layout checkpointを待たず旧queueを破棄する", async () => {
    let storedSettings = createDefaultAppSettings();
    let writes = 0;
    const checkpointStarted = createDeferred();
    const releaseCheckpoint = createDeferred();
    const resetReached = createDeferred();
    const failedCheckpointObserved = createDeferred();
    const service = new SettingsCatalogService({
      hasInFlightSessionRuns: () => false,
      isSessionRunInFlight: () => false,
      isRunningSession: () => false,
      listSessions: () => [],
      listAuxiliarySessions: () => [],
      getAppSettings: () => storedSettings,
      updateAppSettings: (settings) => { storedSettings = settings; return settings; },
      async updateChatLayoutPreference() {
        writes += 1;
        checkpointStarted.resolve();
        await releaseCheckpoint.promise;
        throw new Error("checkpoint unavailable");
      },
      onChatLayoutPreferenceSaveError: () => failedCheckpointObserved.resolve(),
      resetAppSettings: () => {
        storedSettings = createDefaultAppSettings();
        resetReached.resolve();
        return storedSettings;
      },
      getModelCatalog: () => createCatalogSnapshot(),

      clearProviderQuotaTelemetry: () => {},
      clearAllProviderQuotaTelemetry: () => {},
      clearSessionContextTelemetry: () => {},
      invalidateProviderSessionThread: () => {},
      broadcastSessions: () => {},
      broadcastAppSettings: () => {},
      broadcastModelCatalog: () => {},
    });

    service.updateChatLayoutPreference({ target: "header", value: "visible" });
    await checkpointStarted.promise;
    service.updateChatLayoutPreference({ target: "sidePane", value: "context" });
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const reset = service.resetAppDatabase({ targets: ["appSettings"] });
      await Promise.race([
        resetReached.promise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("App Settings reset waited for an optional checkpoint")), 500);
        }),
      ]);
      await reset;
      assert.deepEqual((await service.getAppSettings()).chatLayoutPreference, createDefaultAppSettings().chatLayoutPreference);
    } finally {
      if (timeout) clearTimeout(timeout);
      releaseCheckpoint.resolve();
    }
    await failedCheckpointObserved.promise;
    await Promise.resolve();
    assert.equal(writes, 1);
    assert.deepEqual((await service.getAppSettings()).chatLayoutPreference, createDefaultAppSettings().chatLayoutPreference);
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
  it("旧storage ownerの未dispatch chat layout checkpointは新generationへ送らない", async () => {
    const oldOwner = {};
    let currentOwner = oldOwner;
    const dispatchedOwners: object[] = [];
    const firstWriteStarted = createDeferred();
    const releaseFirstWrite = createDeferred();
    const firstWriteFinished = createDeferred();
    const service = new SettingsCatalogService({
      captureStorageIdentity: () => currentOwner,
      isStorageIdentityCurrent: (identity) => identity === currentOwner,
      hasInFlightSessionRuns: () => false,
      isSessionRunInFlight: () => false,
      isRunningSession: () => false,
      listSessions: () => [],
      listAuxiliarySessions: () => [],
      getAppSettings: () => createDefaultAppSettings(),
      updateAppSettings: (settings) => settings,
      async updateChatLayoutPreference() {
        const dispatchOwner = currentOwner;
        dispatchedOwners.push(dispatchOwner);
        firstWriteStarted.resolve();
        await releaseFirstWrite.promise;
        firstWriteFinished.resolve();
      },
      getModelCatalog: () => createCatalogSnapshot(),

      clearProviderQuotaTelemetry: () => {},
      clearSessionContextTelemetry: () => {},
      invalidateProviderSessionThread: () => {},
      broadcastSessions: () => {},
      broadcastAppSettings: () => {},
      broadcastModelCatalog: () => {},
    });

    service.updateChatLayoutPreference({ target: "header", value: "visible" });
    await firstWriteStarted.promise;
    service.updateChatLayoutPreference({ target: "sidePane", value: "context" });
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
  it("API key 変更対象 provider に実行中 session があると settings 更新を拒否する", async () => {
    for (const running of ["main", "auxiliary", "auxiliary-starting"] as const) {
      const previousSettings = createDefaultAppSettings();
      const session = createSession({ provider: running === "main" ? "codex" : "copilot" });
      const auxiliary = createAuxiliarySession({
        parentSessionId: session.id,
        runState: running === "auxiliary" ? "running" : "idle",
      });
      let writes = 0;
      const service = new SettingsCatalogService({
        hasInFlightSessionRuns: () => false,
        isSessionRunInFlight: (id) => running === "main"
          ? id === session.id
          : running === "auxiliary-starting" && id === auxiliary.id,
        isRunningSession: () => running === "main",
        listSessions: () => [session], listAuxiliarySessions: () => [auxiliary],
        getAppSettings: () => previousSettings,
        updateAppSettings: (settings) => { writes += 1; return settings; },
        getModelCatalog: () => createCatalogSnapshot(),

        replaceAllSessions: () => [],
        clearProviderQuotaTelemetry: () => {}, clearSessionContextTelemetry: () => {},
        invalidateProviderSessionThread: () => {}, broadcastSessions: () => {},
        broadcastAppSettings: () => {}, broadcastModelCatalog: () => {},
      });
      await assert.rejects(service.updateAppSettings({
        ...previousSettings,
        codingProviderSettings: {
          ...previousSettings.codingProviderSettings,
          codex: { ...previousSettings.codingProviderSettings.codex, apiKey: "changed-key" },
        },
      }), /A session is using the provider whose Coding Agent credentials are changing/);
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
  it("待機中の通常 settings 更新は並行して保存された chat layout を巻き戻さない", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-settings-catalog-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    const storage = new AppSettingsStorage(dbPath);
    const auxiliarySessionsRequested = createDeferred();
    const resumeAuxiliarySessions = createDeferred();

    try {
      const previousSettings = storage.getSettings();
      const service = new SettingsCatalogService({
        hasInFlightSessionRuns() {
          return false;
        },
        isSessionRunInFlight() {
          return false;
        },
        isRunningSession() {
          return false;
        },
        listSessions() {
          throw new Error("credential-unchanged settings save must not hydrate Sessions");
        },
        listAuxiliarySessions() {
          throw new Error("credential-unchanged settings save must not hydrate Auxiliary sessions");
        },
        getAppSettings() {
          return storage.getSettings();
        },
        async updateAppSettings(settings) {
          auxiliarySessionsRequested.resolve();
          await resumeAuxiliarySessions.promise;
          return storage.updateSettings(settings);
        },
        getModelCatalog() {
          return createCatalogSnapshot();
        },

        replaceAllSessions(nextSessions) {
          return nextSessions;
        },

        clearProviderQuotaTelemetry() {},
        clearSessionContextTelemetry() {},
        invalidateProviderSessionThread() {},
        broadcastSessions() {},
        broadcastAppSettings() {},
        broadcastModelCatalog() {},
      });

      const updating = service.updateAppSettings({
        ...previousSettings,
        launchAtLoginEnabled: true,
      });
      await auxiliarySessionsRequested.promise;
      storage.updateChatLayoutPreference({ target: "header", value: "visible" });
      storage.updateChatLayoutPreference({ target: "actionDock", value: "expanded" });
      storage.updateChatLayoutPreference({ target: "sidePane", value: "context" });
      resumeAuxiliarySessions.resolve();

      const updated = await updating;

      assert.equal(updated.launchAtLoginEnabled, true);
      assert.deepEqual(updated.chatLayoutPreference, {
        header: "visible",
        actionDock: "expanded",
        sidePane: "context",
      });
      assert.deepEqual(storage.getSettings().chatLayoutPreference, updated.chatLayoutPreference);
    } finally {
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "通常 settings 保存後の layout 更新を最新 projection へ反映する"
  // oracle = { type = "adr", ref = "docs/adr/015-chat-layout-preference-boundary.md" }
  // fault = "保存待機中の layout 更新が broadcast projection から欠落する"
  // observable = "updated/broadcast chatLayoutPreference"
  // observation_boundary = "public-boundary"
  // scope = "settings-catalog-latest-layout"
  // lifecycle = "permanent"
  // impact = "新しい Session Window が古い layout を受け取る"
  // distinction = "保存完了後の最新 layout 反映を確認する"
  // @end-test-value
  it("通常 settings 保存後の待機中に更新された chat layout を最新の projection へ反映する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-settings-catalog-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    const storage = new AppSettingsStorage(dbPath);
    const sessionReplacementStarted = createDeferred();
    const resumeSessionReplacement = createDeferred();
    const broadcast = { settings: null as AppSettings | null };

    try {
      const previousSettings = storage.getSettings();
      const previousSessions = [createSession()];
      const service = new SettingsCatalogService({
        hasInFlightSessionRuns() {
          return false;
        },
        isSessionRunInFlight() {
          return false;
        },
        isRunningSession() {
          return false;
        },
        listSessions() {
          return previousSessions;
        },
        listAuxiliarySessions() {
          return [];
        },
        getAppSettings() {
          return storage.getSettings();
        },
        updateAppSettings(settings) {
          return storage.updateSettings(settings);
        },
        getModelCatalog() {
          return createCatalogSnapshot();
        },

        async updateSessionThreadIfMatches(input) {
          const current = previousSessions[0];
          current.threadId = input.nextThreadId;
          current.updatedAt = input.updatedAt;
          sessionReplacementStarted.resolve();
          await resumeSessionReplacement.promise;
          return { ...current };
        },

        clearProviderQuotaTelemetry() {},
        clearSessionContextTelemetry() {},
        invalidateProviderSessionThread() {},
        broadcastSessions() {},
        broadcastAppSettings(settings) {
          broadcast.settings = settings ?? storage.getSettings();
        },
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
      storage.updateChatLayoutPreference({ target: "header", value: "visible" });
      storage.updateChatLayoutPreference({ target: "actionDock", value: "expanded" });
      storage.updateChatLayoutPreference({ target: "sidePane", value: "files" });
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
      assert.deepEqual(observedBroadcastSettings.chatLayoutPreference, updated.chatLayoutPreference);
      assert.deepEqual(storage.getSettings().chatLayoutPreference, updated.chatLayoutPreference);
    } finally {
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "通常 settings 更新の rollback は並行保存された chat layout を巻き戻さない"
  // oracle = { type = "adr", ref = "docs/adr/015-chat-layout-preference-boundary.md" }
  // fault = "失敗 rollback が最新 layout まで復元前値へ戻す"
  // observable = "rollback 後の chatLayoutPreference"
  // observation_boundary = "public-boundary"
  // scope = "settings-catalog-layout-rollback"
  // lifecycle = "permanent"
  // impact = "layout 操作が失敗した settings 保存に巻き込まれる"
  // distinction = "settings failure と独立した layout persistence を確認する"
  // @end-test-value
  it("通常 settings 更新の rollback は並行して保存された chat layout を巻き戻さない", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-settings-catalog-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    const storage = new AppSettingsStorage(dbPath);
    const firstSessionReplacementStarted = createDeferred();
    const rejectFirstSessionReplacement = createDeferred();
    let replaceCallCount = 0;

    try {
      const previousSettings = storage.getSettings();
      const previousSessions = [createSession()];
      const service = new SettingsCatalogService({
        hasInFlightSessionRuns() {
          return false;
        },
        isSessionRunInFlight() {
          return false;
        },
        isRunningSession() {
          return false;
        },
        listSessions() {
          return previousSessions;
        },
        listAuxiliarySessions() {
          return [];
        },
        getAppSettings() {
          return storage.getSettings();
        },
        updateAppSettings(settings) {
          return storage.updateSettings(settings);
        },
        getModelCatalog() {
          return createCatalogSnapshot();
        },

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

        clearProviderQuotaTelemetry() {},
        clearSessionContextTelemetry() {},
        invalidateProviderSessionThread() {},
        broadcastSessions() {},
        broadcastAppSettings() {},
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
      storage.updateChatLayoutPreference({ target: "header", value: "visible" });
      storage.updateChatLayoutPreference({ target: "actionDock", value: "expanded" });
      storage.updateChatLayoutPreference({ target: "sidePane", value: "context" });
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
  it("settingsのみの失敗 rollback は並行する Session と Auxiliary の更新を巻き戻さない", { timeout: 10_000 }, async () => {
    const previousSettings = createDefaultAppSettings();
    let currentSessions = [{ ...createSession(), provider: "copilot" }];
    let currentAuxiliarySessions = [createAuxiliarySession({ provider: "copilot" })];
    const savedSettingsEntered = createDeferred();
    const savedSettingsResume = createDeferred();
    let savedSettings: AppSettings | null = null;

    const service = new SettingsCatalogService({
      hasInFlightSessionRuns() {
        return false;
      },
      isSessionRunInFlight() {
        return false;
      },
      isRunningSession() {
        return false;
      },
      listSessions() {
        return currentSessions;
      },
      listAuxiliarySessions() {
        return currentAuxiliarySessions;
      },
      getAppSettings() {
        return savedSettings ?? previousSettings;
      },
      async updateAppSettings(settings) {
        savedSettings = settings;
        savedSettingsEntered.resolve();
        await savedSettingsResume.promise;
        return settings;
      },
      getModelCatalog() {
        return createCatalogSnapshot();
      },

      replaceAllSessions(nextSessions) {
        currentSessions = nextSessions;
        return nextSessions;
      },

      clearProviderQuotaTelemetry() {},
      clearSessionContextTelemetry() {},
      invalidateProviderSessionThread() {},
      broadcastSessions() {},
      broadcastAppSettings() {
        throw new Error("settings projection failed");
      },
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
    const updatedAuxiliarySessions = [createAuxiliarySession({
      provider: "copilot",
      messages: [{ role: "assistant", text: "concurrent update" }],
    })];
    currentAuxiliarySessions = updatedAuxiliarySessions;
    savedSettingsResume.resolve();

    await assert.rejects(() => updating, /settings projection failed/);
    assert.deepEqual(savedSettings, previousSettings);
    assert.deepEqual(currentSessions, []);
    assert.deepEqual(currentAuxiliarySessions, updatedAuxiliarySessions);
  });

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
  it("settings 更新時に API key 変更 provider の thread と telemetry を無効化する", async () => {
    const previousSettings = createDefaultAppSettings();
    const previousSessions = [createSession(), createSession({ id: "session-empty-thread", threadId: "" })];
    const patchedIds: string[] = [];
    const clearQuotaCalls: string[] = [];
    const clearContextCalls: string[] = [];
    const invalidated: string[] = [];
    let replacedSessions: Session[] = [];
    const saved = { settings: null as AppSettings | null };

    const service = new SettingsCatalogService({
      hasInFlightSessionRuns() {
        return false;
      },
      isSessionRunInFlight() {
        return false;
      },
      isRunningSession() {
        return false;
      },
      listSessions() {
        return previousSessions;
      },
      listAuxiliarySessions() {
        return [];
      },
      getAppSettings() {
        return saved.settings ?? previousSettings;
      },
      updateAppSettings(settings) {
        saved.settings = settings;
        return settings;
      },
      getModelCatalog() {
        return createCatalogSnapshot();
      },

      replaceAllSessions() {
        throw new Error("credential thread test must not replace the full Session collection");
      },
      updateSessionThreadIfMatches(input) {
        patchedIds.push(input.sessionId);
        const current = previousSessions.find((session) =>
          session.id === input.sessionId
          && getSessionIncarnationId(session) === input.incarnationId
          && session.provider === input.provider
          && session.threadId === input.expectedThreadId,
        );
        if (!current) return null;
        current.threadId = input.nextThreadId;
        current.updatedAt = input.updatedAt;
        replacedSessions = previousSessions;
        return { ...current };
      },

      updateAuxiliarySessionThreadIfMatches() {
        return null;
      },
      clearProviderQuotaTelemetry(providerId) {
        clearQuotaCalls.push(providerId);
      },
      clearSessionContextTelemetry(sessionId) {
        clearContextCalls.push(sessionId);
      },
      invalidateProviderSessionThread(providerId, sessionId) {
        invalidated.push(`${providerId}:${sessionId}`);
      },
      broadcastSessions() {},
      broadcastAppSettings() {},
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
    assert.equal(saved.settings.codingProviderSettings["codex"]?.apiKey, "changed-key");
    assert.equal(next.codingProviderSettings.codex.apiKey, "changed-key");
    assert.deepEqual(clearQuotaCalls, ["codex"]);
    assert.deepEqual(clearContextCalls, ["session-1", "session-empty-thread"]);
    assert.deepEqual(patchedIds, ["session-1"]);
    assert.equal(replacedSessions[0]?.threadId, "");
    assert.deepEqual(replacedSessions[0]?.messages, previousSessions[0].messages);
    assert.deepEqual(invalidated, ["codex:session-1", "codex:session-empty-thread"]);
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
  it("settings 更新時に API key 変更 provider の auxiliary thread も無効化する", async () => {
    const previousSettings = createDefaultAppSettings();
    const previousSessions = [createSession({ threadId: "" })];
    const previousAuxiliarySessions = [createAuxiliarySession()];
    const previousMessages = structuredClone(previousAuxiliarySessions[0].messages);
    const clearContextCalls: string[] = [];
    const invalidated: string[] = [];

    const service = new SettingsCatalogService({
      hasInFlightSessionRuns() {
        return false;
      },
      isSessionRunInFlight() {
        return false;
      },
      isRunningSession() {
        return false;
      },
      listSessions() {
        return previousSessions;
      },
      listAuxiliarySessions() {
        return previousAuxiliarySessions;
      },
      getAppSettings() {
        return previousSettings;
      },
      updateAppSettings(settings) {
        return settings;
      },
      getModelCatalog() {
        return createCatalogSnapshot();
      },

      replaceAllSessions() {
        throw new Error("credential thread test must not replace the full Session collection");
      },
      updateSessionThreadIfMatches() {
        return null;
      },

      updateAuxiliarySessionThreadIfMatches(input) {
        const current = previousAuxiliarySessions.find((session) =>
          session.id === input.auxiliarySessionId
          && session.parentSessionId === input.parentSessionId
          && session.provider === input.provider
          && session.threadId === input.expectedThreadId
          && session.createdAt === input.createdAt,
        );
        if (!current) return null;
        current.threadId = input.nextThreadId;
        current.updatedAt = input.updatedAt;
        return { ...current };
      },
      clearProviderQuotaTelemetry() {},
      clearSessionContextTelemetry(sessionId) {
        clearContextCalls.push(sessionId);
      },
      invalidateProviderSessionThread(providerId, sessionId) {
        invalidated.push(`${providerId}:${sessionId}`);
      },
      broadcastSessions() {},
      broadcastAppSettings() {},
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
  it("credential更新のinvalidation失敗はthreadだけをCAS rollbackし並行状態を保持する", async () => {
    const previousSettings = createDefaultAppSettings();
    const main = createSession();
    const auxiliary = createAuxiliarySession();
    const deletedAuxiliary = createAuxiliarySession({ id: "aux-deleted", threadId: "deleted-thread" });
    const sessions = [main];
    const auxiliaries = [auxiliary, deletedAuxiliary];
    const invalidationStarted = createDeferred();
    const releaseInvalidation = createDeferred();
    const reverseInputs: string[] = [];
    let savedSettings = previousSettings;
    let invalidationCalls = 0;
    const service = new SettingsCatalogService({
      hasInFlightSessionRuns: () => false,
      isSessionRunInFlight: () => false,
      isRunningSession: () => false,
      listSessions: () => sessions.map((session) => ({ ...session, messages: [...session.messages] })),
      listAuxiliarySessions: () => auxiliaries.map((session) => ({ ...session, messages: [...session.messages] })),
      getAppSettings: () => savedSettings,
      updateAppSettings: (settings) => { savedSettings = settings; return settings; },
      getModelCatalog: () => createCatalogSnapshot(),

      replaceAllSessions: () => { throw new Error("must use thread patch"); },

      updateSessionThreadIfMatches: (input) => {
        const current = sessions.find((session) => session.id === input.sessionId && getSessionIncarnationId(session) === input.incarnationId && session.provider === input.provider && session.threadId === input.expectedThreadId);
        if (!current) return null;
        if (input.expectedThreadId === "") reverseInputs.push(`main:${input.nextThreadId}`);
        current.threadId = input.nextThreadId;
        current.updatedAt = input.updatedAt;
        return { ...current };
      },
      updateAuxiliarySessionThreadIfMatches: (input) => {
        const current = auxiliaries.find((session) => session.id === input.auxiliarySessionId && session.parentSessionId === input.parentSessionId && session.provider === input.provider && session.threadId === input.expectedThreadId && session.createdAt === input.createdAt);
        if (!current) return null;
        if (input.expectedThreadId === "") reverseInputs.push(`aux:${input.nextThreadId}`);
        current.threadId = input.nextThreadId;
        current.updatedAt = input.updatedAt;
        return { ...current };
      },
      clearProviderQuotaTelemetry: () => {},
      clearSessionContextTelemetry: () => {},
      invalidateProviderSessionThread: async () => {
        invalidationCalls += 1;
        if (invalidationCalls === 1) {
          invalidationStarted.resolve();
          await releaseInvalidation.promise;
          throw new Error("invalidation failed");
        }
      },
      broadcastSessions: () => {},
      broadcastAppSettings: () => {},
      broadcastModelCatalog: () => {},
    });

    const updating = service.updateAppSettings({
      ...previousSettings,
      codingProviderSettings: {
        ...previousSettings.codingProviderSettings,
        codex: { ...previousSettings.codingProviderSettings.codex, apiKey: "changed-key" },
      },
    });
    await invalidationStarted.promise;
    main.messages = [{ role: "user", text: "concurrent body" }];
    auxiliary.composerDraft = "concurrent draft";
    auxiliaries.splice(1, 1);
    releaseInvalidation.resolve();

    await assert.rejects(() => updating);
    assert.equal(main.threadId, "thread-1");
    assert.deepEqual(main.messages, [{ role: "user", text: "concurrent body" }]);
    assert.equal(auxiliary.threadId, "aux-thread-1");
    assert.equal(auxiliary.composerDraft, "concurrent draft");
    assert.equal(auxiliaries.some((session) => session.id === "aux-deleted"), false);
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
  it("provider cleanup barrier 中の affected provider admission を保持する", async () => {
    const previousSettings = createDefaultAppSettings();
    const session = createSession();
    let savedSettings = previousSettings;
    const cleanupStarted = createDeferred();
    const releaseCleanup = createDeferred();
    const service = new SettingsCatalogService({
      hasInFlightSessionRuns: () => false,
      isSessionRunInFlight: () => false,
      isRunningSession: () => false,
      listSessions: () => [session],
      listAuxiliarySessions: () => [],
      getAppSettings: () => savedSettings,
      updateAppSettings: (settings) => { savedSettings = settings; return settings; },
      getModelCatalog: () => createCatalogSnapshot(),

      replaceAllSessions: () => [session],

      updateSessionThreadIfMatches: (input) => ({ ...session, threadId: input.nextThreadId }),
      updateAuxiliarySessionThreadIfMatches: () => null,
      clearProviderQuotaTelemetry: () => {},
      clearSessionContextTelemetry: () => {},
      invalidateProviderSessionThread: async () => {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
        throw new Error("cleanup failed");
      },
      broadcastSessions: () => {},
      broadcastAppSettings: () => {},
      broadcastModelCatalog: () => {},
    });

    const updating = service.updateAppSettings({
      ...previousSettings,
      codingProviderSettings: {
        ...previousSettings.codingProviderSettings,
        codex: { ...previousSettings.codingProviderSettings.codex, apiKey: "changed-key" },
      },
    });
    await cleanupStarted.promise;
    assert.throws(() => service.assertProviderAvailableForTurn("codex"), /A provider settings update is in progress/);
    assert.doesNotThrow(() => service.assertProviderAvailableForTurn("copilot"));
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
  it("appSettings-only reset後のsettings rollbackを拒否する", async () => {
    for (const invalidation of ["owner", "settings-reset"] as const) {
      const previous: AppSettings = { ...createDefaultAppSettings(), codingProviderSettings: { ...createDefaultAppSettings().codingProviderSettings, codex: { ...createDefaultAppSettings().codingProviderSettings.codex, apiKey: "old-key" } } };
      const resetSettings = createDefaultAppSettings();
      const session = createSession();
      let current = previous;
      let updateCount = 0;
      let storageGeneration = 1;
      const cleanupStarted = createDeferred();
      const releaseCleanup = createDeferred();
      const service = new SettingsCatalogService({
        getAppSettings: () => current,
        updateAppSettings: (settings) => { updateCount += 1; current = settings; return settings; },
        hasInFlightSessionRuns: () => false, isSessionRunInFlight: () => false, isRunningSession: () => false,
        listSessions: () => [session], listAuxiliarySessions: () => [],
        getModelCatalog: () => createCatalogSnapshot(),

        replaceAllSessions: () => [],
        clearProviderQuotaTelemetry: () => {}, clearSessionContextTelemetry: () => {}, invalidateProviderSessionThread: async () => { cleanupStarted.resolve(); await releaseCleanup.promise; throw new Error("cleanup failed"); },
        broadcastSessions: () => {}, broadcastAppSettings: () => {}, broadcastModelCatalog: () => {},
        captureStorageIdentity: () => storageGeneration,
        isStorageIdentityCurrent: (identity) => identity === storageGeneration,
        resetAppSettings: () => { current = resetSettings; return current; },
        clearAllProviderQuotaTelemetry: () => {}, clearAllSessionContextTelemetry: () => {},
        clearAllSessionBackgroundActivities: () => {}, invalidateAllProviderSessionThreads: async () => {},
        closeResetTargetWindows: () => {}, resetSessionRuntime: () => {},
        clearProjectMemories: () => {}, recreateDatabaseFile: async () => createCatalogSnapshot(),

      });
      const updating = service.updateAppSettings(resetSettings);
      await cleanupStarted.promise;
      assert.deepEqual(current, resetSettings);
      const rejection = assert.rejects(updating, (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(
          String(error.errors[1]),
          invalidation === "owner" ? /Saved data changed/ : /Rollback was canceled because a reset started/,
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
  it("settings rollback後に正本を再broadcastする", async () => {
    const previous = createDefaultAppSettings();
    const session = createSession({ provider: "copilot" });
    const auxiliary = createAuxiliarySession({ parentSessionId: session.id });
    let current = previous;
    const broadcasted: AppSettings[] = [];
    const sessionNotifications: string[][] = [];
    const service = new SettingsCatalogService({
      getAppSettings: () => current,
      updateAppSettings: (settings) => { current = settings; return settings; },
      hasInFlightSessionRuns: () => false, isSessionRunInFlight: () => false, isRunningSession: () => false,
      listSessions: () => [session], listAuxiliarySessions: () => [auxiliary],
      getModelCatalog: () => createCatalogSnapshot(),

      replaceAllSessions: () => [],
      clearProviderQuotaTelemetry: () => {}, clearSessionContextTelemetry: () => {}, invalidateProviderSessionThread: async () => { throw new Error("cleanup failed"); },
      broadcastSessions: (ids) => { sessionNotifications.push(ids ? [...ids] : []); }, broadcastAppSettings: (settings) => { broadcasted.push(settings ?? current); }, broadcastModelCatalog: () => {},
    });
    await assert.rejects(service.updateAppSettings({ ...previous, codingProviderSettings: { ...previous.codingProviderSettings, codex: { ...previous.codingProviderSettings.codex, apiKey: "new-key" } } }), /cleanup failed/);
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
  it("重複cleanupの最後までprovider admissionを保持する", async () => {
    const previous = createDefaultAppSettings();
    const session = createSession();
    let current = previous;
    let cleanupCount = 0;
    const available: Array<{ provider: string; admitted: boolean }> = [];
    const firstCleanup = createDeferred();
    const firstCleanupRelease = createDeferred();
    const service = new SettingsCatalogService({
      onProviderTurnAvailable: (provider) => {
        available.push({ provider, admitted: service.isProviderAvailableForTurn(provider) });
      },
      getAppSettings: () => current,
      updateAppSettings: (settings) => { current = settings; return settings; },
      hasInFlightSessionRuns: () => false, isSessionRunInFlight: () => false, isRunningSession: () => false,
      listSessions: () => [session], listAuxiliarySessions: () => [],
      getModelCatalog: () => createCatalogSnapshot(),

      replaceAllSessions: () => [],
      clearProviderQuotaTelemetry: () => {}, clearSessionContextTelemetry: () => {}, invalidateProviderSessionThread: async () => {
        cleanupCount += 1;
        if (cleanupCount === 1) { firstCleanup.resolve(); await firstCleanupRelease.promise; throw new Error("first cleanup failed"); }
      },
      broadcastSessions: () => {}, broadcastAppSettings: () => {}, broadcastModelCatalog: () => {},
    });
    const first = service.updateAppSettings({ ...previous, codingProviderSettings: { ...previous.codingProviderSettings, codex: { ...previous.codingProviderSettings.codex, apiKey: "first" } } });
    await firstCleanup.promise;
    const second = service.updateAppSettings({ ...current, codingProviderSettings: { ...current.codingProviderSettings, codex: { ...current.codingProviderSettings.codex, apiKey: "second" } } });
    await second;
    assert.deepEqual(available, []);
    assert.equal(service.isProviderAvailableForTurn("codex"), false);
    assert.throws(() => service.assertProviderAvailableForTurn("codex"), /A provider settings update is in progress/);
    assert.doesNotThrow(() => service.assertProviderAvailableForTurn("copilot"));
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
  it("credential更新の結果不明patchはreverseせず元errorを伝播する", async () => {
    const previousSettings = createDefaultAppSettings();
    const main = createSession();
    let savedSettings = previousSettings;
    let reverseCalls = 0;
    const service = new SettingsCatalogService({
      hasInFlightSessionRuns: () => false,
      isSessionRunInFlight: () => false,
      isRunningSession: () => false,
      listSessions: () => [main],
      listAuxiliarySessions: () => [],
      getAppSettings: () => savedSettings,
      updateAppSettings: (settings) => { savedSettings = settings; return settings; },
      getModelCatalog: () => createCatalogSnapshot(),

      replaceAllSessions: () => { throw new Error("must use thread patch"); },

      updateSessionThreadIfMatches: (input) => {
        if (input.expectedThreadId === "") reverseCalls += 1;
        main.threadId = input.nextThreadId;
        throw new Error("write result unknown");
      },
      updateAuxiliarySessionThreadIfMatches: () => null,
      clearProviderQuotaTelemetry: () => {},
      clearSessionContextTelemetry: () => {},
      invalidateProviderSessionThread: () => {},
      broadcastSessions: () => {},
      broadcastAppSettings: () => {},
      broadcastModelCatalog: () => {},
    });

    await assert.rejects(() => service.updateAppSettings({
      ...previousSettings,
      codingProviderSettings: {
        ...previousSettings.codingProviderSettings,
        codex: { ...previousSettings.codingProviderSettings.codex, apiKey: "changed-key" },
      },
    }), /write result unknown/);
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
  it("session の partial/full reset は永続化成功後に全通知を閉じる", async () => {
    let sessions = [
      { ...createSession(), id: "session-partial-1" },
      { ...createSession(), id: "session-partial-2" },
    ];
    let auxiliarySessions = [
      createAuxiliarySession({ id: "aux-partial-1", parentSessionId: "session-partial-1" }),
      createAuxiliarySession({ id: "aux-partial-2", parentSessionId: "session-partial-2" }),
    ];
    const calls: string[] = [];
    const firstReplacementStarted = createDeferred();
    const rejectFirstReplacement = createDeferred();
    const firstRecreateStarted = createDeferred();
    const rejectFirstRecreate = createDeferred();
    let replaceCallCount = 0;
    let recreateCallCount = 0;
    const service = new SettingsCatalogService({
      hasInFlightSessionRuns() {
        return false;
      },
      isSessionRunInFlight() {
        return false;
      },
      isRunningSession() {
        return false;
      },
      listSessions() {
        return sessions;
      },
      listAuxiliarySessions() {
        return auxiliarySessions;
      },
      getAppSettings() {
        return createDefaultAppSettings();
      },
      updateAppSettings(settings) {
        return settings;
      },
      getModelCatalog() {
        return createCatalogSnapshot();
      },

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

      clearProviderQuotaTelemetry(providerId) {
        calls.push(`clearQuota:${providerId}`);
      },
      clearSessionContextTelemetry(sessionId) {
        calls.push(`clearContext:${sessionId}`);
      },
      invalidateProviderSessionThread(providerId, sessionId) {
        calls.push(`invalidate:${providerId}:${sessionId}`);
      },
      resetAppSettings() {
        calls.push("resetAppSettings");
        return createDefaultAppSettings();
      },

      clearProjectMemories() {
        calls.push("clearProject");
      },
      resetSessionRuntime() {
        calls.push("resetRuntime");
      },
      clearAllProviderQuotaTelemetry() {
        calls.push("clearAllQuota");
      },
      clearAllSessionContextTelemetry() {
        calls.push("clearAllContext");
      },
      clearAllSessionBackgroundActivities() {
        calls.push("clearAllActivity");
      },
      invalidateAllProviderSessionThreads() {
        calls.push("invalidateAllThreads");
      },
      closeResetTargetWindows() {
        calls.push("closeResetWindows");
      },
      dismissSessionTurnNotification(sessionId) {
        calls.push(`dismissNotification:${sessionId}`);
      },
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
      broadcastSessions() {
        calls.push("broadcastSessions");
      },
      broadcastAppSettings() {
        calls.push("broadcastSettings");
      },
      broadcastModelCatalog() {
        calls.push("broadcastCatalog");
      },
    });

    const failedPartialReset = service.resetAppDatabase({
      targets: ["sessions", "appSettings"],
    });
    await firstReplacementStarted.promise;
    assert.equal(calls.some((call) => call.startsWith("dismissNotification:")), false);
    rejectFirstReplacement.resolve();
    await assert.rejects(failedPartialReset, /replace sessions failed/);
    assert.deepEqual(calls, [
      "closeResetWindows",
      "replace:0",
    ]);

    calls.length = 0;
    const result = await service.resetAppDatabase({
      targets: ["sessions", "appSettings"],
    });

    assert.deepEqual(result.resetTargets, ["sessions", "appSettings"]);
    assert.deepEqual(calls, [
      "closeResetWindows",
      "replace:0",
      "dismissNotification:session-partial-1",
      "dismissNotification:session-partial-2",
      "dismissNotification:aux-partial-1",
      "dismissNotification:aux-partial-2",
      "resetRuntime",
      "clearAllActivity",
      "invalidateAllThreads",
      "resetAppSettings",
      "clearAllQuota",
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
      createAuxiliarySession({ id: "aux-full-1", parentSessionId: "session-full-1" }),
      createAuxiliarySession({ id: "aux-full-2", parentSessionId: "session-full-2" }),
    ];

    const failedFullReset = service.resetAppDatabase();
    await firstRecreateStarted.promise;
    assert.equal(calls.some((call) => call.startsWith("dismissNotification:")), false);
    rejectFirstRecreate.resolve();
    await assert.rejects(failedFullReset, /recreate database failed/);
    assert.deepEqual(calls, [
      "closeResetWindows",
      "recreateDb",
    ]);

    calls.length = 0;
    const fullResult = await service.resetAppDatabase();

    assert.deepEqual(fullResult.resetTargets, [
      "sessions",
      "appSettings",
      "projectMemory",
    ]);
    assert.deepEqual(calls, [
      "closeResetWindows",
      "recreateDb",
      "dismissNotification:session-full-1",
      "dismissNotification:session-full-2",
      "dismissNotification:aux-full-1",
      "dismissNotification:aux-full-2",
      "resetRuntime",
      "clearAllActivity",
      "invalidateAllThreads",
      "clearAllQuota",
      "clearAllContext",
      "broadcastSessions",
      "broadcastSettings",
      "broadcastCatalog",
    ]);
  });
});

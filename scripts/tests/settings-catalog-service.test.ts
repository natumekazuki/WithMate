import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { Session } from "../../src/app-state.js";
import type { AuxiliarySession } from "../../src/auxiliary-session-state.js";
import { createDefaultAppSettings, type AppSettings } from "../../src/provider-settings-state.js";
import type { ModelCatalogDocument, ModelCatalogSnapshot } from "../../src/model-catalog.js";
import { getSessionIncarnationId } from "../../src/session-state.js";
import type { SessionThreadPatchInput } from "../../src-electron/session-storage-v6.js";
import type { AuxiliarySessionThreadPatchInput } from "../../src-electron/auxiliary-session-storage.js";
import type { AuxiliarySessionRuntimeMetadataPatchInput } from "../../src-electron/auxiliary-session-storage.js";
import type { ProviderRuntimeMetadataPatch } from "../../src-electron/provider-runtime-metadata-patch.js";
import { AppSettingsStorage } from "../../src-electron/app-settings-storage.js";
import { SettingsCatalogService as SettingsCatalogServiceImpl } from "../../src-electron/settings-catalog-service.js";

class SettingsCatalogService extends SettingsCatalogServiceImpl {
  constructor(deps: Omit<ConstructorParameters<typeof SettingsCatalogServiceImpl>[0], "updateSessionThreadIfMatches" | "updateAuxiliarySessionThreadIfMatches" | "updateSessionRuntimeMetadataIfMatches" | "updateAuxiliarySessionRuntimeMetadataIfMatches"> & Partial<Pick<ConstructorParameters<typeof SettingsCatalogServiceImpl>[0], "updateSessionThreadIfMatches" | "updateAuxiliarySessionThreadIfMatches" | "updateSessionRuntimeMetadataIfMatches" | "updateAuxiliarySessionRuntimeMetadataIfMatches">>) {
    super({
      runProviderRuntimeOperationExclusive: async (operation) => await operation(),
      ...deps,
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
        if (deps.replaceAuxiliarySessions) {
          const replaced = await deps.replaceAuxiliarySessions(sessions.map((session) => session.id === next.id ? next : session));
          return replaced.find((session) => session.id === next.id) ?? next;
        }
        Object.assign(target, next);
        return next;
      }),
      updateSessionRuntimeMetadataIfMatches: deps.updateSessionRuntimeMetadataIfMatches ?? (async (input) => {
        const sessions = await deps.listSessions();
        const target = sessions.find((session) => session.id === input.sessionId);
        if (!target || getSessionIncarnationId(target) !== input.incarnationId ||
            target.provider !== input.expected.provider || target.catalogRevision !== input.expected.catalogRevision ||
            target.model !== input.expected.model || target.reasoningEffort !== input.expected.reasoningEffort ||
            target.threadId !== input.expected.threadId) return null;
        const next = { ...target, ...input.next };
        if (deps.replaceAllSessions) {
          const replaced = await deps.replaceAllSessions(sessions.map((session) => session.id === next.id ? next : session), { broadcast: false });
          return replaced.find((session) => session.id === next.id) ?? next;
        }
        Object.assign(target, next);
        return next;
      }),
      updateAuxiliarySessionRuntimeMetadataIfMatches: deps.updateAuxiliarySessionRuntimeMetadataIfMatches ?? (async (input: AuxiliarySessionRuntimeMetadataPatchInput) => {
        const sessions = await deps.listAuxiliarySessions();
        const target = sessions.find((session) => session.id === input.auxiliarySessionId);
        if (!target || target.parentSessionId !== input.parentSessionId || target.createdAt !== input.createdAt ||
            target.provider !== input.expected.provider || target.catalogRevision !== input.expected.catalogRevision ||
            target.model !== input.expected.model || target.reasoningEffort !== input.expected.reasoningEffort ||
            target.threadId !== input.expected.threadId) return null;
        const next = { ...target, ...input.next };
        if (deps.replaceAuxiliarySessions) {
          const replaced = await deps.replaceAuxiliarySessions(sessions.map((session) => session.id === next.id ? next : session));
          return replaced.find((session) => session.id === next.id) ?? next;
        }
        Object.assign(target, next);
        return next;
      }),
    });
  }
}

function createDeferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolve = () => undefined;
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
    approvalMode: "on-request",
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
    customAgentName: "",
    allowedAdditionalDirectories: [],
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

function createCatalogSnapshot(revision = 1): ModelCatalogSnapshot {
  return {
    revision,
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
        ensureModelCatalogSeeded: () => createCatalogSnapshot(),
        importModelCatalogDocument: () => createCatalogSnapshot(),
        exportModelCatalogDocument: () => ({ providers: createCatalogSnapshot().providers }),
        replaceAllSessions: () => [], replaceAuxiliarySessions: (sessions) => sessions,
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
      }), /実行中の session/);
      assert.equal(writes, 0, running);
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "通常 settings 更新は並行保存された chat layout を巻き戻さない"
  // oracle = { type = "contract", ref = "Concurrent settings projection" }
  // fault = "stale snapshot が最新 layout を上書きする"
  // observable = "settings 更新後の chatLayoutPreference"
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
          return [];
        },
        async listAuxiliarySessions() {
          auxiliarySessionsRequested.resolve();
          await resumeAuxiliarySessions.promise;
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
        ensureModelCatalogSeeded() {
          return createCatalogSnapshot();
        },
        importModelCatalogDocument() {
          return createCatalogSnapshot();
        },
        exportModelCatalogDocument() {
          return { providers: createCatalogSnapshot().providers };
        },
        replaceAllSessions(nextSessions) {
          return nextSessions;
        },
        replaceAuxiliarySessions(nextSessions) {
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
    let broadcastSettings: AppSettings | null = null;

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
        ensureModelCatalogSeeded() {
          return createCatalogSnapshot();
        },
        importModelCatalogDocument() {
          return createCatalogSnapshot();
        },
        exportModelCatalogDocument() {
          return { providers: createCatalogSnapshot().providers };
        },
        async updateSessionThreadIfMatches(input) {
          const current = previousSessions[0];
          current.threadId = input.nextThreadId;
          current.updatedAt = input.updatedAt;
          sessionReplacementStarted.resolve();
          await resumeSessionReplacement.promise;
          return { ...current };
        },
        replaceAuxiliarySessions(nextSessions) {
          return nextSessions;
        },
        clearProviderQuotaTelemetry() {},
        clearSessionContextTelemetry() {},
        invalidateProviderSessionThread() {},
        broadcastSessions() {},
        broadcastAppSettings(settings) {
          broadcastSettings = settings ?? storage.getSettings();
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
      assert.ok(broadcastSettings);
      assert.deepEqual(broadcastSettings.chatLayoutPreference, updated.chatLayoutPreference);
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
        ensureModelCatalogSeeded() {
          return createCatalogSnapshot();
        },
        importModelCatalogDocument() {
          return createCatalogSnapshot();
        },
        exportModelCatalogDocument() {
          return { providers: createCatalogSnapshot().providers };
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
        replaceAuxiliarySessions(nextSessions) {
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
      ensureModelCatalogSeeded() {
        return createCatalogSnapshot();
      },
      importModelCatalogDocument() {
        return createCatalogSnapshot();
      },
      exportModelCatalogDocument() {
        return { providers: createCatalogSnapshot().providers };
      },
      replaceAllSessions(nextSessions) {
        currentSessions = nextSessions;
        return nextSessions;
      },
      replaceAuxiliarySessions(nextSessions) {
        currentAuxiliarySessions = nextSessions;
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
        return previousSessions;
      },
      listAuxiliarySessions() {
        return [];
      },
      getAppSettings() {
        return savedSettings ?? previousSettings;
      },
      updateAppSettings(settings) {
        savedSettings = settings;
        return settings;
      },
      getModelCatalog() {
        return createCatalogSnapshot();
      },
      ensureModelCatalogSeeded() {
        return createCatalogSnapshot();
      },
      importModelCatalogDocument() {
        return createCatalogSnapshot();
      },
      exportModelCatalogDocument() {
        return { providers: createCatalogSnapshot().providers };
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
      replaceAuxiliarySessions() {
        throw new Error("credential thread test must not replace the full Auxiliary collection");
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

    assert.equal(savedSettings?.codingProviderSettings.codex.apiKey, "changed-key");
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
  // fault = "Auxiliary collection全体をreplaceする、または親Sessionのprovider invalidationを省略する"
  // observable = "Auxiliary threadId、messages、telemetry clear、provider invalidation、旧collection replace呼出し"
  // observation_boundary = "component-behavior"
  // scope = "settings-credential-auxiliary-thread"
  // lifecycle = "permanent"
  // distinction = "Auxiliaryの条件付きpatchと全provider invalidationの境界を直接確認する"
  // @end-test-value
  it("settings 更新時に API key 変更 provider の auxiliary thread も無効化する", async () => {
    const previousSettings = createDefaultAppSettings();
    const previousSessions = [createSession({ threadId: "" })];
    const previousAuxiliarySessions = [createAuxiliarySession()];
    const clearContextCalls: string[] = [];
    const invalidated: string[] = [];
    let replacedAuxiliarySessions: AuxiliarySession[] = [];

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
      ensureModelCatalogSeeded() {
        return createCatalogSnapshot();
      },
      importModelCatalogDocument() {
        return createCatalogSnapshot();
      },
      exportModelCatalogDocument() {
        return { providers: createCatalogSnapshot().providers };
      },
      replaceAllSessions() {
        throw new Error("credential thread test must not replace the full Session collection");
      },
      updateSessionThreadIfMatches() {
        return null;
      },
      replaceAuxiliarySessions() {
        throw new Error("credential thread test must not replace the full Auxiliary collection");
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
        replacedAuxiliarySessions = previousAuxiliarySessions;
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

    assert.equal(replacedAuxiliarySessions[0]?.threadId, "");
    assert.deepEqual(replacedAuxiliarySessions[0]?.messages, previousAuxiliarySessions[0].messages);
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
      ensureModelCatalogSeeded: () => createCatalogSnapshot(),
      importModelCatalogDocument: () => createCatalogSnapshot(),
      exportModelCatalogDocument: () => ({ providers: createCatalogSnapshot().providers }),
      replaceAllSessions: () => { throw new Error("must use thread patch"); },
      replaceAuxiliarySessions: () => { throw new Error("must use auxiliary thread patch"); },
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
      ensureModelCatalogSeeded: () => createCatalogSnapshot(),
      importModelCatalogDocument: () => createCatalogSnapshot(),
      exportModelCatalogDocument: () => ({ providers: createCatalogSnapshot().providers }),
      replaceAllSessions: () => [session],
      replaceAuxiliarySessions: () => [],
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
    } as any);

    const updating = service.updateAppSettings({
      ...previousSettings,
      codingProviderSettings: {
        ...previousSettings.codingProviderSettings,
        codex: { ...previousSettings.codingProviderSettings.codex, apiKey: "changed-key" },
      },
    });
    await cleanupStarted.promise;
    assert.throws(() => service.assertProviderAvailableForTurn("codex"), /provider の設定反映中/);
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
      const previous = { ...createDefaultAppSettings(), codingProviderSettings: { ...createDefaultAppSettings().codingProviderSettings, codex: { ...createDefaultAppSettings().codingProviderSettings.codex, apiKey: "old-key" } } };
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
        getModelCatalog: () => createCatalogSnapshot(), ensureModelCatalogSeeded: () => createCatalogSnapshot(),
        importModelCatalogDocument: () => createCatalogSnapshot(), exportModelCatalogDocument: () => ({ providers: createCatalogSnapshot().providers }),
        replaceAllSessions: () => [], replaceAuxiliarySessions: () => [],
        clearProviderQuotaTelemetry: () => {}, clearSessionContextTelemetry: () => {}, invalidateProviderSessionThread: async () => { cleanupStarted.resolve(); await releaseCleanup.promise; throw new Error("cleanup failed"); },
        broadcastSessions: () => {}, broadcastAppSettings: () => {}, broadcastModelCatalog: () => {},
        captureStorageIdentity: () => storageGeneration,
        isStorageIdentityCurrent: (identity) => identity === storageGeneration,
        resetAppSettings: () => { current = resetSettings; return current; },
        clearAllProviderQuotaTelemetry: () => {}, clearAllSessionContextTelemetry: () => {},
        clearAllSessionBackgroundActivities: () => {}, invalidateAllProviderSessionThreads: async () => {},
        closeResetTargetWindows: () => {}, resetSessionRuntime: () => {}, clearAuditLogs: async () => {},
        clearProjectMemories: () => {}, recreateDatabaseFile: async () => createCatalogSnapshot(),
        resetModelCatalogToBundled: () => createCatalogSnapshot(),
      } as any);
      const updating = service.updateAppSettings(resetSettings);
      await cleanupStarted.promise;
      assert.deepEqual(current, resetSettings);
      const rejection = assert.rejects(updating, (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(String(error.errors[1]), invalidation === "owner" ? /storage が交換/ : /reset が開始/);
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
    let auxiliary = createAuxiliarySession({ parentSessionId: session.id });
    let current = previous;
    const broadcasted: AppSettings[] = [];
    const sessionNotifications: string[][] = [];
    const service = new SettingsCatalogService({
      getAppSettings: () => current,
      updateAppSettings: (settings) => { current = settings; return settings; },
      hasInFlightSessionRuns: () => false, isSessionRunInFlight: () => false, isRunningSession: () => false,
      listSessions: () => [session], listAuxiliarySessions: () => [auxiliary],
      getModelCatalog: () => createCatalogSnapshot(), ensureModelCatalogSeeded: () => createCatalogSnapshot(),
      importModelCatalogDocument: () => createCatalogSnapshot(), exportModelCatalogDocument: () => ({ providers: createCatalogSnapshot().providers }),
      replaceAllSessions: () => [], replaceAuxiliarySessions: (sessions) => { auxiliary = sessions[0]; return sessions; },
      clearProviderQuotaTelemetry: () => {}, clearSessionContextTelemetry: () => {}, invalidateProviderSessionThread: async () => { throw new Error("cleanup failed"); },
      broadcastSessions: (ids) => { sessionNotifications.push([...ids]); }, broadcastAppSettings: (settings) => { broadcasted.push(settings ?? current); }, broadcastModelCatalog: () => {},
    } as any);
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
  // claim = "同一providerの重複cleanupは最後のoperation完了までadmissionを保持する"
  // fault = "先行cleanup中に後続cleanupが完了するとSet解放でTurnを許可する"
  // observable = "重複cleanup完了順序とprovider admission"
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
    const firstCleanup = createDeferred();
    const firstCleanupRelease = createDeferred();
    const service = new SettingsCatalogService({
      getAppSettings: () => current,
      updateAppSettings: (settings) => { current = settings; return settings; },
      hasInFlightSessionRuns: () => false, isSessionRunInFlight: () => false, isRunningSession: () => false,
      listSessions: () => [session], listAuxiliarySessions: () => [],
      getModelCatalog: () => createCatalogSnapshot(), ensureModelCatalogSeeded: () => createCatalogSnapshot(),
      importModelCatalogDocument: () => createCatalogSnapshot(), exportModelCatalogDocument: () => ({ providers: createCatalogSnapshot().providers }),
      replaceAllSessions: () => [], replaceAuxiliarySessions: () => [],
      clearProviderQuotaTelemetry: () => {}, clearSessionContextTelemetry: () => {}, invalidateProviderSessionThread: async () => {
        cleanupCount += 1;
        if (cleanupCount === 1) { firstCleanup.resolve(); await firstCleanupRelease.promise; throw new Error("first cleanup failed"); }
      },
      broadcastSessions: () => {}, broadcastAppSettings: () => {}, broadcastModelCatalog: () => {},
    } as any);
    const first = service.updateAppSettings({ ...previous, codingProviderSettings: { ...previous.codingProviderSettings, codex: { ...previous.codingProviderSettings.codex, apiKey: "first" } } });
    await firstCleanup.promise;
    const second = service.updateAppSettings({ ...current, codingProviderSettings: { ...current.codingProviderSettings, codex: { ...current.codingProviderSettings.codex, apiKey: "second" } } });
    await second;
    assert.throws(() => service.assertProviderAvailableForTurn("codex"), /provider の設定反映中/);
    assert.doesNotThrow(() => service.assertProviderAvailableForTurn("copilot"));
    firstCleanupRelease.resolve();
    await assert.rejects(first);
    assert.doesNotThrow(() => service.assertProviderAvailableForTurn("codex"));
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
      ensureModelCatalogSeeded: () => createCatalogSnapshot(),
      importModelCatalogDocument: () => createCatalogSnapshot(),
      exportModelCatalogDocument: () => ({ providers: createCatalogSnapshot().providers }),
      replaceAllSessions: () => { throw new Error("must use thread patch"); },
      replaceAuxiliarySessions: () => { throw new Error("must use auxiliary thread patch"); },
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
  // kind = "invariant"
  // claim = "model catalog import は Main session の runtime metadata だけを新 revision へ移行し broadcast する"
  // fault = "session 全体を置換し本文・別 metadata を失う"
  // observable = "catalog revision、model、thread、messages、broadcast"
  // observation_boundary = "component-behavior"
  // scope = "catalog-import-session-metadata"
  // oracle = { type = "contract", ref = "docs/design/electron-session-store.md#settingscatalogservice" }
  // lifecycle = "permanent"
  // impact = "catalog import で会話本文や実行状態を破壊する"
  // distinction = "metadata CAS と notification の契約を直接確認する"
  // @end-test-value
  it("model catalog import で session を新 revision に移行して broadcast する", async () => {
    const previousSessions = [
      createSession({
        provider: "legacy",
        model: "missing-model",
        reasoningEffort: "high",
      }),
    ];
    const importedDocument: ModelCatalogDocument = {
      providers: createCatalogSnapshot(2).providers,
    };
    let importedSource: string | null = null;
    let broadcasted = false;
    let replacedSessions: Session[] = [];
    let catalog = createCatalogSnapshot(1);
    const cleanupStarted = createDeferred();
    const releaseCleanup = createDeferred();
    let invalidationCalls = 0;

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
        return createDefaultAppSettings();
      },
      updateAppSettings(settings) {
        return settings;
      },
      getModelCatalog() {
        return catalog;
      },
      ensureModelCatalogSeeded() {
        return catalog;
      },
      importModelCatalogDocument(document, source) {
        importedSource = source;
        catalog = {
          revision: source === "rollback" ? 1 : catalog.revision + 1,
          providers: document.providers,
        };
        return catalog;
      },
      exportModelCatalogDocument() {
        return { providers: catalog.providers };
      },
      replaceAllSessions() {
        throw new Error("catalog import must use metadata CAS");
      },
      updateSessionRuntimeMetadataIfMatches(input) {
        const current = previousSessions[0];
        if (!current || current.provider !== input.expected.provider || current.catalogRevision !== input.expected.catalogRevision || current.model !== input.expected.model || current.threadId !== input.expected.threadId) return null;
        const next = { ...current, ...input.next };
        previousSessions[0] = next;
        replacedSessions = previousSessions;
        return next;
      },
      replaceAuxiliarySessions(nextSessions) {
        return nextSessions;
      },
      clearProviderQuotaTelemetry() {},
      clearSessionContextTelemetry() {},
      invalidateProviderSessionThread: async () => {
        invalidationCalls += 1;
        if (invalidationCalls === 1) {
          cleanupStarted.resolve();
          await releaseCleanup.promise;
          throw new Error("catalog cleanup failed");
        }
      },
      broadcastSessions() {
        broadcasted = true;
      },
      broadcastAppSettings() {},
      broadcastModelCatalog() {
        broadcasted = true;
      },
    });

    const importing = service.importModelCatalogDocument(importedDocument);
    await cleanupStarted.promise;
    const concurrent = await service.importModelCatalogDocument(importedDocument);
    releaseCleanup.resolve();
    await assert.rejects(() => importing);

    assert.equal(concurrent.revision, 3);
    assert.equal(importedSource, "imported");
    assert.equal(replacedSessions[0]?.catalogRevision, 3);
    assert.equal(replacedSessions[0]?.model, "gpt-5.4");
    assert.deepEqual(replacedSessions[0]?.messages, previousSessions[0].messages);
    assert.equal(broadcasted, true);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "catalog cleanup rollback後は復元したcatalog snapshotを再broadcastする"
  // fault = "成功側catalog broadcast後のcleanup失敗で永続値だけrollbackしrenderer投影を残す"
  // observable = "catalog broadcast revision sequenceと重複しない親Session ID通知"
  // observation_boundary = "component-behavior"
  // scope = "catalog-rollback-rebroadcast"
  // oracle = { type = "contract", ref = "docs/design/electron-session-store.md#settingscatalogservice" }
  // lifecycle = "permanent"
  // impact = "rendererが保存されていないcatalog revisionを保持する"
  // distinction = "cleanup失敗、rollback、復元snapshot通知の順序を確認する"
  // @end-test-value
  it("catalog cleanup失敗のrollback後に復元snapshotを再broadcastする", async () => {
    const session = createSession();
    const auxiliary = createAuxiliarySession({ parentSessionId: session.id });
    let catalog = createCatalogSnapshot(1);
    const broadcasts: number[] = [];
    const sessionNotifications: string[][] = [];
    const service = new SettingsCatalogService({
      hasInFlightSessionRuns: () => false, isSessionRunInFlight: () => false, isRunningSession: () => false,
      listSessions: () => [session], listAuxiliarySessions: () => [auxiliary],
      getAppSettings: () => createDefaultAppSettings(), updateAppSettings: (settings) => settings,
      getModelCatalog: () => catalog, ensureModelCatalogSeeded: () => catalog,
      exportModelCatalogDocument: () => ({ providers: catalog.providers }),
      importModelCatalogDocument: (document, source) => {
        catalog = { revision: source === "rollback" ? 3 : 2, providers: document.providers };
        return catalog;
      },
      replaceAllSessions: () => [], replaceAuxiliarySessions: () => [],
      clearProviderQuotaTelemetry: () => {}, clearSessionContextTelemetry: () => {},
      invalidateProviderSessionThread: async () => { throw new Error("catalog cleanup failed"); },
      broadcastSessions: (ids) => { sessionNotifications.push([...ids]); }, broadcastAppSettings: () => {},
      broadcastModelCatalog: (snapshot) => { if (snapshot) broadcasts.push(snapshot.revision); },
    } as any);
    await assert.rejects(service.importModelCatalogDocument({ providers: createCatalogSnapshot(2).providers }), /catalog cleanup failed/);
    assert.deepEqual(broadcasts, [2, 3]);
    assert.equal(catalog.revision, 3);
    assert.deepEqual(sessionNotifications, [[session.id], [session.id]]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "model catalog import は Auxiliary の runtime metadata も限定更新する"
  // fault = "Auxiliary 本文・draft を full replace で失う"
  // observable = "Auxiliary catalog revision、model、thread、messages、invalidation"
  // observation_boundary = "component-behavior"
  // scope = "catalog-import-auxiliary-metadata"
  // oracle = { type = "contract", ref = "docs/design/electron-session-store.md#settingscatalogservice" }
  // lifecycle = "permanent"
  // impact = "Auxiliary の作業状態を catalog import で破壊する"
  // distinction = "Auxiliary metadata CAS と provider cleanup を確認する"
  // @end-test-value
  it("model catalog import で auxiliary metadata も新 revision に移行する", async () => {
    const previousSessions = [createSession()];
    const previousAuxiliarySessions = [
      createAuxiliarySession({
        model: "missing-model",
        reasoningEffort: "high",
        threadId: "aux-thread-1",
        composerDraft: "draft must survive import",
      }),
    ];
    const importedDocument: ModelCatalogDocument = {
      providers: createCatalogSnapshot(2).providers,
    };
    const invalidated: string[] = [];
    let replacedAuxiliarySessions: AuxiliarySession[] = [];

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
        return createDefaultAppSettings();
      },
      updateAppSettings(settings) {
        return settings;
      },
      getModelCatalog() {
        return createCatalogSnapshot(1);
      },
      ensureModelCatalogSeeded() {
        return createCatalogSnapshot(1);
      },
      importModelCatalogDocument(document) {
        return {
          revision: 2,
          providers: document.providers,
        };
      },
      exportModelCatalogDocument() {
        return { providers: createCatalogSnapshot(1).providers };
      },
      replaceAllSessions() {
        throw new Error("catalog import must use metadata CAS");
      },
      updateSessionRuntimeMetadataIfMatches(input) {
        const current = previousSessions[0];
        if (!current || current.provider !== input.expected.provider || current.catalogRevision !== input.expected.catalogRevision || current.model !== input.expected.model || current.threadId !== input.expected.threadId) return null;
        previousSessions[0] = { ...current, ...input.next };
        return previousSessions[0];
      },
      replaceAuxiliarySessions(nextSessions) {
        throw new Error("catalog import must use metadata CAS");
      },
      updateAuxiliarySessionRuntimeMetadataIfMatches(input) {
        const current = previousAuxiliarySessions[0];
        if (!current || current.parentSessionId !== input.parentSessionId || current.createdAt !== input.createdAt || current.provider !== input.expected.provider || current.catalogRevision !== input.expected.catalogRevision || current.model !== input.expected.model || current.threadId !== input.expected.threadId) return null;
        const next = { ...current, ...input.next };
        previousAuxiliarySessions[0] = next;
        replacedAuxiliarySessions = previousAuxiliarySessions;
        return next;
      },
      clearProviderQuotaTelemetry() {},
      clearSessionContextTelemetry() {},
      invalidateProviderSessionThread(providerId, sessionId) {
        invalidated.push(`${providerId}:${sessionId}`);
      },
      broadcastSessions() {},
      broadcastAppSettings() {},
      broadcastModelCatalog() {},
    });

    await service.importModelCatalogDocument(importedDocument);

    assert.equal(replacedAuxiliarySessions[0]?.catalogRevision, 2);
    assert.equal(replacedAuxiliarySessions[0]?.model, "gpt-5.4");
    assert.equal(replacedAuxiliarySessions[0]?.threadId, "");
    assert.equal(replacedAuxiliarySessions[0]?.composerDraft, "draft must survive import");
    assert.deepEqual(replacedAuxiliarySessions[0]?.messages, previousAuxiliarySessions[0].messages);
    assert.deepEqual(invalidated, ["codex:session-1", "codex:aux-1"]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "model catalog exportはstorage documentをそのまま返す"
  // oracle = { type = "contract", ref = "src-electron/settings-catalog-service.ts" }
  // fault = "export時に保存済みprovider/model情報を置換または欠落させる"
  // observable = "exportされたdocumentとstorageのdocumentの内容一致"
  // observation_boundary = "public-boundary"
  // scope = "model catalog export"
  // lifecycle = "permanent"
  // @end-test-value
  it("model catalog export は storage の document をそのまま返す", () => {
    const document = { providers: createCatalogSnapshot(1).providers };
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
        return [];
      },
      listAuxiliarySessions() {
        return [];
      },
      getAppSettings() {
        return createDefaultAppSettings();
      },
      updateAppSettings(settings) {
        return settings;
      },
      getModelCatalog() {
        return createCatalogSnapshot(1);
      },
      ensureModelCatalogSeeded() {
        return createCatalogSnapshot(1);
      },
      importModelCatalogDocument() {
        return createCatalogSnapshot(1);
      },
      exportModelCatalogDocument() {
        return document;
      },
      replaceAllSessions(nextSessions) {
        return nextSessions;
      },
      replaceAuxiliarySessions(nextSessions) {
        return nextSessions;
      },
      clearProviderQuotaTelemetry() {},
      clearSessionContextTelemetry() {},
      invalidateProviderSessionThread() {},
      clearAuditLogs() {},
      resetAppSettings() {
        return createDefaultAppSettings();
      },
      resetModelCatalogToBundled() {
        return createCatalogSnapshot(1);
      },
      clearProjectMemories() {},
      clearCharacterMemories() {},
      resetSessionRuntime() {},
      clearAllProviderQuotaTelemetry() {},
      clearAllSessionContextTelemetry() {},
      clearAllSessionBackgroundActivities() {},
      invalidateAllProviderSessionThreads() {},
      closeResetTargetWindows() {},
      async recreateDatabaseFile() {
        return createCatalogSnapshot(1);
      },
      broadcastSessions() {},
      broadcastAppSettings() {},
      broadcastModelCatalog() {},
    });

    return service.exportModelCatalogDocument(1).then((exported) => {
      assert.deepEqual(exported, document);
    });
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
        return createCatalogSnapshot(1);
      },
      ensureModelCatalogSeeded() {
        return createCatalogSnapshot(1);
      },
      importModelCatalogDocument() {
        return createCatalogSnapshot(1);
      },
      exportModelCatalogDocument() {
        return { providers: createCatalogSnapshot(1).providers };
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
      replaceAuxiliarySessions(nextSessions) {
        calls.push(`replaceAux:${nextSessions.length}`);
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
      clearAuditLogs() {
        calls.push("clearAudit");
      },
      resetAppSettings() {
        calls.push("resetAppSettings");
        return createDefaultAppSettings();
      },
      resetModelCatalogToBundled() {
        calls.push("resetCatalog");
        return createCatalogSnapshot(2);
      },
      clearProjectMemories() {
        calls.push("clearProject");
      },
      clearCharacterMemories() {
        calls.push("clearCharacter");
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
        return createCatalogSnapshot(3);
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
      targets: ["sessions", "appSettings", "projectMemory"],
    });
    await firstReplacementStarted.promise;
    assert.equal(calls.some((call) => call.startsWith("dismissNotification:")), false);
    rejectFirstReplacement.resolve();
    await assert.rejects(failedPartialReset, /replace sessions failed/);
    assert.deepEqual(calls, [
      "closeResetWindows",
      "clearAudit",
      "replace:0",
    ]);

    calls.length = 0;
    const result = await service.resetAppDatabase({
      targets: ["sessions", "appSettings", "projectMemory"],
    });

    assert.deepEqual(result.resetTargets, ["sessions", "auditLogs", "appSettings", "projectMemory"]);
    assert.deepEqual(calls, [
      "closeResetWindows",
      "clearAudit",
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
      "clearProject",
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
      "auditLogs",
      "appSettings",
      "modelCatalog",
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

  // @test-value v2
  // kind = "invariant"
  // claim = "model catalog reset は Auxiliary の runtime metadata だけを bundled catalog へ移行する"
  // fault = "reset で Auxiliary の本文・draft を全置換する"
  // observable = "Auxiliary revision、model、thread、messages、invalidation"
  // observation_boundary = "component-behavior"
  // scope = "catalog-reset-auxiliary-metadata"
  // oracle = { type = "contract", ref = "docs/design/electron-session-store.md#settingscatalogservice" }
  // lifecycle = "permanent"
  // impact = "catalog reset で Auxiliary 作業を失う"
  // distinction = "reset 時の限定 metadata 更新を確認する"
  // @end-test-value
  it("model catalog reset で auxiliary metadata も bundled catalog へ移行する", async () => {
    const sessions = [createSession()];
    const auxiliarySessions = [
      createAuxiliarySession({
        model: "missing-model",
        reasoningEffort: "high",
        threadId: "aux-thread-1",
        composerDraft: "draft must survive reset",
      }),
    ];
    const invalidated: string[] = [];
    let replacedAuxiliarySessions: AuxiliarySession[] = [];

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
        return createCatalogSnapshot(3);
      },
      ensureModelCatalogSeeded() {
        return createCatalogSnapshot(3);
      },
      importModelCatalogDocument() {
        return createCatalogSnapshot(3);
      },
      exportModelCatalogDocument() {
        return { providers: createCatalogSnapshot(3).providers };
      },
      replaceAllSessions() {
        throw new Error("catalog reset must use metadata CAS");
      },
      replaceAuxiliarySessions() {
        throw new Error("catalog reset must use metadata CAS");
      },
      updateSessionRuntimeMetadataIfMatches(input) {
        const current = sessions[0];
        if (!current || current.provider !== input.expected.provider || current.catalogRevision !== input.expected.catalogRevision || current.model !== input.expected.model || current.threadId !== input.expected.threadId) return null;
        sessions[0] = { ...current, ...input.next };
        return sessions[0];
      },
      updateAuxiliarySessionRuntimeMetadataIfMatches(input) {
        const current = auxiliarySessions[0];
        if (!current || current.parentSessionId !== input.parentSessionId || current.createdAt !== input.createdAt || current.provider !== input.expected.provider || current.catalogRevision !== input.expected.catalogRevision || current.model !== input.expected.model || current.threadId !== input.expected.threadId) return null;
        const next = { ...current, ...input.next };
        auxiliarySessions[0] = next;
        replacedAuxiliarySessions = auxiliarySessions;
        return next;
      },
      clearProviderQuotaTelemetry() {},
      clearSessionContextTelemetry() {},
      invalidateProviderSessionThread(providerId, sessionId) {
        invalidated.push(`${providerId}:${sessionId}`);
      },
      clearAuditLogs() {},
      resetAppSettings() {
        return createDefaultAppSettings();
      },
      resetModelCatalogToBundled() {
        return createCatalogSnapshot(3);
      },
      clearProjectMemories() {},
      clearCharacterMemories() {},
      resetSessionRuntime() {},
      clearAllProviderQuotaTelemetry() {},
      clearAllSessionContextTelemetry() {},
      clearAllSessionBackgroundActivities() {},
      invalidateAllProviderSessionThreads() {},
      closeResetTargetWindows() {},
      async recreateDatabaseFile() {
        return createCatalogSnapshot(3);
      },
      broadcastSessions() {},
      broadcastAppSettings() {},
      broadcastModelCatalog() {},
    });

    await service.resetAppDatabase({ targets: ["modelCatalog"] });

    assert.equal(replacedAuxiliarySessions[0]?.catalogRevision, 3);
    assert.equal(replacedAuxiliarySessions[0]?.model, "gpt-5.4");
    assert.equal(replacedAuxiliarySessions[0]?.threadId, "");
    assert.equal(replacedAuxiliarySessions[0]?.composerDraft, "draft must survive reset");
    assert.deepEqual(replacedAuxiliarySessions[0]?.messages, auxiliarySessions[0].messages);
    assert.deepEqual(invalidated, ["codex:session-1", "codex:aux-1"]);
  });


// @test-value v2
// kind = "invariant"
// claim = "catalog import の失敗時は試行済みのMain/Auxiliary collectionだけを復元する"
// oracle = { type = "contract", ref = "src-electron/settings-catalog-service.ts" }
// fault = "未試行collectionの並行更新を古いsnapshotへ戻すか、rollback失敗を隠す"
// observable = "collection state, catalog state, rollback errors"
// observation_boundary = "public-boundary"
// scope = "catalog-import-rollback-ownership"
// lifecycle = "permanent"
// @end-test-value
it("catalog import の rollback は試行済み collection に限定する", { timeout: 10_000 }, async () => {
  for (const failedCollection of ["main", "auxiliary"] as const) {
    for (const rollbackFails of [false, true]) {
      const original = {
        main: [createSession()],
        auxiliary: [createAuxiliarySession()],
      };
      const current = structuredClone(original);
      const entered = createDeferred();
      const resume = createDeferred();
      const importError = new Error("import replacement failed");
      const rollbackError = new Error("rollback failed");
      const sources: string[] = [];
      let rollingBack = false;
      let catalog = createCatalogSnapshot(1);
      const replace = async <K extends keyof typeof current>(key: K, rows: typeof current[K]) => {
        current[key] = rows;
        if (!rollingBack && key === failedCollection) {
          entered.resolve();
          await resume.promise;
          rollingBack = true;
          throw importError;
        }
        if (rollingBack && rollbackFails && key === failedCollection) {
          throw rollbackError;
        }
        return rows;
      };
      const service = new SettingsCatalogService({
        hasInFlightSessionRuns: () => false,
        isSessionRunInFlight: () => false,
        isRunningSession: () => false,
        listSessions: () => current.main,
        listAuxiliarySessions: () => current.auxiliary,
        getAppSettings: createDefaultAppSettings,
        updateAppSettings: (settings) => settings,
        getModelCatalog: () => catalog,
        ensureModelCatalogSeeded: () => catalog,
        importModelCatalogDocument(document, source) {
          sources.push(source);
          if (source === "rollback" && rollbackFails) {
            throw rollbackError;
          }
          catalog = { revision: source === "rollback" ? 3 : 2, providers: document.providers };
          return catalog;
        },
        exportModelCatalogDocument: () => ({ providers: catalog.providers }),
        updateSessionRuntimeMetadataIfMatches: async (input) => {
          const currentSession = current.main[0];
          if (!currentSession || currentSession.catalogRevision !== input.expected.catalogRevision || currentSession.threadId !== input.expected.threadId) {
            return null;
          }
          current.main[0] = { ...currentSession, ...input.next };
          if (!rollingBack && failedCollection === "main") {
            entered.resolve();
            await resume.promise;
            rollingBack = true;
            throw importError;
          }
          if (rollingBack && rollbackFails && failedCollection === "main") {
            throw rollbackError;
          }
          return current.main[0];
        },
        updateAuxiliarySessionRuntimeMetadataIfMatches: async (input) => {
          const currentSession = current.auxiliary[0];
          if (!currentSession || currentSession.catalogRevision !== input.expected.catalogRevision || currentSession.threadId !== input.expected.threadId) {
            return null;
          }
          current.auxiliary[0] = { ...currentSession, ...input.next };
          if (!rollingBack && failedCollection === "auxiliary") {
            entered.resolve();
            await resume.promise;
            rollingBack = true;
            throw importError;
          }
          if (rollingBack && rollbackFails && failedCollection === "auxiliary") {
            throw rollbackError;
          }
          return current.auxiliary[0];
        },
        replaceAllSessions: (rows) => replace("main", rows),
        replaceAuxiliarySessions: (rows) => replace("auxiliary", rows),
        clearProviderQuotaTelemetry() {},
        clearSessionContextTelemetry() {},
        invalidateProviderSessionThread() {},
        broadcastSessions() {},
        broadcastAppSettings() {},
        broadcastModelCatalog() {},
      });
      const incomingCatalog = createCatalogSnapshot(2);
      incomingCatalog.providers[0].label = "Imported Codex";
      const pending = service.importModelCatalogDocument({ providers: incomingCatalog.providers });
      const rejection = assert.rejects(pending, (error: unknown) => {
        if (!rollbackFails) {
          assert.equal(error, importError);
        } else {
          assert.ok(error instanceof AggregateError);
          assert.deepEqual(error.errors, [importError, rollbackError]);
        }
        return true;
      });
      await entered.promise;
      assert.deepEqual(catalog.providers, incomingCatalog.providers);
      if (failedCollection === "main") {
        current.auxiliary = [];
      }
      const expectedAuxiliary = structuredClone(current.auxiliary);
      resume.resolve();
      await rejection;
      if (rollbackFails) {
        assert.deepEqual(sources, ["imported", "rollback"]);
        assert.deepEqual(catalog.providers, incomingCatalog.providers);
        continue;
      }
      if (failedCollection === "main") {
        assert.equal(current.main[0]?.catalogRevision, 2);
      } else {
        assert.deepEqual(current.main, original.main);
      }
      if (failedCollection === "auxiliary") {
        assert.equal(current.auxiliary[0]?.catalogRevision, 2);
      } else {
        assert.deepEqual(current.auxiliary, failedCollection === "main" ? expectedAuxiliary : original.auxiliary);
      }
      assert.deepEqual(sources, ["imported", "rollback"]);
      assert.deepEqual(catalog.providers, (rollbackFails ? incomingCatalog : createCatalogSnapshot(1)).providers);
    }
  }
});


});

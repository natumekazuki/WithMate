import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { Session } from "../../src/app-state.js";
import type { AuxiliarySession } from "../../src/auxiliary-session-state.js";
import type { CompanionSession } from "../../src/companion-state.js";
import { createDefaultAppSettings, type AppSettings } from "../../src/provider-settings-state.js";
import type { ModelCatalogDocument, ModelCatalogSnapshot } from "../../src/model-catalog.js";
import { AppSettingsStorage } from "../../src-electron/app-settings-storage.js";
import { SessionExecutionAdmissionGate } from "../../src-electron/session-execution-admission-gate.js";
import { SettingsCatalogService as SettingsCatalogServiceImpl } from "../../src-electron/settings-catalog-service.js";

class SettingsCatalogService extends SettingsCatalogServiceImpl {
  constructor(deps: ConstructorParameters<typeof SettingsCatalogServiceImpl>[0]) {
    super({
      runProviderRuntimeOperationExclusive: async (operation) => await operation(),
      runSessionExecutionMaintenance: async (operation) => await operation(),
      ...deps,
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

function createCompanionSession(overrides?: Partial<CompanionSession>): CompanionSession {
  return {
    id: "companion-1",
    groupId: "group-1",
    taskTitle: "Companion",
    status: "active",
    repoRoot: "C:/workspace",
    focusPath: "src",
    targetBranch: "main",
    baseSnapshotRef: "refs/withmate/companion/companion-1/base",
    baseSnapshotCommit: "abc123",
    companionBranch: "withmate/companion/companion-1",
    worktreePath: "C:/workspace/.withmate/companion-1",
    selectedPaths: [],
    changedFiles: [],
    siblingWarnings: [],
    allowedAdditionalDirectories: [],
    runState: "idle",
    threadId: "companion-thread-1",
    provider: "codex",
    catalogRevision: 1,
    model: "gpt-5.4",
    reasoningEffort: "high",
    customAgentName: "",
    approvalMode: "on-request",
    codexSandboxMode: "workspace-write",
    characterId: "char",
    character: "A",
    characterRoleMarkdown: "伴走する。",
    characterIconPath: "",
    characterThemeColors: { main: "#000", sub: "#111" },
    characterRuntimeSnapshot: null,
    createdAt: "2026-03-28T00:00:00.000Z",
    updatedAt: "2026-03-28T00:00:00.000Z",
    messages: [{ role: "assistant", text: "companion result" }],
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
  it("SET-CAT-ADMISSION-01: credential変更は実行中判定より前にexternal admissionを閉じる", async () => {
    const gate = new SessionExecutionAdmissionGate();
    const previousSettings = createDefaultAppSettings();
    const service = new SettingsCatalogServiceImpl({
      runProviderRuntimeOperationExclusive: async (operation) => await operation(),
      runSessionExecutionMaintenance: async (operation) => await gate.runMaintenance(operation),
      hasInFlightSessionRuns: () => false,
      isSessionRunInFlight: () => true,
      isRunningSession: () => true,
      listSessions() {
        assert.equal(gate.tryAdmit(), null);
        return [createSession()];
      },
      getAppSettings: () => previousSettings,
    } as never);

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
      /実行中の session/,
    );
  });

  it("SET-CAT-ADMISSION-01: catalog importは実行中判定より前にexternal admissionを閉じる", async () => {
    const gate = new SessionExecutionAdmissionGate();
    const service = new SettingsCatalogServiceImpl({
      runProviderRuntimeOperationExclusive: async (operation) => await operation(),
      runSessionExecutionMaintenance: async (operation) => await gate.runMaintenance(operation),
      hasInFlightSessionRuns() {
        assert.equal(gate.tryAdmit(), null);
        return true;
      },
    } as never);

    await assert.rejects(
      service.importModelCatalogDocument({ providers: createCatalogSnapshot(2).providers }),
      /session 実行中/,
    );
  });

  it("DB-MAINT-07: DB resetは実行中判定より前にexternal admission maintenanceへ入る", async () => {
    const events: string[] = [];
    const service = new SettingsCatalogServiceImpl({
      async runProviderRuntimeOperationExclusive(operation) {
        events.push("provider:enter");
        return await operation();
      },
      async runSessionExecutionMaintenance(operation) {
        events.push("maintenance:enter");
        try {
          return await operation();
        } finally {
          events.push("maintenance:exit");
        }
      },
      listSessions() {
        events.push("sessions:list");
        return [];
      },
      hasInFlightSessionRuns: () => false,
    } as never);

    await assert.rejects(
      service.resetAppDatabase({ targets: [] }),
      /初期化対象が選ばれていない/,
    );
    assert.deepEqual(events, [
      "provider:enter",
      "maintenance:enter",
      "sessions:list",
      "maintenance:exit",
    ]);
  });

  it("API key 変更対象 provider に実行中 session があると settings 更新を拒否する", async () => {
    const previousSettings = createDefaultAppSettings();
    const service = new SettingsCatalogService({
      hasInFlightSessionRuns() {
        return false;
      },
      isSessionRunInFlight() {
        return true;
      },
      isRunningSession() {
        return true;
      },
      listSessions() {
        return [createSession()];
      },
      listAuxiliarySessions() {
        return [];
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
        return [];
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
      /実行中の session/,
    );
  });

  it("通常 settings 更新はSession snapshotを読み書きしない", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-settings-catalog-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    const storage = new AppSettingsStorage(dbPath);
    let sessionSnapshotAccesses = 0;

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
          sessionSnapshotAccesses += 1;
          return [];
        },
        listAuxiliarySessions() {
          sessionSnapshotAccesses += 1;
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
          sessionSnapshotAccesses += 1;
          return nextSessions;
        },
        replaceAuxiliarySessions(nextSessions) {
          sessionSnapshotAccesses += 1;
          return nextSessions;
        },
        clearProviderQuotaTelemetry() {},
        clearSessionContextTelemetry() {},
        invalidateProviderSessionThread() {},
        broadcastSessions() {},
        broadcastAppSettings() {},
        broadcastModelCatalog() {},
      });

      const updated = await service.updateAppSettings({
        ...previousSettings,
        launchAtLoginEnabled: true,
      });

      assert.equal(updated.launchAtLoginEnabled, true);
      assert.equal(sessionSnapshotAccesses, 0);
    } finally {
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

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
        async replaceAllSessions(nextSessions) {
          sessionReplacementStarted.resolve();
          await resumeSessionReplacement.promise;
          return nextSessions;
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
      storage.updateChatLayoutPreference({ target: "priority", value: "dock-first" });
      resumeSessionReplacement.resolve();

      const updated = await updating;

      assert.equal(updated.launchAtLoginEnabled, true);
      assert.deepEqual(updated.chatLayoutPreference, {
        header: "visible",
        actionDock: "expanded",
        sidePane: "files",
        priority: "dock-first",
      });
      assert.ok(broadcastSettings);
      assert.deepEqual(broadcastSettings.chatLayoutPreference, updated.chatLayoutPreference);
      assert.deepEqual(storage.getSettings().chatLayoutPreference, updated.chatLayoutPreference);
    } finally {
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

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
        async replaceAllSessions(nextSessions) {
          replaceCallCount += 1;
          if (replaceCallCount === 1) {
            firstSessionReplacementStarted.resolve();
            await rejectFirstSessionReplacement.promise;
            throw new Error("session replacement failed");
          }
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
      storage.updateChatLayoutPreference({ target: "priority", value: "dock-first" });
      rejectFirstSessionReplacement.resolve();

      await assert.rejects(() => updating, /session replacement failed/);
      assert.equal(replaceCallCount, 2);
      assert.deepEqual(storage.getSettings().chatLayoutPreference, {
        header: "visible",
        actionDock: "expanded",
        sidePane: "context",
        priority: "dock-first",
      });
    } finally {
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("settings 更新時に API key 変更 provider の thread と telemetry を無効化する", async () => {
    const previousSettings = createDefaultAppSettings();
    const previousSessions = [createSession()];
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
      replaceAllSessions(nextSessions) {
        replacedSessions = nextSessions;
        return nextSessions;
      },
      replaceAuxiliarySessions(nextSessions) {
        return nextSessions;
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
    assert.deepEqual(clearContextCalls, ["session-1"]);
    assert.equal(replacedSessions[0]?.threadId, "");
    assert.deepEqual(replacedSessions[0]?.messages, previousSessions[0].messages);
    assert.deepEqual(invalidated, []);
  });

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
      replaceAllSessions(nextSessions) {
        return nextSessions;
      },
      replaceAuxiliarySessions(nextSessions) {
        replacedAuxiliarySessions = nextSessions;
        return nextSessions;
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
    assert.deepEqual(invalidated, ["codex:aux-1"]);
  });

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
        return createCatalogSnapshot(1);
      },
      ensureModelCatalogSeeded() {
        return createCatalogSnapshot(1);
      },
      importModelCatalogDocument(document, source) {
        importedSource = source;
        return {
          revision: 2,
          providers: document.providers,
        };
      },
      exportModelCatalogDocument() {
        return { providers: createCatalogSnapshot(1).providers };
      },
      replaceAllSessions(nextSessions) {
        replacedSessions = nextSessions;
        return nextSessions;
      },
      replaceAuxiliarySessions(nextSessions) {
        return nextSessions;
      },
      clearProviderQuotaTelemetry() {},
      clearSessionContextTelemetry() {},
      invalidateProviderSessionThread() {},
      broadcastSessions() {
        broadcasted = true;
      },
      broadcastAppSettings() {},
      broadcastModelCatalog() {
        broadcasted = true;
      },
    });

    const imported = await service.importModelCatalogDocument(importedDocument);

    assert.equal(imported.revision, 2);
    assert.equal(importedSource, "imported");
    assert.equal(replacedSessions[0]?.catalogRevision, 2);
    assert.equal(replacedSessions[0]?.model, "gpt-5.4");
    assert.deepEqual(replacedSessions[0]?.messages, previousSessions[0].messages);
    assert.equal(broadcasted, true);
  });

  it("model catalog import で auxiliary metadata も新 revision に移行する", async () => {
    const previousSessions = [createSession()];
    const previousAuxiliarySessions = [
      createAuxiliarySession({
        model: "missing-model",
        reasoningEffort: "high",
        threadId: "aux-thread-1",
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
      replaceAllSessions(nextSessions) {
        return nextSessions;
      },
      replaceAuxiliarySessions(nextSessions) {
        replacedAuxiliarySessions = nextSessions;
        return nextSessions;
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
    assert.deepEqual(replacedAuxiliarySessions[0]?.messages, previousAuxiliarySessions[0].messages);
    assert.deepEqual(invalidated, ["codex:aux-1"]);
  });

  it("model catalog import で companion metadata も新 revision に移行する", async () => {
    const previousSessions = [createSession()];
    const previousCompanionSessions = [
      createCompanionSession({
        model: "missing-model",
        reasoningEffort: "high",
        threadId: "companion-thread-1",
      }),
    ];
    const importedDocument: ModelCatalogDocument = {
      providers: createCatalogSnapshot(2).providers,
    };
    const invalidated: string[] = [];
    let replacedCompanionSessions: CompanionSession[] = [];

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
      listCompanionSessions() {
        return previousCompanionSessions;
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
      replaceAllSessions(nextSessions) {
        return nextSessions;
      },
      replaceAuxiliarySessions(nextSessions) {
        return nextSessions;
      },
      replaceCompanionSessions(nextSessions) {
        replacedCompanionSessions = nextSessions;
        return nextSessions;
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

    assert.equal(replacedCompanionSessions[0]?.catalogRevision, 2);
    assert.equal(replacedCompanionSessions[0]?.model, "gpt-5.4");
    assert.equal(replacedCompanionSessions[0]?.threadId, "");
    assert.deepEqual(replacedCompanionSessions[0]?.messages, previousCompanionSessions[0].messages);
    assert.deepEqual(invalidated, ["codex:companion-1"]);
  });

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

    assert.deepEqual(service.exportModelCatalogDocument(1), document);
  });

  it("session の partial/full reset は永続化成功後に全通知を閉じる", async () => {
    let sessions = [
      { ...createSession(), id: "session-partial-1" },
      { ...createSession(), id: "session-partial-2" },
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

  it("model catalog reset で auxiliary metadata も bundled catalog へ移行する", async () => {
    const sessions = [createSession()];
    const auxiliarySessions = [
      createAuxiliarySession({
        model: "missing-model",
        reasoningEffort: "high",
        threadId: "aux-thread-1",
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
      replaceAllSessions(nextSessions) {
        return nextSessions;
      },
      replaceAuxiliarySessions(nextSessions) {
        replacedAuxiliarySessions = nextSessions;
        return nextSessions;
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
    assert.deepEqual(replacedAuxiliarySessions[0]?.messages, auxiliarySessions[0].messages);
    assert.deepEqual(invalidated, ["codex:aux-1"]);
  });

  it("model catalog reset で companion metadata も bundled catalog へ移行する", async () => {
    const sessions = [createSession()];
    const companionSessions = [
      createCompanionSession({
        model: "missing-model",
        reasoningEffort: "high",
        threadId: "companion-thread-1",
      }),
    ];
    const invalidated: string[] = [];
    let replacedCompanionSessions: CompanionSession[] = [];

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
        return [];
      },
      listCompanionSessions() {
        return companionSessions;
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
      replaceAllSessions(nextSessions) {
        return nextSessions;
      },
      replaceAuxiliarySessions(nextSessions) {
        return nextSessions;
      },
      replaceCompanionSessions(nextSessions) {
        replacedCompanionSessions = nextSessions;
        return nextSessions;
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

    assert.equal(replacedCompanionSessions[0]?.catalogRevision, 3);
    assert.equal(replacedCompanionSessions[0]?.model, "gpt-5.4");
    assert.equal(replacedCompanionSessions[0]?.threadId, "");
    assert.deepEqual(replacedCompanionSessions[0]?.messages, companionSessions[0].messages);
    assert.deepEqual(invalidated, ["codex:companion-1"]);
  });
});


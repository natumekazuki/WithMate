import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Session } from "../../src/app-state.js";
import type { AuxiliarySession } from "../../src/auxiliary-session-state.js";
import { createDefaultAppSettings, type AppSettings } from "../../src/provider-settings-state.js";
import type { ModelCatalogDocument, ModelCatalogSnapshot } from "../../src/model-catalog.js";
import { SettingsCatalogService } from "../../src-electron/settings-catalog-service.js";

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
        return previousSettings;
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

  it("partial reset は target ごとの clear/reset と broadcast を実行する", async () => {
    const sessions = [createSession()];
    const calls: string[] = [];
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
      replaceAllSessions(nextSessions) {
        calls.push(`replace:${nextSessions.length}`);
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
      async recreateDatabaseFile() {
        calls.push("recreateDb");
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

    const result = await service.resetAppDatabase({
      targets: ["sessions", "appSettings", "projectMemory"],
    });

    assert.deepEqual(result.resetTargets, ["sessions", "auditLogs", "appSettings", "projectMemory"]);
    assert.deepEqual(calls, [
      "closeResetWindows",
      "clearAudit",
      "replace:0",
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
});


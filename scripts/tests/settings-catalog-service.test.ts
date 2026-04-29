import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Session } from "../../src/app-state.js";
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
  it("API key 変更対象 provider に実行中 session があると settings 更新を拒否する", () => {
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
      clearProviderQuotaTelemetry() {},
      clearSessionContextTelemetry() {},
      invalidateProviderSessionThread() {},
      broadcastSessions() {},
      broadcastAppSettings() {},
      broadcastModelCatalog() {},
    });

    assert.throws(
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

  it("settings 更新時に API key 変更 provider の thread と telemetry を無効化する", () => {
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

    const next = service.updateAppSettings({
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

  it("model catalog import で session を新 revision に移行して broadcast する", () => {
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

    const imported = service.importModelCatalogDocument(importedDocument);

    assert.equal(imported.revision, 2);
    assert.equal(importedSource, "imported");
    assert.equal(replacedSessions[0]?.catalogRevision, 2);
    assert.equal(replacedSessions[0]?.model, "gpt-5.4");
    assert.deepEqual(replacedSessions[0]?.messages, previousSessions[0].messages);
    assert.equal(broadcasted, true);
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
      resetMemoryOrchestration() {},
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
      resetMemoryOrchestration() {
        calls.push("resetMemory");
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
      "resetMemory",
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
});


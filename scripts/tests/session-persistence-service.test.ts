import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  buildNewSession,
  type CreateSessionInput,
  type Session,
} from "../../src/app-state.js";
import type { CharacterRuntimeSnapshot } from "../../src/character/character-catalog.js";
import { normalizeAppSettings } from "../../src/provider-settings-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import type { ModelCatalogProvider, ModelCatalogSnapshot } from "../../src/model-catalog.js";
import { SessionPersistenceService } from "../../src-electron/session-persistence-service.js";

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

function createProviderCatalog(id: string, enabled = true): ModelCatalogProvider {
  return {
    id,
    label: id,
    defaultModelId: enabled ? `${id}-default` : `${id}-disabled`,
    defaultReasoningEffort: "medium",
    models: [
      {
        id: enabled ? `${id}-default` : `${id}-disabled`,
        label: `${id} default`,
        reasoningEfforts: ["low", "medium", "high"],
      },
    ],
  };
}

function createSnapshot(): ModelCatalogSnapshot {
  return {
    revision: 2,
    providers: [
      createProviderCatalog("codex"),
      createProviderCatalog("copilot"),
    ],
  };
}

function createCharacterRuntimeSnapshot(overrides?: Partial<CharacterRuntimeSnapshot>): CharacterRuntimeSnapshot {
  return {
    characterId: "char-a",
    name: "A",
    description: "保存済み Character",
    iconFilePath: "",
    theme: { main: "#6f8cff", sub: "#6fb8c7" },
    definitionMarkdown: [
      "---",
      "schema: withmate.character.v1",
      "name: A",
      "---",
      "# Character",
      "保存済み snapshot の character.md。",
    ].join("\n"),
    definitionSha256: "sha256-character-definition",
    definitionByteSize: 128,
    snapshotAt: "2026-06-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("SessionPersistenceService", () => {
  it("createSession は有効な provider と model を解決して保存する", async () => {
    const storedSessions: Session[] = [];
    const syncedSessionIds: string[] = [];
    const broadcastedSessionIds: string[][] = [];
    const snapshot = createSnapshot();
    const characterRuntimeSnapshot = createCharacterRuntimeSnapshot();
    const snapshotCharacterIds: string[] = [];
    let persistedSession: Session | null = null;

    const service = new SessionPersistenceService({
      getSessions() {
        return storedSessions;
      },
      setSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      getSession() {
        return null;
      },
      isSessionRunInFlight() {
        return false;
      },
      upsertStoredSession(session) {
        persistedSession = session;
        storedSessions.splice(0, storedSessions.length, session);
        return session;
      },
      replaceStoredSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      listStoredSessions() {
        return [...storedSessions];
      },
      deleteStoredSession() {},
      getAppSettings() {
        return normalizeAppSettings({
          providers: {
            codex: { enabled: true },
            copilot: { enabled: false },
          },
        });
      },
      getModelCatalogSnapshot() {
        return snapshot;
      },
      createCharacterRuntimeSnapshot(characterId) {
        snapshotCharacterIds.push(characterId);
        return characterRuntimeSnapshot;
      },
      syncSessionDependencies(session) {
        syncedSessionIds.push(session.id);
      },
      clearSessionContextTelemetry() {},
      clearSessionBackgroundActivities() {},
      clearCharacterReflectionCheckpoint() {},
      clearInFlightCharacterReflection() {},
      invalidateProviderSessionThread() {},
      closeSessionWindow() {},
      broadcastSessions(sessionIds) {
        broadcastedSessionIds.push(Array.from(sessionIds ?? []));
      },
    });

    const created = await service.createSession({
      taskTitle: "New Session",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "char-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
      provider: "copilot",
      model: "copilot-default",
      reasoningEffort: "high",
      customAgentName: "",
      allowedAdditionalDirectories: ["C:/workspace/..", "C:/workspace/external"],
    } satisfies CreateSessionInput);

    assert.equal(created.provider, "codex");
    assert.equal(created.model, "codex-default");
    assert.equal(created.reasoningEffort, "medium");
    assert.equal(created.customAgentName, "");
    assert.equal(created.catalogRevision, 2);
    assert.equal(created.allowedAdditionalDirectories.length, 1);
    assert.deepEqual(snapshotCharacterIds, ["char-a"]);
    assert.deepEqual(created.characterRuntimeSnapshot, characterRuntimeSnapshot);
    assert.notEqual(created.characterRuntimeSnapshot, characterRuntimeSnapshot);
    assert.deepEqual(persistedSession?.characterRuntimeSnapshot, characterRuntimeSnapshot);
    assert.equal(storedSessions[0]?.characterRuntimeSnapshot, null);
    assert.deepEqual(syncedSessionIds, [created.id]);
    assert.deepEqual(broadcastedSessionIds, [[created.id]]);
  });

  it("createSession は input の CharacterRuntimeSnapshot を優先して保存する", async () => {
    const storedSessions: Session[] = [];
    const inputSnapshot = createCharacterRuntimeSnapshot({
      definitionMarkdown: "# Character\ninput snapshot",
      definitionSha256: "sha256-input",
    });
    let fallbackSnapshotCalls = 0;
    let persistedSession: Session | null = null;

    const service = new SessionPersistenceService({
      getSessions() {
        return storedSessions;
      },
      setSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      getSession() {
        return null;
      },
      isSessionRunInFlight() {
        return false;
      },
      upsertStoredSession(session) {
        persistedSession = session;
        storedSessions.splice(0, storedSessions.length, session);
        return session;
      },
      replaceStoredSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      listStoredSessions() {
        return [...storedSessions];
      },
      deleteStoredSession() {},
      getAppSettings() {
        return normalizeAppSettings();
      },
      getModelCatalogSnapshot() {
        return createSnapshot();
      },
      createCharacterRuntimeSnapshot() {
        fallbackSnapshotCalls += 1;
        return createCharacterRuntimeSnapshot({ definitionSha256: "sha256-fallback" });
      },
      syncSessionDependencies() {},
      clearSessionContextTelemetry() {},
      clearSessionBackgroundActivities() {},
      clearCharacterReflectionCheckpoint() {},
      clearInFlightCharacterReflection() {},
      invalidateProviderSessionThread() {},
      closeSessionWindow() {},
      broadcastSessions() {},
    });

    const created = await service.createSession({
      taskTitle: "New Session",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "char-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      characterRuntimeSnapshot: inputSnapshot,
      approvalMode: DEFAULT_APPROVAL_MODE,
    } satisfies CreateSessionInput);

    assert.equal(fallbackSnapshotCalls, 0);
    assert.deepEqual(created.characterRuntimeSnapshot, inputSnapshot);
    assert.notEqual(created.characterRuntimeSnapshot, inputSnapshot);
    assert.deepEqual(persistedSession?.characterRuntimeSnapshot, inputSnapshot);
    assert.equal(storedSessions[0]?.characterRuntimeSnapshot, null);
  });

  it("upsertSession は summary-only session 更新でも既存 messages を保持する", async () => {
    const fullSession = createSession({
      id: "session-with-messages",
      taskTitle: "Before",
      messages: [
        { role: "user", text: "残すメッセージ" },
        { role: "assistant", text: "残す返答" },
      ],
    });
    const summaryOnlySession: Session = {
      ...fullSession,
      taskTitle: "After",
      messages: [],
      stream: [],
    };
    let storedSession: Session | null = null;
    const inMemorySessions = [summaryOnlySession];

    const service = new SessionPersistenceService({
      getSessions() {
        return inMemorySessions;
      },
      setSessions(nextSessions) {
        inMemorySessions.splice(0, inMemorySessions.length, ...nextSessions);
      },
      getSession(sessionId) {
        return inMemorySessions.find((session) => session.id === sessionId) ?? null;
      },
      getStoredSession(sessionId) {
        return sessionId === fullSession.id ? fullSession : null;
      },
      isSessionRunInFlight() {
        return false;
      },
      upsertStoredSession(session) {
        storedSession = session;
        return session;
      },
      replaceStoredSessions() {},
      listStoredSessions() {
        return [];
      },
      deleteStoredSession() {},
      getAppSettings() {
        return normalizeAppSettings();
      },
      getModelCatalogSnapshot() {
        return createSnapshot();
      },
      syncSessionDependencies() {},
      clearSessionContextTelemetry() {},
      clearSessionBackgroundActivities() {},
      clearCharacterReflectionCheckpoint() {},
      clearInFlightCharacterReflection() {},
      invalidateProviderSessionThread() {},
      closeSessionWindow() {},
      broadcastSessions() {},
    });

    const updated = await service.upsertSession(summaryOnlySession);

    assert.deepEqual(
      storedSession?.messages.map((message) => message.text),
      ["残すメッセージ", "残す返答"],
    );
    assert.deepEqual(updated.messages.map((message) => message.text), ["残すメッセージ", "残す返答"]);
    assert.deepEqual(inMemorySessions[0]?.messages, []);
  });

  it("createSession は last-used model / reasoning / customAgentName を正規化して保存する", async () => {
    const storedSessions: Session[] = [];

    const service = new SessionPersistenceService({
      getSessions() {
        return storedSessions;
      },
      setSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      getSession() {
        return null;
      },
      isSessionRunInFlight() {
        return false;
      },
      upsertStoredSession(session) {
        storedSessions.splice(0, storedSessions.length, session);
        return session;
      },
      replaceStoredSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      listStoredSessions() {
        return [...storedSessions];
      },
      deleteStoredSession() {},
      getAppSettings() {
        return normalizeAppSettings({
          codingProviderSettings: {
            codex: { enabled: true },
            copilot: { enabled: true },
          },
        });
      },
      getModelCatalogSnapshot() {
        return createSnapshot();
      },
      syncSessionDependencies() {},
      clearSessionContextTelemetry() {},
      clearSessionBackgroundActivities() {},
      clearCharacterReflectionCheckpoint() {},
      clearInFlightCharacterReflection() {},
      invalidateProviderSessionThread() {},
      closeSessionWindow() {},
      broadcastSessions() {},
    });

    const created = await service.createSession({
      taskTitle: "New Session",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "char-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
      provider: "copilot",
      model: "copilot-default",
      reasoningEffort: "high",
      customAgentName: "planner",
    } satisfies CreateSessionInput);

    assert.equal(created.provider, "copilot");
    assert.equal(created.model, "copilot-default");
    assert.equal(created.reasoningEffort, "high");
    assert.equal(created.customAgentName, "planner");
  });

  it("updateSession は provider 変更時に telemetry をクリアし、thread reset 時は provider cache を invalidate する", async () => {
    const baseSession = createSession({ provider: "codex", model: "codex-default", threadId: "thread-1" });
    const storedSessions: Session[] = [baseSession];
    const clearedTelemetry: string[] = [];
    const invalidatedThreads: Array<{ providerId: string | null | undefined; sessionId: string }> = [];
    const service = new SessionPersistenceService({
      getSessions() {
        return storedSessions;
      },
      setSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      getSession(sessionId) {
        return storedSessions.find((session) => session.id === sessionId) ?? null;
      },
      isSessionRunInFlight() {
        return false;
      },
      upsertStoredSession(session) {
        storedSessions.splice(0, storedSessions.length, session);
        return session;
      },
      replaceStoredSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      listStoredSessions() {
        return [...storedSessions];
      },
      deleteStoredSession() {},
      getAppSettings() {
        return normalizeAppSettings({});
      },
      getModelCatalogSnapshot() {
        return createSnapshot();
      },
      syncSessionDependencies() {},
      clearSessionContextTelemetry(sessionId) {
        clearedTelemetry.push(sessionId);
      },
      clearSessionBackgroundActivities() {},
      clearCharacterReflectionCheckpoint() {},
      clearInFlightCharacterReflection() {},
      invalidateProviderSessionThread(providerId, sessionId) {
        invalidatedThreads.push({ providerId, sessionId });
      },
      closeSessionWindow() {},
      broadcastSessions() {},
    });

    const updated = await service.updateSession({ ...baseSession, provider: "copilot", model: "copilot-default" });
    assert.equal(updated.provider, "copilot");
    assert.equal(updated.threadId, "");
    assert.deepEqual(clearedTelemetry, [baseSession.id]);
    assert.deepEqual(invalidatedThreads, [{ providerId: "codex", sessionId: baseSession.id }]);

    storedSessions.splice(0, storedSessions.length, createSession({ id: baseSession.id, runState: "running", status: "running" }));
    await assert.rejects(
      () => service.updateSession({ ...storedSessions[0], taskTitle: "blocked" }),
      /実行中のセッションは更新できない/,
    );
  });

  it("updateSession は model / reasoning 変更時に threadId を維持する", async () => {
    const baseSession = createSession({
      provider: "copilot",
      model: "copilot-default",
      reasoningEffort: "medium",
      threadId: "thread-keep",
    });
    const storedSessions: Session[] = [baseSession];
    const invalidatedThreads: Array<{ providerId: string | null | undefined; sessionId: string }> = [];

    const service = new SessionPersistenceService({
      getSessions() {
        return storedSessions;
      },
      setSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      getSession(sessionId) {
        return storedSessions.find((session) => session.id === sessionId) ?? null;
      },
      isSessionRunInFlight() {
        return false;
      },
      upsertStoredSession(session) {
        storedSessions.splice(0, storedSessions.length, session);
        return session;
      },
      replaceStoredSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      listStoredSessions() {
        return [...storedSessions];
      },
      deleteStoredSession() {},
      getAppSettings() {
        return normalizeAppSettings({});
      },
      getModelCatalogSnapshot() {
        return createSnapshot();
      },
      syncSessionDependencies() {},
      clearSessionContextTelemetry() {},
      clearSessionBackgroundActivities() {},
      clearCharacterReflectionCheckpoint() {},
      clearInFlightCharacterReflection() {},
      invalidateProviderSessionThread(providerId, sessionId) {
        invalidatedThreads.push({ providerId, sessionId });
      },
      closeSessionWindow() {},
      broadcastSessions() {},
    });

    const updated = await service.updateSession({
      ...baseSession,
      model: "copilot-default",
      reasoningEffort: "high",
      threadId: "thread-keep",
    });

    assert.equal(updated.threadId, "thread-keep");
    assert.deepEqual(invalidatedThreads, []);
  });

  it("updateSession は runtime parameter 変更時に threadId を維持する", async () => {
    const baseSession = createSession({
      provider: "codex",
      model: "codex-default",
      reasoningEffort: "medium",
      approvalMode: "untrusted",
      codexSandboxMode: "workspace-write",
      allowedAdditionalDirectories: ["C:/external-a"],
      threadId: "thread-keep",
    });
    const storedSessions: Session[] = [baseSession];
    const invalidatedThreads: Array<{ providerId: string | null | undefined; sessionId: string }> = [];

    const service = new SessionPersistenceService({
      getSessions() {
        return storedSessions;
      },
      setSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      getSession(sessionId) {
        return storedSessions.find((session) => session.id === sessionId) ?? null;
      },
      isSessionRunInFlight() {
        return false;
      },
      upsertStoredSession(session) {
        storedSessions.splice(0, storedSessions.length, session);
        return session;
      },
      replaceStoredSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      listStoredSessions() {
        return [...storedSessions];
      },
      deleteStoredSession() {},
      getAppSettings() {
        return normalizeAppSettings({});
      },
      getModelCatalogSnapshot() {
        return createSnapshot();
      },
      syncSessionDependencies() {},
      clearSessionContextTelemetry() {},
      clearSessionBackgroundActivities() {},
      clearCharacterReflectionCheckpoint() {},
      clearInFlightCharacterReflection() {},
      invalidateProviderSessionThread(providerId, sessionId) {
        invalidatedThreads.push({ providerId, sessionId });
      },
      closeSessionWindow() {},
      broadcastSessions() {},
    });

    const updated = await service.updateSession({
      ...baseSession,
      approvalMode: "never",
      codexSandboxMode: "danger-full-access",
      allowedAdditionalDirectories: ["C:/external-b"],
      threadId: "thread-keep",
    });

    assert.equal(updated.threadId, "thread-keep");
    assert.deepEqual(updated.allowedAdditionalDirectories, [path.resolve("C:/external-b")]);
    assert.deepEqual(invalidatedThreads, []);
  });

  it("legacy read-only session は update/upsert できない", async () => {
    const legacySession = createSession({
      accessMode: "legacy_readonly",
      sourceSchemaVersion: 3,
      characterIconPath: "",
    });
    const storedSessions: Session[] = [legacySession];

    const service = new SessionPersistenceService({
      getSessions() {
        return storedSessions;
      },
      setSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      getSession(sessionId) {
        return storedSessions.find((session) => session.id === sessionId) ?? null;
      },
      isSessionRunInFlight() {
        return false;
      },
      upsertStoredSession(session) {
        storedSessions.splice(0, storedSessions.length, session);
        return session;
      },
      replaceStoredSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      listStoredSessions() {
        return [...storedSessions];
      },
      deleteStoredSession() {},
      getAppSettings() {
        return normalizeAppSettings({});
      },
      getModelCatalogSnapshot() {
        return createSnapshot();
      },
      syncSessionDependencies() {},
      clearSessionContextTelemetry() {},
      clearSessionBackgroundActivities() {},
      clearCharacterReflectionCheckpoint() {},
      clearInFlightCharacterReflection() {},
      invalidateProviderSessionThread() {},
      closeSessionWindow() {},
      broadcastSessions() {},
    });

    await assert.rejects(
      () => service.updateSession({ ...legacySession, taskTitle: "Blocked Update" }),
      /閲覧専用セッションは更新できない/,
    );
    await assert.rejects(
      () => service.upsertSession({ ...legacySession, taskTitle: "Blocked Upsert" }),
      /閲覧専用セッションは更新できない/,
    );
    assert.equal(storedSessions[0]?.taskTitle, legacySession.taskTitle);
  });

  it("deleteSession は関連状態を片付けて window close を呼ぶ", async () => {
    const session = createSession();
    const storedSessions: Session[] = [session];
    const deleted: string[] = [];
    const clearedBackground: string[] = [];
    const closedWindows: string[] = [];
    const broadcastedSessionIds: string[][] = [];

    const service = new SessionPersistenceService({
      getSessions() {
        return storedSessions;
      },
      setSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      getSession(sessionId) {
        return storedSessions.find((entry) => entry.id === sessionId) ?? null;
      },
      isSessionRunInFlight() {
        return false;
      },
      upsertStoredSession(next) {
        storedSessions.splice(0, storedSessions.length, next);
        return next;
      },
      replaceStoredSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      listStoredSessions() {
        return [...storedSessions];
      },
      deleteStoredSession(sessionId) {
        deleted.push(sessionId);
        const remaining = storedSessions.filter((entry) => entry.id !== sessionId);
        storedSessions.splice(0, storedSessions.length, ...remaining);
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      getModelCatalogSnapshot() {
        return createSnapshot();
      },
      syncSessionDependencies() {},
      clearSessionContextTelemetry() {},
      clearSessionBackgroundActivities(sessionId) {
        clearedBackground.push(sessionId);
      },
      clearCharacterReflectionCheckpoint() {},
      clearInFlightCharacterReflection() {},
      invalidateProviderSessionThread() {},
      closeSessionWindow(sessionId) {
        closedWindows.push(sessionId);
      },
      broadcastSessions(sessionIds) {
        broadcastedSessionIds.push(Array.from(sessionIds ?? []));
      },
    });

    await service.deleteSession(session.id);

    assert.deepEqual(deleted, [session.id]);
    assert.deepEqual(clearedBackground, [session.id]);
    assert.deepEqual(closedWindows, [session.id]);
    assert.deepEqual(broadcastedSessionIds, [[session.id]]);
    assert.equal(storedSessions.length, 0);
  });

  it("deleteSessionsLastActiveBefore は対象だけ bulk 削除し running は skip する", async () => {
    const oldSession = createSession({ id: "old", updatedAt: "2026-06-01T00:00:00.000Z" });
    const runningSession = createSession({
      id: "running",
      status: "running",
      runState: "running",
      updatedAt: "2026-06-01T01:00:00.000Z",
    });
    const recentSession = createSession({ id: "recent", updatedAt: "2026-07-02T00:00:00.000Z" });
    const storedSessions: Session[] = [oldSession, runningSession, recentSession];
    const deletedBatches: string[][] = [];
    const clearedTelemetry: string[] = [];
    const clearedBackground: string[] = [];
    const closedWindows: string[] = [];
    const broadcastedSessionIds: string[][] = [];

    const service = new SessionPersistenceService({
      getSessions() {
        return storedSessions;
      },
      setSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      getSession(sessionId) {
        return storedSessions.find((entry) => entry.id === sessionId) ?? null;
      },
      isSessionRunInFlight(sessionId) {
        return sessionId === runningSession.id;
      },
      upsertStoredSession(next) {
        storedSessions.splice(0, storedSessions.length, next);
        return next;
      },
      replaceStoredSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      listStoredSessions() {
        return [...storedSessions];
      },
      listStoredSessionIdsLastActiveBefore() {
        return [oldSession.id, runningSession.id];
      },
      deleteStoredSessions(sessionIds) {
        deletedBatches.push([...sessionIds]);
        const deletedSessionIds = new Set(sessionIds);
        const remaining = storedSessions.filter((entry) => !deletedSessionIds.has(entry.id));
        storedSessions.splice(0, storedSessions.length, ...remaining);
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      getModelCatalogSnapshot() {
        return createSnapshot();
      },
      syncSessionDependencies() {},
      clearSessionContextTelemetry(sessionId) {
        clearedTelemetry.push(sessionId);
      },
      clearSessionBackgroundActivities(sessionId) {
        clearedBackground.push(sessionId);
      },
      clearCharacterReflectionCheckpoint() {},
      clearInFlightCharacterReflection() {},
      invalidateProviderSessionThread() {},
      closeSessionWindow(sessionId) {
        closedWindows.push(sessionId);
      },
      broadcastSessions(sessionIds) {
        broadcastedSessionIds.push(Array.from(sessionIds ?? []));
      },
    });

    const result = await service.deleteSessionsLastActiveBefore({
      cutoffDate: "2026-07-01",
      cutoffTimestampMs: Date.parse("2026-07-01T00:00:00.000Z"),
      cutoffIso: "2026-07-01T00:00:00.000Z",
    });

    assert.deepEqual(result.deletedSessionIds, [oldSession.id]);
    assert.deepEqual(result.skippedRunningSessionIds, [runningSession.id]);
    assert.deepEqual(deletedBatches, [[oldSession.id]]);
    assert.deepEqual(clearedTelemetry, [oldSession.id]);
    assert.deepEqual(clearedBackground, [oldSession.id]);
    assert.deepEqual(closedWindows, [oldSession.id]);
    assert.deepEqual(broadcastedSessionIds, [[oldSession.id]]);
    assert.deepEqual(storedSessions.map((session) => session.id), [runningSession.id, recentSession.id]);
  });

  it("replaceAllSessions は removed/provider change の副作用と invalidation を処理する", async () => {
    const sessionA = createSession({ id: "session-a", provider: "codex", model: "codex-default" });
    const sessionB = createSession({ id: "session-b", provider: "copilot", model: "copilot-default" });
    const nextSessionA = { ...sessionA, provider: "copilot", model: "copilot-default", threadId: "" };
    const storedSessions: Session[] = [sessionA, sessionB];
    const clearedTelemetry: string[] = [];
    const clearedBackground: string[] = [];
    const invalidated: Array<{ providerId: string | null | undefined; sessionId: string }> = [];
    const broadcastedSessionIds: string[][] = [];
    const replaceOrder: string[] = [];

    const service = new SessionPersistenceService({
      getSessions() {
        return storedSessions;
      },
      setSessions(nextSessions) {
        replaceOrder.push("setSessions");
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      getSession(sessionId) {
        return storedSessions.find((entry) => entry.id === sessionId) ?? null;
      },
      isSessionRunInFlight() {
        return false;
      },
      upsertStoredSession(next) {
        storedSessions.splice(0, storedSessions.length, next);
        return next;
      },
      async replaceStoredSessions(nextSessions) {
        replaceOrder.push("replaceStoredSessions:start");
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        replaceOrder.push("replaceStoredSessions:end");
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      listStoredSessions() {
        return [...storedSessions];
      },
      deleteStoredSession() {},
      getAppSettings() {
        return normalizeAppSettings({});
      },
      getModelCatalogSnapshot() {
        return createSnapshot();
      },
      syncSessionDependencies() {},
      clearSessionContextTelemetry(sessionId) {
        clearedTelemetry.push(sessionId);
      },
      clearSessionBackgroundActivities(sessionId) {
        clearedBackground.push(sessionId);
      },
      invalidateProviderSessionThread(providerId, sessionId) {
        invalidated.push({ providerId, sessionId });
      },
      closeSessionWindow() {},
      broadcastSessions(sessionIds) {
        broadcastedSessionIds.push(Array.from(sessionIds ?? []));
      },
    });

    const replaced = await service.replaceAllSessions([nextSessionA], {
      invalidateSessionIds: ["session-a"],
    });

    assert.equal(replaced.length, 1);
    assert.deepEqual(clearedTelemetry.sort(), ["session-a", "session-b"]);
    assert.deepEqual(clearedBackground, ["session-b"]);
    assert.deepEqual(invalidated, [{ providerId: "copilot", sessionId: "session-a" }]);
    assert.deepEqual(broadcastedSessionIds, [["session-a", "session-b"]]);
    assert.deepEqual(replaceOrder, ["replaceStoredSessions:start", "replaceStoredSessions:end", "setSessions"]);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildNewSession,
  type CreateSessionInput,
  type Session,
} from "../../src/app-state.js";
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

describe("SessionPersistenceService", () => {
  it("createSession は有効な provider と model を解決して保存する", () => {
    const storedSessions: Session[] = [];
    const syncedSessionIds: string[] = [];
    const broadcastedSessionIds: string[][] = [];
    const snapshot = createSnapshot();

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
          providers: {
            codex: { enabled: true },
            copilot: { enabled: false },
          },
        });
      },
      getModelCatalogSnapshot() {
        return snapshot;
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

    const created = service.createSession({
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
    assert.deepEqual(syncedSessionIds, [created.id]);
    assert.deepEqual(broadcastedSessionIds, [[created.id]]);
  });

  it("createSession は last-used model / reasoning / customAgentName を正規化して保存する", () => {
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

    const created = service.createSession({
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

  it("updateSession は provider 変更時に telemetry をクリアし、thread reset 時は provider cache を invalidate する", () => {
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

    const updated = service.updateSession({ ...baseSession, provider: "copilot", model: "copilot-default" });
    assert.equal(updated.provider, "copilot");
    assert.equal(updated.threadId, "");
    assert.deepEqual(clearedTelemetry, [baseSession.id]);
    assert.deepEqual(invalidatedThreads, [{ providerId: "codex", sessionId: baseSession.id }]);

    storedSessions.splice(0, storedSessions.length, createSession({ id: baseSession.id, runState: "running", status: "running" }));
    assert.throws(
      () => service.updateSession({ ...storedSessions[0], taskTitle: "blocked" }),
      /実行中のセッションは更新できない/,
    );
  });

  it("updateSession は model / reasoning 変更時に threadId を空にして invalidate する", () => {
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

    const updated = service.updateSession({
      ...baseSession,
      model: "copilot-default",
      reasoningEffort: "high",
      threadId: "thread-keep",
    });

    assert.equal(updated.threadId, "");
    assert.deepEqual(invalidatedThreads, [{ providerId: "copilot", sessionId: baseSession.id }]);
  });

  it("deleteSession は関連状態を片付けて window close を呼ぶ", () => {
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

    service.deleteSession(session.id);

    assert.deepEqual(deleted, [session.id]);
    assert.deepEqual(clearedBackground, [session.id]);
    assert.deepEqual(closedWindows, [session.id]);
    assert.deepEqual(broadcastedSessionIds, [[session.id]]);
    assert.equal(storedSessions.length, 0);
  });

  it("replaceAllSessions は removed/provider change の副作用と invalidation を処理する", () => {
    const sessionA = createSession({ id: "session-a", provider: "codex", model: "codex-default" });
    const sessionB = createSession({ id: "session-b", provider: "copilot", model: "copilot-default" });
    const nextSessionA = { ...sessionA, provider: "copilot", model: "copilot-default", threadId: "" };
    const storedSessions: Session[] = [sessionA, sessionB];
    const clearedTelemetry: string[] = [];
    const clearedBackground: string[] = [];
    const clearedCheckpoints: string[] = [];
    const clearedInflight: string[] = [];
    const invalidated: Array<{ providerId: string | null | undefined; sessionId: string }> = [];
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
      clearCharacterReflectionCheckpoint(sessionId) {
        clearedCheckpoints.push(sessionId);
      },
      clearInFlightCharacterReflection(sessionId) {
        clearedInflight.push(sessionId);
      },
      invalidateProviderSessionThread(providerId, sessionId) {
        invalidated.push({ providerId, sessionId });
      },
      closeSessionWindow() {},
      broadcastSessions(sessionIds) {
        broadcastedSessionIds.push(Array.from(sessionIds ?? []));
      },
    });

    const replaced = service.replaceAllSessions([nextSessionA], {
      invalidateSessionIds: ["session-a"],
    });

    assert.equal(replaced.length, 1);
    assert.deepEqual(clearedTelemetry.sort(), ["session-a", "session-b"]);
    assert.deepEqual(clearedBackground, ["session-b"]);
    assert.deepEqual(clearedCheckpoints, ["session-b"]);
    assert.deepEqual(clearedInflight, ["session-b"]);
    assert.deepEqual(invalidated, [{ providerId: "copilot", sessionId: "session-a" }]);
    assert.deepEqual(broadcastedSessionIds, [["session-a", "session-b"]]);
  });
});

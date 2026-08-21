import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  buildNewSession,
  projectSessionSummary,
  type CreateSessionInput,
  type Session,
} from "../../src/app-state.js";
import type { CharacterRuntimeSnapshot } from "../../src/character/character-catalog.js";
import { normalizeAppSettings } from "../../src/provider-settings-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import type { ModelCatalogProvider, ModelCatalogSnapshot } from "../../src/model-catalog.js";
import { CharacterAffectTurnOwnershipCoordinator } from "../../src-electron/character-affect-turn-ownership-coordinator.js";
import { SessionPersistenceService } from "../../src-electron/session-persistence-service.js";

function createSession(overrides?: Partial<Session>): Session {
  const session = buildNewSession({
    id: overrides?.id,
    sessionKind: overrides?.sessionKind,
    taskTitle: "Persistence Test",
    workspaceLabel: "workspace",
    workspacePath: "C:/workspace",
    branch: "main",
    characterId: "char-a",
    character: "A",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    approvalMode: DEFAULT_APPROVAL_MODE,
  });
  return {
    ...session,
    ...overrides,
    roleBinding: overrides?.roleBinding ?? session.roleBinding,
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
  it("外部CRUDで保存済みSessionをcacheへ反映し対象IDだけbroadcastする", () => {
    const existing = createSession({ id: "existing", taskTitle: "Existing" });
    let cachedSessions = [existing];
    const broadcasts: string[][] = [];
    const service = new SessionPersistenceService({
      getSessions: () => cachedSessions,
      setSessions: (next) => { cachedSessions = next; },
      getSession: (sessionId) => cachedSessions.find((session) => session.id === sessionId) ?? null,
      isSessionRunInFlight: () => false,
      upsertStoredSession: (session) => session,
      replaceStoredSessions: () => undefined,
      listStoredSessions: () => cachedSessions,
      getAppSettings: () => normalizeAppSettings({}),
      getModelCatalogSnapshot: createSnapshot,
      syncSessionDependencies: () => undefined,
      clearSessionContextTelemetry: () => undefined,
      clearSessionBackgroundActivities: () => undefined,
      invalidateProviderSessionThread: () => undefined,
      closeSessionWindow: () => undefined,
      broadcastSessions: (sessionIds) => broadcasts.push(Array.from(sessionIds ?? [])),
    });
    const created = createSession({ id: "external", taskTitle: "Created externally" });

    service.publishStoredSession(created);
    service.publishStoredSessionSummary({
      ...projectSessionSummary(created),
      taskTitle: "Renamed externally",
      updatedAt: "2026-08-11T00:10:00.000Z",
    });

    assert.deepEqual(cachedSessions.map((session) => session.id), ["external", "existing"]);
    assert.equal(cachedSessions[0]?.taskTitle, "Renamed externally");
    assert.deepEqual(broadcasts, [["external"], ["external"]]);
  });

  it("setSessionPinnedは実行状態とupdatedAtを変えずにcacheとbroadcastを更新する", async () => {
    const session = createSession({
      id: "pin-target",
      status: "running",
      runState: "running",
      accessMode: "legacy_readonly",
      sourceSchemaVersion: 4,
      updatedAt: "2026-08-09T04:38:00.000Z",
      isPinned: false,
    });
    let cachedSessions = [session];
    const broadcasts: string[][] = [];
    const service = new SessionPersistenceService({
      getSessions: () => cachedSessions,
      setSessions: (next) => { cachedSessions = next; },
      getSession: () => session,
      isSessionRunInFlight: () => true,
      upsertStoredSession: (next) => next,
      replaceStoredSessions: () => undefined,
      setStoredSessionPinned: (sessionId, isPinned) => ({
        ...projectSessionSummary(session),
        id: sessionId,
        isPinned,
      }),
      listStoredSessions: () => [session],
      getAppSettings: () => normalizeAppSettings({}),
      getModelCatalogSnapshot: createSnapshot,
      syncSessionDependencies: () => undefined,
      clearSessionContextTelemetry: () => undefined,
      clearSessionBackgroundActivities: () => undefined,
      invalidateProviderSessionThread: () => undefined,
      closeSessionWindow: () => undefined,
      broadcastSessions: (sessionIds) => broadcasts.push(Array.from(sessionIds ?? [])),
    });

    const saved = await service.setSessionPinned(session.id, true);

    assert.equal(saved.isPinned, true);
    assert.equal(saved.updatedAt, session.updatedAt);
    assert.equal(cachedSessions[0]?.status, "running");
    assert.equal(cachedSessions[0]?.runState, "running");
    assert.equal(cachedSessions[0]?.isPinned, true);
    assert.deepEqual(broadcasts, [[session.id]]);
  });

  it("pin変更の後にstaleなrunning・retry・terminal保存が続いても最新のpinを維持する", async () => {
    const runningSession = createSession({
      id: "pin-during-run",
      status: "running",
      runState: "running",
      isPinned: false,
    });
    let cachedSessions = [runningSession];
    let storedSession = runningSession;
    const service = new SessionPersistenceService({
      getSessions: () => cachedSessions,
      setSessions: (next) => { cachedSessions = next; },
      getSession: (sessionId) => cachedSessions.find((session) => session.id === sessionId) ?? null,
      isSessionRunInFlight: () => true,
      upsertStoredSession: (next) => {
        storedSession = next;
        return next;
      },
      upsertStoredTerminalSession: (next) => {
        storedSession = next;
        return next;
      },
      replaceStoredSessions: () => undefined,
      setStoredSessionPinned: (sessionId, isPinned) => {
        storedSession = { ...storedSession, isPinned };
        return { ...projectSessionSummary(storedSession), id: sessionId, isPinned };
      },
      listStoredSessions: () => [storedSession],
      getAppSettings: () => normalizeAppSettings({}),
      getModelCatalogSnapshot: createSnapshot,
      syncSessionDependencies: () => undefined,
      clearSessionContextTelemetry: () => undefined,
      clearSessionBackgroundActivities: () => undefined,
      invalidateProviderSessionThread: () => undefined,
      closeSessionWindow: () => undefined,
      broadcastSessions: () => undefined,
    });
    const staleCompletedSession = createSession({
      ...runningSession,
      status: "idle",
      runState: "idle",
      isPinned: false,
      messages: [...runningSession.messages, { role: "assistant", text: "done" }],
    });

    const pinWrite = service.setSessionPinned(runningSession.id, true);
    const staleRunningWrite = service.upsertSessionPreservingPin({
      ...runningSession,
      threadId: "thread-stale",
      isPinned: false,
    });
    const staleRetryWrite = service.upsertSessionPreservingPin({
      ...runningSession,
      threadId: "",
      isPinned: false,
    });
    const terminalWrite = service.upsertTerminalSession(staleCompletedSession, {
      auditLogId: 1,
      sessionId: staleCompletedSession.id,
      phase: "completed",
      assistantMessageSeq: staleCompletedSession.messages.length - 1,
      threadId: staleCompletedSession.threadId,
      errorMessage: "",
      completedAt: "2026-08-16T00:00:00.000Z",
    });
    await Promise.all([pinWrite, staleRunningWrite, staleRetryWrite, terminalWrite]);

    assert.equal(storedSession.isPinned, true);
    assert.equal(storedSession.runState, "idle");
    assert.equal(storedSession.messages.at(-1)?.text, "done");
    assert.equal(cachedSessions[0]?.isPinned, true);
  });

  it("terminal commit後のprojection failureを保存済み結果へ波及させない", async () => {
    for (const failingProjection of ["dependency", "cache", "broadcast"] as const) {
      const runningSession = createSession({
        id: `terminal-projection-${failingProjection}`,
        status: "running",
        runState: "running",
      });
      const terminalSession = createSession({
        ...runningSession,
        status: "idle",
        runState: "idle",
        messages: [...runningSession.messages, { role: "assistant", text: "done" }],
      });
      let cachedSessions = [runningSession];
      let persistedSession = runningSession;
      const attemptedProjections: string[] = [];
      const service = new SessionPersistenceService({
        getSessions: () => cachedSessions,
        setSessions(nextSessions) {
          attemptedProjections.push("cache");
          if (failingProjection === "cache") {
            throw new Error("cache projection failed");
          }
          cachedSessions = nextSessions;
        },
        getSession: (sessionId) => cachedSessions.find((session) => session.id === sessionId) ?? null,
        isSessionRunInFlight: () => true,
        upsertStoredSession(next) {
          persistedSession = next;
          return next;
        },
        upsertStoredTerminalSession(next) {
          persistedSession = next;
          return next;
        },
        replaceStoredSessions: () => undefined,
        setStoredSessionPinned: (_sessionId, isPinned) => ({ ...persistedSession, isPinned }),
        listStoredSessions: () => [persistedSession],
        getAppSettings: () => normalizeAppSettings({}),
        getModelCatalogSnapshot: createSnapshot,
        syncSessionDependencies() {
          attemptedProjections.push("dependency");
          if (failingProjection === "dependency") {
            throw new Error("dependency projection failed");
          }
        },
        clearSessionContextTelemetry: () => undefined,
        clearSessionBackgroundActivities: () => undefined,
        invalidateProviderSessionThread: () => undefined,
        closeSessionWindow: () => undefined,
        broadcastSessions() {
          attemptedProjections.push("broadcast");
          if (failingProjection === "broadcast") {
            throw new Error("broadcast projection failed");
          }
        },
      });

      const result = await service.upsertTerminalSession(terminalSession, {
        auditLogId: 1,
        sessionId: terminalSession.id,
        phase: "completed",
        assistantMessageSeq: terminalSession.messages.length - 1,
        threadId: terminalSession.threadId,
        errorMessage: "",
        completedAt: "2026-08-16T00:00:00.000Z",
      });

      assert.equal(result.runState, "idle");
      assert.equal(result.messages.at(-1)?.text, "done");
      assert.equal(persistedSession.runState, "idle");
      assert.deepEqual(attemptedProjections, ["dependency", "cache", "broadcast"]);
    }
  });

  it("create commit後のprojection failureを保存済み結果へ波及させない", async () => {
    for (const failingProjection of ["dependency", "cache", "broadcast"] as const) {
      const storedSessions: Session[] = [];
      const attemptedProjections: string[] = [];
      const service = new SessionPersistenceService({
        getSessions: () => [],
        setSessions() {
          attemptedProjections.push("cache");
          if (failingProjection === "cache") {
            throw new Error("cache projection failed");
          }
        },
        getSession: () => null,
        isSessionRunInFlight: () => false,
        upsertStoredSession(next) {
          storedSessions.push(next);
          return next;
        },
        replaceStoredSessions: () => undefined,
        setStoredSessionPinned: () => null,
        listStoredSessions: () => storedSessions,
        getAppSettings: () => normalizeAppSettings({}),
        getModelCatalogSnapshot: createSnapshot,
        syncSessionDependencies() {
          attemptedProjections.push("dependency");
          if (failingProjection === "dependency") {
            throw new Error("dependency projection failed");
          }
        },
        clearSessionContextTelemetry: () => undefined,
        clearSessionBackgroundActivities: () => undefined,
        invalidateProviderSessionThread: () => undefined,
        closeSessionWindow: () => undefined,
        broadcastSessions() {
          attemptedProjections.push("broadcast");
          if (failingProjection === "broadcast") {
            throw new Error("broadcast projection failed");
          }
        },
      });

      const result = await service.createSession({
        taskTitle: "Committed create",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      });

      assert.equal(storedSessions.length, 1);
      assert.equal(result.id, storedSessions[0]?.id);
      assert.deepEqual(attemptedProjections, ["dependency", "cache", "broadcast"]);
    }
  });

  it("createSession は有効な provider と model を解決して保存する", async () => {
    const storedSessions: Session[] = [];
    const syncedSessionIds: string[] = [];
    const broadcastedSessionIds: string[][] = [];
    const snapshot = createSnapshot();
    const characterRuntimeSnapshot = createCharacterRuntimeSnapshot();
    const snapshotCharacterIds: string[] = [];
    const storeOperations: string[] = [];
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
      upsertStoredSession(session, operation) {
        storeOperations.push(operation);
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

    assert.equal(service.resolveCharacterAuthoringProvider("codex"), "codex");
    assert.throws(
      () => service.resolveCharacterAuthoringProvider("unknown-provider"),
      /provider.*model catalog/,
    );
    assert.throws(
      () => service.resolveCharacterAuthoringProvider("copilot"),
      /provider.*無効/,
    );

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
    assert.deepEqual(storeOperations, ["create"]);

    await assert.rejects(
      () => service.createSession({
        taskTitle: "Character authoring",
        workspaceLabel: "character authoring",
        workspacePath: "C:/characters/char-a",
        branch: "main",
        sessionKind: "character-authoring",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
        provider: "copilot",
        customAgentName: "",
        allowedAdditionalDirectories: [],
      }),
      /provider.*無効/,
    );
    assert.deepEqual(storeOperations, ["create"]);

    await assert.rejects(
      () => service.createSession({
        taskTitle: "Character authoring",
        workspaceLabel: "character authoring",
        workspacePath: "C:/characters/char-a",
        branch: "main",
        sessionKind: "character-authoring",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
        provider: "unknown-provider",
        customAgentName: "",
        allowedAdditionalDirectories: [],
      }),
      /provider.*model catalog/,
    );
    assert.deepEqual(storeOperations, ["create"]);
  });

  it("createSession は指定 ID が既存 Session と衝突する場合に上書きしない", async () => {
    const existing = createSession({
      id: "existing-session",
      status: "running",
      runState: "running",
      threadId: "thread-existing",
    });
    let upsertCount = 0;
    const service = new SessionPersistenceService({
      getSessions: () => [existing],
      setSessions() {},
      getSession: (sessionId) => sessionId === existing.id ? existing : null,
      getStoredSession: () => existing,
      isSessionRunInFlight: () => true,
      upsertStoredSession(session) {
        upsertCount += 1;
        return session;
      },
      replaceStoredSessions() {},
      listStoredSessions: () => [existing],
      deleteStoredSession() {},
      getAppSettings: () => normalizeAppSettings(),
      getModelCatalogSnapshot: () => createSnapshot(),
      syncSessionDependencies() {},
      clearSessionContextTelemetry() {},
      clearSessionBackgroundActivities() {},
      invalidateProviderSessionThread() {},
      closeSessionWindow() {},
      broadcastSessions() {},
    });

    await assert.rejects(
      service.createSession({
        id: existing.id,
        taskTitle: "forged replacement",
        workspaceLabel: "forged",
        workspacePath: "C:/forged",
        branch: "",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      }),
      /同じ ID の Session がすでに存在するよ。/,
    );
    assert.equal(upsertCount, 0);
    assert.equal(existing.threadId, "thread-existing");
    assert.equal(existing.workspacePath, "C:/workspace");
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

    const withoutThread = createSession({
      id: "session-without-thread",
      provider: "codex",
      model: "codex-default",
      threadId: "",
    });
    storedSessions.splice(0, storedSessions.length, withoutThread);
    await service.updateSession({ ...withoutThread, provider: "copilot", model: "copilot-default" });
    assert.deepEqual(invalidatedThreads, [
      { providerId: "codex", sessionId: baseSession.id },
      { providerId: "codex", sessionId: withoutThread.id },
    ]);

    storedSessions.splice(0, storedSessions.length, createSession({ id: baseSession.id, runState: "running", status: "running" }));
    await assert.rejects(
      () => service.updateSession({ ...storedSessions[0], taskTitle: "blocked" }),
      /実行中のセッションは更新できない/,
    );
  });

  it("updateSession は保存済み Character owner / runtime snapshot の差し替えを永続化前に拒否する", async () => {
    const characterRuntimeSnapshot = createCharacterRuntimeSnapshot();
    const storedSession = createSession({ characterRuntimeSnapshot });
    const cachedSession = createSession({
      id: storedSession.id,
      characterRuntimeSnapshot: null,
    });
    const invalidUpdates = [
      {
        ...storedSession,
        characterId: "char-b",
        characterRuntimeSnapshot: createCharacterRuntimeSnapshot({
          characterId: "char-b",
          name: "B",
        }),
      },
      {
        ...storedSession,
        characterRuntimeSnapshot: null,
      },
    ];

    for (const invalidUpdate of invalidUpdates) {
      let upsertCallCount = 0;
      const cachedSessions: Session[] = [cachedSession];
      const service = new SessionPersistenceService({
        getSessions() {
          return cachedSessions;
        },
        setSessions(nextSessions) {
          cachedSessions.splice(0, cachedSessions.length, ...nextSessions);
        },
        getSession(sessionId) {
          return sessionId === cachedSession.id ? cachedSession : null;
        },
        getStoredSession(sessionId) {
          return sessionId === storedSession.id ? storedSession : null;
        },
        isSessionRunInFlight() {
          return false;
        },
        upsertStoredSession(session) {
          upsertCallCount += 1;
          return session;
        },
        replaceStoredSessions() {},
        listStoredSessions() {
          return [storedSession];
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
        () => service.updateSession(invalidUpdate),
        /Character owner \/ runtime snapshot は更新できない/,
      );
      assert.equal(upsertCallCount, 0);
    }
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
    const revokedBindings: string[] = [];
    const invalidatedThreads: Array<{ providerId: string | null | undefined; sessionId: string }> = [];
    const broadcastedSessionIds: string[][] = [];
    let coordinationBroadcastCount = 0;

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
      listAuxiliarySessionRuntimeIdentities(parentSessionIds) {
        assert.deepEqual(parentSessionIds, [session.id]);
        return [{ id: "auxiliary-a", parentSessionId: session.id, provider: "copilot" }];
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
      invalidateProviderSessionThread(providerId, sessionId) {
        invalidatedThreads.push({ providerId, sessionId });
      },
      revokeSessionAgentRuntimeBindings(sessionId) {
        revokedBindings.push(sessionId);
      },
      closeSessionWindow(sessionId) {
        closedWindows.push(sessionId);
      },
      broadcastSessions(sessionIds) {
        broadcastedSessionIds.push(Array.from(sessionIds ?? []));
      },
      broadcastCoordinationEventsChanged() {
        coordinationBroadcastCount += 1;
      },
    });

    await service.deleteSession(session.id);

    assert.deepEqual(deleted, [session.id]);
    assert.deepEqual(clearedBackground, [session.id, "auxiliary-a"]);
    assert.deepEqual(closedWindows, [session.id, "auxiliary-a"]);
    assert.deepEqual(revokedBindings, [session.id, "auxiliary-a"]);
    assert.deepEqual(invalidatedThreads, [
      { providerId: session.provider, sessionId: session.id },
      { providerId: "copilot", sessionId: "auxiliary-a" },
    ]);
    assert.deepEqual(broadcastedSessionIds, [[session.id]]);
    assert.equal(coordinationBroadcastCount, 1);
    assert.equal(storedSessions.length, 0);
  });

  it("deleteSession はchildを持つ親をstorageとcleanupの副作用前に拒否する", async () => {
    const parentSession = createSession({ id: "parent" });
    let storageDeleteCount = 0;
    let cleanupCount = 0;
    const service = new SessionPersistenceService({
      getSessions: () => [parentSession],
      isSessionRunInFlight: () => false,
      listSessionIdsWithChildren: () => new Set([parentSession.id]),
      listStoredSessions: () => [parentSession],
      deleteStoredSession() { storageDeleteCount += 1; },
      clearSessionBackgroundActivities() { cleanupCount += 1; },
      closeSessionWindow() { cleanupCount += 1; },
      broadcastSessions() { cleanupCount += 1; },
    } as never);

    await assert.rejects(
      () => service.deleteSession(parentSession.id),
      /子セッションが残っている親セッションは削除できない/,
    );
    assert.equal(storageDeleteCount, 0);
    assert.equal(cleanupCount, 0);
  });

  it("deleteSession はCoordination通知失敗後もcacheとruntime cleanupを完遂する", async () => {
    const session = createSession({ id: "deleted-despite-publication-failure" });
    let storedDeleteCount = 0;
    let coordinationBroadcastCount = 0;
    const cleaned: string[] = [];
    const originalConsoleError = console.error;
    console.error = () => undefined;
    const service = new SessionPersistenceService({
      getSessions: () => [session],
      setSessions(nextSessions) {
        assert.deepEqual(nextSessions, []);
        cleaned.push("cache");
      },
      getSession: () => session,
      isSessionRunInFlight: () => false,
      deleteStoredSession() {
        storedDeleteCount += 1;
      },
      clearSessionContextTelemetry() { cleaned.push("telemetry"); },
      clearSessionBackgroundActivities() { cleaned.push("background"); },
      invalidateProviderSessionThread() { cleaned.push("provider"); },
      revokeSessionAgentRuntimeBindings() { cleaned.push("binding"); },
      closeSessionWindow() { cleaned.push("window"); },
      broadcastSessions() { cleaned.push("sessions"); },
      broadcastCoordinationEventsChanged() {
        coordinationBroadcastCount += 1;
        throw new Error("publication failed");
      },
    } as never);

    try {
      await service.deleteSession(session.id);
      assert.equal(storedDeleteCount, 1);
      assert.equal(coordinationBroadcastCount, 1);
      assert.deepEqual(cleaned, ["cache", "binding", "provider", "telemetry", "background", "window", "sessions"]);
    } finally {
      console.error = originalConsoleError;
    }
  });

  it("deleteSession は active Auxiliary が実行中の親 Session を削除しない", async () => {
    const parentSession = createSession({ id: "parent" });
    const storedSessions: Session[] = [parentSession];
    const deleted: string[] = [];

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
      listRunningActiveAuxiliaryParentIds(sessionIds) {
        assert.deepEqual(sessionIds, [parentSession.id]);
        return new Set([parentSession.id]);
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
      clearSessionBackgroundActivities() {},
      clearCharacterReflectionCheckpoint() {},
      clearInFlightCharacterReflection() {},
      invalidateProviderSessionThread() {},
      closeSessionWindow() {},
      broadcastSessions() {},
    });

    await assert.rejects(
      () => service.deleteSession(parentSession.id),
      /実行中のセッションは削除できない/,
    );

    assert.deepEqual(deleted, []);
    assert.deepEqual(storedSessions.map((session) => session.id), [parentSession.id]);
  });

  it("deleteSessionsLastActiveBefore は対象だけ bulk 削除し running は skip する", async () => {
    const parentSession = createSession({ id: "parent", updatedAt: "2026-05-31T00:00:00.000Z" });
    const oldSession = createSession({ id: "old", updatedAt: "2026-06-01T00:00:00.000Z" });
    const runningSession = createSession({
      id: "running",
      status: "running",
      runState: "running",
      updatedAt: "2026-06-01T01:00:00.000Z",
    });
    const recentSession = createSession({ id: "recent", updatedAt: "2026-07-02T00:00:00.000Z" });
    const storedSessions: Session[] = [parentSession, oldSession, runningSession, recentSession];
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
      listSessionIdsWithChildren(sessionIds) {
        assert.deepEqual(sessionIds, [parentSession.id, oldSession.id, runningSession.id]);
        return new Set([parentSession.id]);
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
        return [parentSession.id, oldSession.id, runningSession.id];
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
    assert.deepEqual(
      storedSessions.map((session) => session.id),
      [parentSession.id, runningSession.id, recentSession.id],
    );
  });

  it("deleteSessionsLastActiveBefore は active Auxiliary が実行中の親 Session を skip する", async () => {
    const parentSession = createSession({ id: "parent", updatedAt: "2026-06-01T00:00:00.000Z" });
    const oldSession = createSession({ id: "old", updatedAt: "2026-06-01T01:00:00.000Z" });
    const recentSession = createSession({ id: "recent", updatedAt: "2026-07-02T00:00:00.000Z" });
    const storedSessions: Session[] = [parentSession, oldSession, recentSession];
    const deletedBatches: string[][] = [];

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
      listRunningActiveAuxiliaryParentIds(sessionIds) {
        assert.deepEqual(sessionIds, [parentSession.id, oldSession.id]);
        return new Set([parentSession.id]);
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
        return [parentSession.id, oldSession.id];
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
      clearSessionContextTelemetry() {},
      clearSessionBackgroundActivities() {},
      clearCharacterReflectionCheckpoint() {},
      clearInFlightCharacterReflection() {},
      invalidateProviderSessionThread() {},
      closeSessionWindow() {},
      broadcastSessions() {},
    });

    const result = await service.deleteSessionsLastActiveBefore({
      cutoffDate: "2026-07-01",
      cutoffTimestampMs: Date.parse("2026-07-01T00:00:00.000Z"),
      cutoffIso: "2026-07-01T00:00:00.000Z",
    });

    assert.deepEqual(result.deletedSessionIds, [oldSession.id]);
    assert.deepEqual(result.skippedRunningSessionIds, [parentSession.id]);
    assert.deepEqual(deletedBatches, [[oldSession.id]]);
    assert.deepEqual(storedSessions.map((session) => session.id), [parentSession.id, recentSession.id]);
  });

  it("deleteSessionsLastActiveBefore は cache 未読込の stored session も削除する", async () => {
    const uncachedOldSession = createSession({ id: "uncached-old", updatedAt: "2026-06-01T00:00:00.000Z" });
    const runningSession = createSession({
      id: "running",
      status: "running",
      runState: "running",
      updatedAt: "2026-06-01T01:00:00.000Z",
    });
    const recentSession = createSession({ id: "recent", updatedAt: "2026-07-02T00:00:00.000Z" });
    const cachedSessions: Session[] = [runningSession, recentSession];
    const persistedSessions: Session[] = [uncachedOldSession, runningSession, recentSession];
    const deletedBatches: string[][] = [];
    const clearedTelemetry: string[] = [];
    const clearedBackground: string[] = [];
    const closedWindows: string[] = [];
    const broadcastedSessionIds: string[][] = [];

    const service = new SessionPersistenceService({
      getSessions() {
        return cachedSessions;
      },
      setSessions(nextSessions) {
        cachedSessions.splice(0, cachedSessions.length, ...nextSessions);
      },
      getSession(sessionId) {
        return cachedSessions.find((entry) => entry.id === sessionId) ?? null;
      },
      isSessionRunInFlight(sessionId) {
        return sessionId === runningSession.id;
      },
      upsertStoredSession(next) {
        persistedSessions.splice(0, persistedSessions.length, next);
        return next;
      },
      replaceStoredSessions(nextSessions) {
        persistedSessions.splice(0, persistedSessions.length, ...nextSessions);
      },
      listStoredSessions() {
        return [...persistedSessions];
      },
      listStoredSessionIdsLastActiveBefore() {
        return [uncachedOldSession.id, runningSession.id];
      },
      deleteStoredSessions(sessionIds) {
        deletedBatches.push([...sessionIds]);
        const deletedSessionIds = new Set(sessionIds);
        const remaining = persistedSessions.filter((entry) => !deletedSessionIds.has(entry.id));
        persistedSessions.splice(0, persistedSessions.length, ...remaining);
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

    assert.deepEqual(result.deletedSessionIds, [uncachedOldSession.id]);
    assert.deepEqual(result.skippedRunningSessionIds, [runningSession.id]);
    assert.deepEqual(deletedBatches, [[uncachedOldSession.id]]);
    assert.deepEqual(clearedTelemetry, [uncachedOldSession.id]);
    assert.deepEqual(clearedBackground, [uncachedOldSession.id]);
    assert.deepEqual(closedWindows, [uncachedOldSession.id]);
    assert.deepEqual(broadcastedSessionIds, [[uncachedOldSession.id]]);
    assert.deepEqual(cachedSessions.map((session) => session.id), [runningSession.id, recentSession.id]);
    assert.deepEqual(persistedSessions.map((session) => session.id), [runningSession.id, recentSession.id]);
  });

  it("replaceAllSessions は進行中appraisalを待ってから removed/provider change の副作用を処理する", async () => {
    const sessionA = createSession({ id: "session-a", provider: "codex", model: "codex-default" });
    const sessionB = createSession({ id: "session-b", provider: "copilot", model: "copilot-default" });
    const nextSessionA = { ...sessionA, provider: "copilot", model: "copilot-default", threadId: "" };
    const storedSessions: Session[] = [sessionA, sessionB];
    const clearedTelemetry: string[] = [];
    const clearedBackground: string[] = [];
    const invalidated: Array<{ providerId: string | null | undefined; sessionId: string }> = [];
    const broadcastedSessionIds: string[][] = [];
    const replaceOrder: string[] = [];
    const ownershipCoordinator = new CharacterAffectTurnOwnershipCoordinator();
    let releaseAppraisal = () => undefined;
    let markAppraisalStarted = () => undefined;
    const appraisalBarrier = new Promise<void>((resolve) => {
      releaseAppraisal = resolve;
    });
    const appraisalStarted = new Promise<void>((resolve) => {
      markAppraisalStarted = resolve;
    });
    const appraisal = ownershipCoordinator.runExclusive(async () => {
      markAppraisalStarted();
      await appraisalBarrier;
    });
    await appraisalStarted;

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
        storedSessions.splice(0, storedSessions.length, ...nextSessions.map((session) => ({
          ...session,
          isPinned: session.id === "session-a" ? true : session.isPinned,
        })));
      },
      setStoredSessionPinned(sessionId, isPinned) {
        replaceOrder.push("setStoredSessionPinned");
        const session = storedSessions.find((entry) => entry.id === sessionId);
        assert.ok(session);
        const pinned = { ...session, isPinned };
        storedSessions.splice(0, storedSessions.length, pinned);
        return pinned;
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
      runCharacterAffectTurnOwnershipExclusive: (operation) => ownershipCoordinator.runExclusive(operation),
    });

    const replacePromise = service.replaceAllSessions([nextSessionA], {
      invalidateSessionIds: ["session-a"],
    });
    const pinPromise = service.setSessionPinned("session-a", false);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(replaceOrder, []);

    releaseAppraisal();
    const [, replaced, pinned] = await Promise.all([appraisal, replacePromise, pinPromise]);

    assert.equal(replaced.length, 1);
    assert.equal(replaced[0]?.isPinned, true);
    assert.equal(pinned.isPinned, false);
    assert.equal(storedSessions[0]?.isPinned, false);
    assert.deepEqual(clearedTelemetry.sort(), ["session-a", "session-b"]);
    assert.deepEqual(clearedBackground, ["session-b"]);
    assert.deepEqual(invalidated, [
      { providerId: "codex", sessionId: "session-a" },
      { providerId: "copilot", sessionId: "session-b" },
      { providerId: "copilot", sessionId: "session-a" },
    ]);
    assert.deepEqual(broadcastedSessionIds, [["session-a", "session-b"], ["session-a"]]);
    assert.deepEqual(replaceOrder, [
      "replaceStoredSessions:start",
      "replaceStoredSessions:end",
      "setSessions",
      "setStoredSessionPinned",
      "setSessions",
    ]);
  });
});

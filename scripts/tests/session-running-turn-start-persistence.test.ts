import assert from "node:assert/strict";
import { it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { buildNewSession, projectSessionSummary, type Session } from "../../src/session-state.js";
import { normalizeAppSettings } from "../../src/provider-settings-state.js";
import { SessionPersistenceService } from "../../src-electron/session-persistence-service.js";

function createSession(overrides?: Partial<Session>): Session {
  return {
    ...buildNewSession({
      id: overrides?.id,
      taskTitle: "Persistence Test",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "char-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
      sessionKind: overrides?.sessionKind,
    }),
    ...overrides,
  };
}

// @test-value v1
// kind = "invariant"
// claim = "authoring snapshotのnull入力をstorageへ保持して渡し、canonical resultをfull runtime、summary cache、broadcastへ反映する"
// oracle = { type = "contract", ref = "running-turn-start-persistence#5,#8,#10" }
// failure_mode = "nullをundefinedへ変換してsnapshot clearを失うか、commit後にstaleなpin、title、snapshotをcacheへ戻す"
// scope = "SessionPersistenceService.persistRunningTurnStart"
// lifecycle = "permanent"
// distinction = "storage atomicityではなく三状態DTOのnull伝播とcommit後のcanonical result合成を観測する"
// @end-test-value
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
    getSessions: () => cachedSessions,
    setSessions: (next) => { cachedSessions = next; },
    getSession: (sessionId) => cachedSessions.find((session) => session.id === sessionId) ?? null,
    isSessionRunInFlight: () => true,
    upsertStoredSession: (next) => {
      genericUpsertCalled = true;
      return next;
    },
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
    replaceStoredSessions: () => undefined,
    listStoredSessions: () => [initial],
    getAppSettings: () => normalizeAppSettings({}),
    getModelCatalogSnapshot: () => ({ revision: 1, providers: [] }),
    syncSessionDependencies: () => undefined,
    clearSessionContextTelemetry: () => undefined,
    clearSessionBackgroundActivities: () => undefined,
    invalidateProviderSessionThread: () => undefined,
    closeSessionWindow: () => undefined,
    broadcastSessions: (sessionIds) => broadcasts.push(Array.from(sessionIds ?? [])),
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

// @test-value v1
// kind = "invariant"
// claim = "Character authoring runtime clearは専用storage resultからfull runtimeとsummary cacheを構築し、generic upsertやrunning開始保存を使わない"
// oracle = { type = "adr", ref = "ADR-010#Authoring-snapshot-lifecycle" }
// failure_mode = "validation前clearがfull-session rewriteに退行するか、commit後のcacheに古いsnapshotまたはthreadを残す"
// scope = "SessionPersistenceService.clearCharacterAuthoringRuntimeState"
// lifecycle = "permanent"
// distinction = "running開始のnull伝播ではなく、messageを所有しない専用metadata clearのcanonical projectionを観測する"
// @end-test-value
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
    getSessions: () => cachedSessions,
    setSessions: (next) => { cachedSessions = next; },
    getSession: (sessionId) => cachedSessions.find((session) => session.id === sessionId) ?? null,
    isSessionRunInFlight: () => false,
    upsertStoredSession: (next) => {
      genericUpsertCalled = true;
      return next;
    },
    appendStoredRunningTurnStart: () => {
      runningStartCalled = true;
      throw new Error("running start must not run");
    },
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
    replaceStoredSessions: () => undefined,
    listStoredSessions: () => [initial],
    getAppSettings: () => normalizeAppSettings({}),
    getModelCatalogSnapshot: () => ({ revision: 1, providers: [] }),
    syncSessionDependencies: () => undefined,
    clearSessionContextTelemetry: () => undefined,
    clearSessionBackgroundActivities: () => undefined,
    invalidateProviderSessionThread: () => undefined,
    closeSessionWindow: () => undefined,
    broadcastSessions: (sessionIds) => broadcasts.push(Array.from(sessionIds ?? [])),
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

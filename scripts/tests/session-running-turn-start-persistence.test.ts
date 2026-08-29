import assert from "node:assert/strict";
import { it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { buildNewSession, projectSessionSummary, type Session } from "../../src/session-state.js";
import { normalizeAppSettings } from "../../src/provider-settings-state.js";
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

import assert from "node:assert/strict";
import test from "node:test";

import { createWithMateWindowApi } from "../../src-electron/preload-api.js";
import type { WithMateWindowApi } from "../../src/withmate-window-api.js";

type Listener = (...args: unknown[]) => void;

function createIpcRendererStub() {
  const listeners = new Map<string, Listener>();

  return {
    listeners,
    ipcRenderer: {
      invoke(channel: string, ...args: unknown[]) {
        return Promise.resolve({ channel, args });
      },
      on(channel: string, listener: Listener) {
        listeners.set(channel, listener);
      },
      removeListener(channel: string) {
        listeners.delete(channel);
      },
    },
  };
}

test("createWithMateWindowApi は invoke 系 API を domain ごとに束ねる", async () => {
  const { ipcRenderer } = createIpcRendererStub();
  const api = createWithMateWindowApi(ipcRenderer as never);

  assert.deepEqual(await api.openSession("session-1"), {
    channel: "withmate:open-session",
    args: ["session-1"],
  });
  assert.deepEqual(await api.openMemoryManagementWindow(), {
    channel: "withmate:open-memory-management-window",
    args: [],
  });
  assert.deepEqual(await api.resetAppDatabase({ targets: ["appSettings"] }), {
    channel: "withmate:reset-app-database",
    args: [{ targets: ["appSettings"] }],
  });
  assert.deepEqual(await api.getMemoryManagementSnapshot(), {
    channel: "withmate:get-memory-management-snapshot",
    args: [],
  });
  assert.deepEqual(await api.getSessionBackgroundActivity("session-1", "memory-generation"), {
    channel: "withmate:get-session-background-activity",
    args: ["session-1", "memory-generation"],
  });
  assert.deepEqual(await api.listSessionSummaries(), {
    channel: "withmate:list-session-summaries",
    args: [],
  });
  assert.deepEqual(await api.runSessionMemoryExtraction("session-1"), {
    channel: "withmate:run-session-memory-extraction",
    args: ["session-1"],
  });
});

test("createWithMateWindowApi は current public API の key を揃えて expose する", () => {
  const { ipcRenderer } = createIpcRendererStub();
  const api = createWithMateWindowApi(ipcRenderer as never);

  const keys = Object.keys(api).sort();
  const expectedKeys = [
    "cancelSessionRun",
    "createCharacter",
    "createCharacterUpdateSession",
    "createSession",
    "deleteCharacter",
    "deleteCharacterMemoryEntry",
    "deleteProjectMemoryEntry",
    "deleteSession",
    "deleteSessionMemory",
    "exportModelCatalog",
    "exportModelCatalogFile",
    "extractCharacterUpdateMemory",
    "getAppSettings",
    "getCharacter",
    "getCharacterUpdateWorkspace",
    "getDiffPreview",
    "getLiveSessionRun",
    "getMemoryManagementSnapshot",
    "getModelCatalog",
    "getProviderQuotaTelemetry",
    "getSession",
    "getSessionBackgroundActivity",
    "getSessionContextTelemetry",
    "importModelCatalog",
    "importModelCatalogFile",
    "listCharacters",
    "listOpenSessionWindowIds",
    "listSessionAuditLogs",
    "listSessionCustomAgents",
    "listSessionSkills",
    "listSessionSummaries",
    "openCharacterEditor",
    "openDiffWindow",
    "openHomeWindow",
    "openMemoryManagementWindow",
    "openPath",
    "openSession",
    "openSessionMonitorWindow",
    "openSessionTerminal",
    "openSettingsWindow",
    "pickDirectory",
    "pickFile",
    "pickImageFile",
    "previewComposerInput",
    "resetAppDatabase",
    "resolveLiveApproval",
    "resolveLiveElicitation",
    "runSessionMemoryExtraction",
    "runSessionTurn",
    "searchWorkspaceFiles",
    "subscribeAppSettings",
    "subscribeCharacters",
    "subscribeLiveSessionRun",
    "subscribeModelCatalog",
    "subscribeOpenSessionWindowIds",
    "subscribeProviderQuotaTelemetry",
    "subscribeSessionSummaries",
    "subscribeSessionBackgroundActivity",
    "subscribeSessionContextTelemetry",
    "updateAppSettings",
    "updateCharacter",
    "updateSession",
  ] satisfies Array<keyof WithMateWindowApi>;

  assert.deepEqual(keys, [...expectedKeys].sort());
});

test("createWithMateWindowApi は subscribe 系 API で payload を unwrap する", async () => {
  const { ipcRenderer, listeners } = createIpcRendererStub();
  const api = createWithMateWindowApi(ipcRenderer as never);
  const received: unknown[] = [];

  const disposeSummaries = api.subscribeSessionSummaries((summaries) => {
    received.push({ kind: "summaries", summaries });
  });
  const disposeLiveRun = api.subscribeLiveSessionRun((sessionId, state) => {
    received.push({ kind: "liveRun", sessionId, state });
  });

  listeners.get("withmate:sessions-changed")?.({}, [{ id: "session-1", taskTitle: "task" }]);
  listeners.get("withmate:live-session-run")?.({}, { sessionId: "session-1", state: { phase: "running" } });
  disposeSummaries();
  disposeLiveRun();

  assert.deepEqual(received, [
    { kind: "summaries", summaries: [{ id: "session-1", taskTitle: "task" }] },
    { kind: "liveRun", sessionId: "session-1", state: { phase: "running" } },
  ]);
  assert.equal(listeners.has("withmate:live-session-run"), false);
  assert.equal(listeners.has("withmate:sessions-changed"), false);
});

test("createWithMateWindowApi は telemetry / background activity の payload も unwrap する", () => {
  const { ipcRenderer, listeners } = createIpcRendererStub();
  const api = createWithMateWindowApi(ipcRenderer as never);
  const quotaReceived: unknown[] = [];
  const backgroundReceived: unknown[] = [];

  const disposeQuota = api.subscribeProviderQuotaTelemetry((providerId, telemetry) => {
    quotaReceived.push({ providerId, telemetry });
  });
  const disposeBackground = api.subscribeSessionBackgroundActivity((sessionId, kind, state) => {
    backgroundReceived.push({ sessionId, kind, state });
  });

  listeners.get("withmate:provider-quota-telemetry")?.({}, {
    providerId: "copilot",
    telemetry: { provider: "copilot", snapshots: [] },
  });
  listeners.get("withmate:session-background-activity")?.({}, {
    sessionId: "session-1",
    kind: "monologue",
    state: { kind: "monologue", status: "running" },
  });
  disposeQuota();
  disposeBackground();

  assert.deepEqual(quotaReceived, [{ providerId: "copilot", telemetry: { provider: "copilot", snapshots: [] } }]);
  assert.deepEqual(backgroundReceived, [
    { sessionId: "session-1", kind: "monologue", state: { kind: "monologue", status: "running" } },
  ]);
});

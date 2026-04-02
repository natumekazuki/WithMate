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
  assert.deepEqual(await api.resetAppDatabase({ targets: ["appSettings"] }), {
    channel: "withmate:reset-app-database",
    args: [{ targets: ["appSettings"] }],
  });
  assert.deepEqual(await api.getMemoryManagementSnapshot(), {
    channel: "withmate:get-memory-management-snapshot",
    args: [],
  });
  assert.deepEqual(await api.getSessionBackgroundActivity("session-1", "memoryGeneration"), {
    channel: "withmate:get-session-background-activity",
    args: ["session-1", "memoryGeneration"],
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
    "listSessions",
    "openCharacterEditor",
    "openDiffWindow",
    "openHomeWindow",
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
    "subscribeSessionBackgroundActivity",
    "subscribeSessionContextTelemetry",
    "subscribeSessions",
    "updateAppSettings",
    "updateCharacter",
    "updateSession",
  ] satisfies Array<keyof WithMateWindowApi>;

  assert.deepEqual(keys, expectedKeys);
});

test("createWithMateWindowApi は subscribe 系 API で payload を unwrap する", async () => {
  const { ipcRenderer, listeners } = createIpcRendererStub();
  const api = createWithMateWindowApi(ipcRenderer as never);
  const received: unknown[] = [];

  const dispose = api.subscribeLiveSessionRun((sessionId, state) => {
    received.push({ sessionId, state });
  });

  listeners.get("withmate:live-session-run")?.({}, { sessionId: "session-1", state: { phase: "running" } });
  dispose();

  assert.deepEqual(received, [{ sessionId: "session-1", state: { phase: "running" } }]);
  assert.equal(listeners.has("withmate:live-session-run"), false);
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

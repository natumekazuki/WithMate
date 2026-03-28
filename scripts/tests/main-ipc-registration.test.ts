import assert from "node:assert/strict";
import test from "node:test";

import type { IpcMain } from "electron";

import { registerMainIpcHandlers } from "../../src-electron/main-ipc-registration.js";

type Handler = (...args: unknown[]) => unknown;

function createIpcMainStub() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle(channel: string, handler: Handler) {
      handlers.set(channel, handler);
    },
  } as unknown as IpcMain;

  return { ipcMain, handlers };
}

test("registerMainIpcHandlers は主要 channel を登録して delegate を呼ぶ", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const calls: string[] = [];

  registerMainIpcHandlers(ipcMain, {
    resolveEventWindow: () => null,
    resolveHomeWindow: () => null,
    async openSessionWindow(sessionId) {
      calls.push(`openSession:${sessionId}`);
    },
    async openHomeWindow() {
      calls.push("openHome");
    },
    async openSessionMonitorWindow() {
      calls.push("openMonitor");
    },
    async openSettingsWindow() {
      calls.push("openSettings");
    },
    async openCharacterEditorWindow(characterId) {
      calls.push(`openCharacter:${characterId ?? ""}`);
    },
    async openDiffWindow() {
      calls.push("openDiff");
    },
    listSessions: () => [],
    listSessionAuditLogs: () => [],
    listSessionSkills: () => [],
    listSessionCustomAgents: () => [],
    listOpenSessionWindowIds: () => ["session-1"],
    getAppSettings: () => ({ providers: {}, codingProviderSettings: {}, memoryExtractionProviderSettings: {}, characterReflectionProviderSettings: {} } as never),
    updateAppSettings: (settings) => settings,
    async resetAppDatabase() {
      return null;
    },
    async listCharacters() {
      return [];
    },
    getModelCatalog: () => null,
    importModelCatalogDocument: () => ({ revision: 1, providers: [] }),
    async importModelCatalogFromFile() {
      return null;
    },
    exportModelCatalogDocument: () => null,
    async exportModelCatalogToFile() {
      return null;
    },
    getSession: () => null,
    getDiffPreview: () => null,
    getLiveSessionRun: () => null,
    async getProviderQuotaTelemetry() {
      return null;
    },
    getSessionContextTelemetry: () => null,
    getSessionBackgroundActivity: () => null,
    resolveLiveApproval: () => {
      calls.push("resolveApproval");
    },
    async getCharacter() {
      return null;
    },
    createSession: () => ({}) as never,
    updateSession: () => ({}) as never,
    deleteSession: () => {
      calls.push("deleteSession");
    },
    async previewComposerInput() {
      return null;
    },
    async searchWorkspaceFiles() {
      return [];
    },
    async runSessionTurn() {
      return {} as never;
    },
    cancelSessionRun: () => {
      calls.push("cancelRun");
    },
    async createCharacter() {
      return {} as never;
    },
    async updateCharacter() {
      return {} as never;
    },
    async deleteCharacter() {
      calls.push("deleteCharacter");
    },
    async pickDirectory() {
      return "dir";
    },
    async pickFile() {
      return "file";
    },
    async pickImageFile() {
      return "image";
    },
    async openPathTarget() {
      calls.push("openPath");
    },
    async openSessionTerminal() {
      calls.push("openTerminal");
    },
  });

  assert.ok(handlers.has("withmate:open-session"));
  assert.ok(handlers.has("withmate:get-app-settings"));
  assert.ok(handlers.has("withmate:run-session-turn"));

  await handlers.get("withmate:open-session")?.({}, "session-1");
  handlers.get("withmate:cancel-session-run")?.({}, "session-1");
  await handlers.get("withmate:open-path")?.({}, "target", null);

  assert.deepEqual(calls, [
    "openSession:session-1",
    "cancelRun",
    "openPath",
  ]);
});

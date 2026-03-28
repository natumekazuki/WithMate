import assert from "node:assert/strict";
import test from "node:test";

import { createMainBootstrapDeps } from "../../src-electron/main-bootstrap-deps.js";

test("createMainBootstrapDeps は IPC deps を組み立てて registerMainIpcHandlers に渡す", async () => {
  const calls: string[] = [];
  let receivedDeps: unknown = null;

  const deps = createMainBootstrapDeps({
    ipcMain: {} as never,
    registerMainIpcHandlers(_ipcMain, registrationDeps) {
      calls.push("registerIpcHandlers");
      receivedDeps = registrationDeps;
    },
    async initializePersistentStores() {
      calls.push("initialize");
      return { revision: 1, providers: [] };
    },
    recoverInterruptedSessions() {
      calls.push("recover");
    },
    async refreshCharactersFromStorage() {
      calls.push("refreshCharacters");
    },
    async createHomeWindow() {
      calls.push("openHome");
      return {} as never;
    },
    broadcastModelCatalog(snapshot) {
      calls.push(`broadcast:${snapshot.revision}`);
    },
    resolveEventWindow: () => null,
    resolveHomeWindow: () => null,
    async openSessionWindow() {
      calls.push("openSession");
      return {} as never;
    },
    async openSessionMonitorWindow() {
      return {} as never;
    },
    async openSettingsWindow() {
      return {} as never;
    },
    async openCharacterEditorWindow() {
      return {} as never;
    },
    async openDiffWindow() {
      return {} as never;
    },
    listSessions: () => [],
    listSessionAuditLogs: () => [],
    listSessionSkills: () => [],
    listSessionCustomAgents: () => [],
    listOpenSessionWindowIds: () => [],
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
    resolveLiveApproval: () => {},
    async getCharacter() {
      return null;
    },
    createSession: () => ({}) as never,
    updateSession: () => ({}) as never,
    deleteSession: () => {},
    async previewComposerInput() {
      return null;
    },
    async searchWorkspaceFiles() {
      return [];
    },
    async runSessionTurn() {
      return {} as never;
    },
    cancelSessionRun: () => {},
    async createCharacter() {
      return {} as never;
    },
    async updateCharacter() {
      return {} as never;
    },
    async deleteCharacter() {},
    async pickDirectory() {
      return null;
    },
    async pickFile() {
      return null;
    },
    async pickImageFile() {
      return null;
    },
    async openPathTarget() {},
    async openSessionTerminal() {},
  });

  const snapshot = await deps.initializePersistentStores();
  deps.registerIpcHandlers();
  await deps.createHomeWindow();
  deps.broadcastModelCatalog(snapshot);

  assert.equal((receivedDeps as { openHomeWindow(): Promise<void> }).openHomeWindow instanceof Function, true);
  assert.deepEqual(calls, ["initialize", "registerIpcHandlers", "openHome", "broadcast:1"]);
});

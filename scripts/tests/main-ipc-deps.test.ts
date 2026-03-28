import assert from "node:assert/strict";
import test from "node:test";

import { createMainIpcRegistrationDeps } from "../../src-electron/main-ipc-deps.js";

test("createMainIpcRegistrationDeps は window open 系の戻り値を void 化して delegate する", async () => {
  const calls: string[] = [];

  const deps = createMainIpcRegistrationDeps({
    resolveEventWindow: () => null,
    resolveHomeWindow: () => null,
    async openSessionWindow(sessionId) {
      calls.push(`openSession:${sessionId}`);
      return {} as never;
    },
    async openHomeWindow() {
      calls.push("openHome");
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

  assert.equal(await deps.openHomeWindow(), undefined);
  assert.equal(await deps.openSessionWindow("session-1"), undefined);
  assert.deepEqual(calls, ["openHome", "openSession:session-1"]);
});

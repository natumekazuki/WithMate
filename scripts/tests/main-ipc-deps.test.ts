import assert from "node:assert/strict";
import test from "node:test";

import { createMainIpcRegistrationDeps } from "../../src-electron/main-ipc-deps.js";

test("createMainIpcRegistrationDeps は window open 系の戻り値を void 化して delegate する", async () => {
  const calls: string[] = [];

  const deps = createMainIpcRegistrationDeps({
    window: {
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
      async openMemoryManagementWindow() {
        calls.push("openMemory");
        return {} as never;
      },
      async openCharacterEditorWindow() {
        return {} as never;
      },
      async openDiffWindow() {
        return {} as never;
      },
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
    },
    catalog: {
      getModelCatalog: () => null,
      importModelCatalogDocument: () => ({ revision: 1, providers: [] }),
      async importModelCatalogFromFile() {
        return null;
      },
      exportModelCatalogDocument: () => null,
      async exportModelCatalogToFile() {
        return null;
      },
    },
    settings: {
      getAppSettings: () =>
        ({ providers: {}, codingProviderSettings: {}, memoryExtractionProviderSettings: {}, characterReflectionProviderSettings: {} }) as never,
      updateAppSettings: (settings) => settings,
      async resetAppDatabase() {
        return null;
      },
      getMemoryManagementSnapshot: () => ({ sessionMemories: [], projectMemories: [], characterMemories: [] }),
      deleteSessionMemory: () => {},
      deleteProjectMemoryEntry: () => {},
      deleteCharacterMemoryEntry: () => {},
    },
    sessionQuery: {
      listSessions: () => [],
      listSessionAuditLogs: () => [],
      listSessionSkills: () => [],
      listSessionCustomAgents: () => [],
      listOpenSessionWindowIds: () => [],
      getSession: () => null,
      getDiffPreview: () => null,
      async previewComposerInput() {
        return null;
      },
      async searchWorkspaceFiles() {
        return [];
      },
    },
    sessionRuntime: {
      getLiveSessionRun: () => null,
      async getProviderQuotaTelemetry() {
        return null;
      },
      getSessionContextTelemetry: () => null,
      getSessionBackgroundActivity: () => null,
      resolveLiveApproval: () => {},
      resolveLiveElicitation: () => {},
      createSession: () => ({}) as never,
      updateSession: () => ({}) as never,
      deleteSession: () => {},
      async runSessionTurn() {
        return {} as never;
      },
      runSessionMemoryExtraction: () => {},
      cancelSessionRun: () => {},
    },
    character: {
      async listCharacters() {
        return [];
      },
      async getCharacter() {
        return null;
      },
      async getCharacterUpdateWorkspace() {
        return null;
      },
      async extractCharacterUpdateMemory() {
        return { characterId: "char-1", generatedAt: "", entryCount: 0, text: "" };
      },
      async createCharacterUpdateSession() {
        return {} as never;
      },
      async createCharacter() {
        return {} as never;
      },
      async updateCharacter() {
        return {} as never;
      },
      async deleteCharacter() {},
    },
  });

  assert.equal(await deps.openHomeWindow(), undefined);
  assert.equal(await deps.openMemoryManagementWindow(), undefined);
  assert.equal(await deps.openSessionWindow("session-1"), undefined);
  assert.deepEqual(calls, ["openHome", "openMemory", "openSession:session-1"]);
});

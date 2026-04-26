import assert from "node:assert/strict";
import test from "node:test";

import { createMainBootstrapDeps } from "../../src-electron/main-bootstrap-deps.js";

test("createMainBootstrapDeps は grouped IPC deps を組み立てて registerMainIpcHandlers に渡す", async () => {
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
    ipcRegistration: {
      window: {
        resolveEventWindow: () => null,
        resolveHomeWindow: () => null,
        openSessionWindow: async () => ({}) as never,
        openHomeWindow: async () => ({}) as never,
        openSessionMonitorWindow: async () => ({}) as never,
        openSettingsWindow: async () => ({}) as never,
        openCharacterEditorWindow: async () => ({}) as never,
        openDiffWindow: async () => ({}) as never,
        pickDirectory: async () => null,
        pickFile: async () => null,
        pickImageFile: async () => null,
        openPathTarget: async () => {},
        openMemoryManagementWindow: async () => ({}) as never,
        openAppLogFolder: async () => {},
        openCrashDumpFolder: async () => {},
        openSessionTerminal: async () => {},
      },
      catalog: {
        getModelCatalog: () => null,
        importModelCatalogDocument: () => ({ revision: 1, providers: [] }),
        importModelCatalogFromFile: async () => null,
        exportModelCatalogDocument: () => null,
        exportModelCatalogToFile: async () => null,
      },
      settings: {
        getAppSettings: () =>
          ({ providers: {}, codingProviderSettings: {}, memoryExtractionProviderSettings: {}, characterReflectionProviderSettings: {} }) as never,
        updateAppSettings: (settings) => settings,
        resetAppDatabase: async () => null,
        getMemoryManagementSnapshot: () => ({ sessionMemories: [], projectMemories: [], characterMemories: [] }),
        deleteSessionMemory: () => {},
        deleteProjectMemoryEntry: () => {},
        deleteCharacterMemoryEntry: () => {},
      },
      sessionQuery: {
        listSessionSummaries: () => [],
        listCompanionSessionSummaries: () => [],
        listSessionAuditLogs: () => [],
        async listSessionSkills() { return []; },
        async listSessionCustomAgents() { return []; },
        listOpenSessionWindowIds: () => [],
        getSession: () => null,
        getDiffPreview: () => null,
        previewComposerInput: async () => null,
        searchWorkspaceFiles: async () => [],
      },
      companion: {
        createCompanionSession: async () => ({}) as never,
        listCompanionSessionSummaries: () => [],
      },
      sessionRuntime: {
        getLiveSessionRun: () => null,
        getProviderQuotaTelemetry: async () => null,
        getSessionContextTelemetry: () => null,
        getSessionBackgroundActivity: () => null,
        resolveLiveApproval: () => {},
        resolveLiveElicitation: () => {},
        createSession: () => ({}) as never,
        updateSession: () => ({}) as never,
        deleteSession: () => {},
        runSessionTurn: async () => ({}) as never,
        runSessionMemoryExtraction: () => {},
        cancelSessionRun: () => {},
      },
      character: {
        listCharacters: async () => [],
        getCharacter: async () => null,
        getCharacterUpdateWorkspace: async () => null,
        extractCharacterUpdateMemory: async () => ({ characterId: "char-1", generatedAt: "", entryCount: 0, text: "" }),
        createCharacterUpdateSession: async () => ({}) as never,
        createCharacter: async () => ({}) as never,
        updateCharacter: async () => ({}) as never,
        deleteCharacter: async () => {},
      },
    },
  });

  const snapshot = await deps.initializePersistentStores();
  deps.registerIpcHandlers();
  await deps.createHomeWindow();
  deps.broadcastModelCatalog(snapshot);

  assert.equal((receivedDeps as { openHomeWindow(): Promise<void> }).openHomeWindow instanceof Function, true);
  assert.deepEqual(calls, ["initialize", "registerIpcHandlers", "openHome", "broadcast:1"]);
});

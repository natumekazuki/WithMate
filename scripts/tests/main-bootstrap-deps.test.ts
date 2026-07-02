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
    async recoverInterruptedSessions() {
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
        openMemoryV6ReviewWindow: async () => ({}) as never,
        isSettingsWindow: () => false,
        isMemoryV6ReviewWindow: () => false,
        openCharacterEditorWindow: async () => ({}) as never,
        openDiffWindow: async () => ({}) as never,
        openCompanionReviewWindow: async () => ({}) as never,
        openCompanionMergeWindow: async () => ({}) as never,
        pickDirectory: async () => null,
        pickFile: async () => null,
        pickFiles: async () => [],
        pickSessionFiles: async () => [],
        pickSessionFolder: async () => null,
        pickSessionImageFile: async () => null,
        pickImageFile: async () => null,
        copyFilesToSessionFiles: async () => [],
        savePastedSessionFile: async () => "",
        openSessionFilesDirectory: async () => {},
        openSessionFilesTerminal: async () => {},
        openPathTarget: async () => {},
        openAppLogFolder: async () => {},
        openCrashDumpFolder: async () => {},
        openSessionTerminal: async () => {},
        openTerminalAtPath: async () => {},
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
        getAppDatabaseDiagnostics: () => ({}) as never,
        getMemoryV6Diagnostics: () => ({}) as never,
        installMemoryV6CliShim: () => ({}) as never,
        uninstallMemoryV6CliShim: () => ({}) as never,
        searchMemoryV6Entries: () => ({ items: [] }),
        getMemoryV6Entry: () => null,
        forgetMemoryV6Entry: (entryId: string) => ({ entryId, status: "not_found", reason: "user_request" }),
        resetAppDatabase: async () => null,
      },
      sessionQuery: {
        listSessionSummaries: () => [],
        listCompanionSessionSummaries: () => [],
        listSessionAuditLogs: () => [],
        listSessionAuditLogSummaries: () => [],
        listSessionAuditLogSummaryPage: () => ({ entries: [], nextCursor: null, hasMore: false, total: 0 }),
        getSessionAuditLogDetail: () => null,
        getSessionAuditLogDetailSection: () => null,
        getSessionAuditLogOperationDetail: () => null,
        listCompanionAuditLogs: () => [],
        listCompanionAuditLogSummaries: () => [],
        listCompanionAuditLogSummaryPage: () => ({ entries: [], nextCursor: null, hasMore: false, total: 0 }),
        getCompanionAuditLogDetail: () => null,
        getCompanionAuditLogDetailSection: () => null,
        getCompanionAuditLogOperationDetail: () => null,
        async listSessionSkills() { return []; },
        async listSessionCustomAgents() { return []; },
        async listWorkspaceSkills() { return []; },
        async listWorkspaceCustomAgents() { return []; },
        listOpenSessionWindowIds: () => [],
        listOpenCompanionReviewWindowIds: () => [],
        getSession: () => null,
        getSessionMessageArtifact: () => null,
        getDiffPreview: () => null,
        previewComposerInput: async () => null,
        searchWorkspaceFiles: async () => [],
      },
      companion: {
        createCompanionSession: async () => ({}) as never,
        getCompanionSession: () => null,
        getCompanionMessageArtifact: () => null,
        getCompanionReviewSnapshot: async () => null,
        mergeCompanionSelectedFiles: async () => ({}) as never,
        syncCompanionTarget: async () => ({}) as never,
        stashCompanionTargetChanges: async () => ({}) as never,
        restoreCompanionTargetStash: async () => ({}) as never,
        dropCompanionTargetStash: async () => ({}) as never,
        discardCompanionSession: async () => ({}) as never,
        updateCompanionSession: async (session) => session,
        previewCompanionComposerInput: async () => ({ attachments: [], errors: [] }),
        searchCompanionWorkspaceFiles: async () => [],
        runCompanionSessionTurn: async () => ({}) as never,
        cancelCompanionSessionRun: () => {},
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
        cancelSessionRun: () => {},
      },
      character: {
        listCharacters: async () => [],
        getCharacter: async () => null,
        createCharacter: async () => ({}) as never,
        updateCharacterMetadata: async () => ({}) as never,
        updateCharacterDefinition: async () => ({}) as never,
        archiveCharacter: async () => ({}) as never,
        setDefaultCharacter: async () => ({}) as never,
        resolveLaunchCharacter: async () => null,
      },
      mate: {
        getMateState: () => "not_created",
        getMateProfile: () => null,
        createMate: async () => ({}) as never,
        updateMate: async () => ({}) as never,
        setMateAvatar: async () => ({}) as never,
        resetMate: async () => {},
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

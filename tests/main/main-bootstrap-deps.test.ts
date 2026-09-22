import assert from "node:assert/strict";
import test from "node:test";

import { createMainBootstrapDeps } from "../../src-electron/app/main-bootstrap-deps.js";
import type {
  MainIpcCatalogDepsArgs,
  MainIpcPromptTemplateDepsArgs,
  MainIpcSessionQueryDepsArgs,
  MainIpcSettingsDepsArgs,
  MainIpcWindowDepsArgs,
} from "../../src-electron/app/main-ipc-deps.js";

// @test-value v2
// kind = "contract"
// claim = "main bootstrapのgrouped window IPC depsはSession Monitor context menu delegateをregistration depsへ渡す"
// oracle = { type = "contract", ref = "createMainBootstrapDeps grouped window dependencies" }
// fault = "Session Monitor context menu delegateがbootstrap境界で欠落し、Main IPC registrationへ到達しない"
// observable = "registerMainIpcHandlersへ渡されたwindow registration depsのdelegate"
// observation_boundary = "public-boundary"
// scope = "main bootstrap grouped window IPC deps"
// lifecycle = "permanent"
// impact = "Session Monitorの右クリック操作をMain IPCへ配線する"
// distinction = "window delegateのgroupingだけを検証し、IPC channel登録とnative menu selectionは別testで扱う"
// @end-test-value
test("createMainBootstrapDeps は grouped IPC deps を組み立てて registerMainIpcHandlers に渡す", async () => {
  const calls: string[] = [];
  let receivedDeps: unknown = null;
  const showSessionMonitorContextMenu = async () => ({ status: "dismissed" as const });

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
    broadcastModelCatalog(snapshot) {
      calls.push(`broadcast:${snapshot.revision}`);
    },
    ipcRegistration: {
      window: {
        acknowledgeSessionDraftFlush: () => {
          throw new Error("unused window fixture method");
        },
        resolveEventWindow: () => null,
        resolveHomeWindow: () => null,
        resolveSessionWindow: () => null,
        openSessionWindow: async () => ({}) as never,
        getSessionWindowRestoreSet: async () => {
          throw new Error("unused window fixture method");
        },
        restoreSessionWindows: async () => {
          throw new Error("unused window fixture method");
        },
        openHomeWindow: async () => ({}) as never,
        openSessionMonitorWindow: async () => ({}) as never,
        isSessionMonitorWindow: () => false,
        showSessionMonitorContextMenu,
        openSettingsWindow: async () => ({}) as never,
        openMemoryV6ReviewWindow: async () => ({}) as never,
        isSettingsWindow: () => false,
        isMemoryV6ReviewWindow: () => false,
        openCharacterEditorWindow: async () => ({}) as never,
        openDiffWindow: async () => ({}) as never,
        isFilePreviewWindow: () => {
          throw new Error("unused window fixture method");
        },
        getFilePreviewWindowResource: () => {
          throw new Error("unused window fixture method");
        },
        isFilePreviewTokenWindow: () => {
          throw new Error("unused window fixture method");
        },
        pickDirectory: async () => null,
        validateWorkspaceDirectory: async () => ({ valid: true }),
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
        copySessionFilePreviewImage: async () => ({ status: "copied" }),
        showSessionFilePreviewImageContextMenu: async () => ({ status: "dismissed" }),
        copySessionFileObject: async () => {
          throw new Error("unused window fixture method");
        },
        showSessionFileObjectCopyContextMenu: async () => {
          throw new Error("unused window fixture method");
        },
        showSessionFileTreeContextMenu: async () => {
          throw new Error("unused window fixture method");
        },
        showMarkdownLinkContextMenu: async () => {
          throw new Error("unused window fixture method");
        },
        openPathTarget: async () => ({ status: "opened", targetType: "local-path", target: "" }),
        openAppLogFolder: async () => {},
        openCrashDumpFolder: async () => {},
        openSessionTerminal: async () => {},
        openTerminalAtPath: async () => {},
      } satisfies MainIpcWindowDepsArgs,
      catalog: {
        getModelCatalog: () => null,
        importModelCatalogDocument: () => ({ revision: 1, providers: [] }),
        importModelCatalogFromFile: async () => null,
        exportModelCatalogDocument: () => null,
        exportModelCatalogToFile: async () => null,
      } satisfies MainIpcCatalogDepsArgs,
      settings: {
        getAppSettings: () =>
          ({ providers: {}, codingProviderSettings: {}, memoryExtractionProviderSettings: {}, characterReflectionProviderSettings: {} }) as never,
        updateAppSettings: (settings) => settings,
        updateChatLayoutPreference: () => ({}) as never,
        getAppDatabaseDiagnostics: () => ({}) as never,
        getMemoryV6Diagnostics: () => ({}) as never,
        installMemoryV6CliShim: () => ({}) as never,
        uninstallMemoryV6CliShim: () => ({}) as never,
        getMemoryV6FileUsage: () => ({}) as never,
        exportMemoryV6EntryFiles: () => null,
        runMemoryV6ProtectedObjectGc: () => ({}) as never,
        searchMemoryV6Entries: () => ({ items: [] }),
        getMemoryV6Entry: () => null,
        forgetMemoryV6Entry: (entryId: string) => ({ entryId, status: "not_found", reason: "user_request" }),
        resetAppDatabase: async () => null,
      } satisfies MainIpcSettingsDepsArgs,
      promptTemplates: {
        listPromptTemplates: () => [],
        createPromptTemplate: () => [],
        updatePromptTemplate: () => [],
        deletePromptTemplate: () => [],
      } satisfies MainIpcPromptTemplateDepsArgs,
      sessionQuery: {
        listSessionSummaryPage: async () => {
          throw new Error("unused session query fixture method");
        },
        listSessionCharacterUsage: async () => {
          throw new Error("unused session query fixture method");
        },
        listSessionAuditLogs: () => [],
        listSessionAuditLogSummaries: () => [],
        listSessionAuditLogSummaryPage: () => ({ entries: [], nextCursor: null, hasMore: false, total: 0 }),
        getSessionAuditLogDetail: () => null,
        getSessionAuditLogDetailSection: () => null,
        getSessionAuditLogOperationDetail: () => null,
        async listSessionSkills() { return []; },
        async listSessionCustomAgents() { return []; },
        async listWorkspaceSkills() { return []; },
        async listWorkspaceCustomAgents() { return []; },
        listOpenSessionWindowIdsPage: () => ({ sessionIds: [], nextCursor: null, hasMore: false }),
        getSession: () => null,
        getSessionGlossaryProjection: (sessionId: string) => ({
          sessionId,
          scopeRevision: "scope",
          sequence: 1,
          checkout: { repositoryName: "repo", branch: "main", pathLabel: "repo" },
          state: { status: "missing", relativePath: ".withmate/glossary.yaml", revision: null },
        }),
        searchSessionGlossary: () => ({ ok: true, revision: null, entries: [], total: 0, offset: 0, pageSize: 50 }),
        ensureSessionGlossarySubscription: () => {},
        getSessionMessageArtifact: () => null,
        getDiffPreview: () => null,
        previewComposerInput: async () => null,
        getSessionFileExplorerOwnerSessionId: async () => {
          throw new Error("unused session query fixture method");
        },
        listSessionFileRoots: async () => {
          throw new Error("unused session query fixture method");
        },
        listSessionDirectory: async () => {
          throw new Error("unused session query fixture method");
        },
        inspectSessionFile: async () => {
          throw new Error("unused session query fixture method");
        },
        readSessionFileChunk: async () => {
          throw new Error("unused session query fixture method");
        },
        openSessionFile: async () => {
          throw new Error("unused session query fixture method");
        },
        openSessionFilePreviewWindow: async () => {
          throw new Error("unused session query fixture method");
        },
        getSessionFilePreviewWindowPayload: () => {
          throw new Error("unused session query fixture method");
        },
        listFileRootChanges: async () => {
          throw new Error("unused session query fixture method");
        },
        listFileRootChangesRepositories: async () => {
          throw new Error("unused session query fixture method");
        },
        getFileRootDiff: async () => {
          throw new Error("unused session query fixture method");
        },
        listFileRootGitHistoryRepositories: async () => {
          throw new Error("unused session query fixture method");
        },
        listFileRootGitHistoryCommits: async () => {
          throw new Error("unused session query fixture method");
        },
        getFileRootGitHistoryCommitDetail: async () => {
          throw new Error("unused session query fixture method");
        },
        getFileRootGitHistoryComparison: async () => {
          throw new Error("unused session query fixture method");
        },
        getFileRootGitHistoryDiff: async () => {
          throw new Error("unused session query fixture method");
        },
      } satisfies MainIpcSessionQueryDepsArgs,
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
        deleteSessionsLastActiveBefore: () => ({ deletedSessionIds: [], skippedRunningSessionIds: [] }),
        runSessionTurn: async () => ({}) as never,
        cancelSessionRun: () => {},
        setSessionPinned: () => { throw new Error("not used"); },
      },
      character: {
        listCharacters: async () => [],
        getCharacter: async () => null,
        createCharacter: async () => ({}) as never,
        updateCharacterMetadata: async () => ({}) as never,
        updateCharacterDefinition: async () => ({}) as never,
        archiveCharacter: async () => ({}) as never,
        resolveLaunchCharacter: async () => null,
        startCharacterAuthoringSession: async () => { throw new Error("not used"); },
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
  deps.broadcastModelCatalog(snapshot);

  assert.equal(
    (receivedDeps as { window: { openHomeWindow(): Promise<void> } }).window
      .openHomeWindow instanceof Function,
    true,
  );
  assert.equal(
    (
      receivedDeps as {
        window: {
          showSessionMonitorContextMenu: typeof showSessionMonitorContextMenu;
        };
      }
    ).window.showSessionMonitorContextMenu,
    showSessionMonitorContextMenu,
  );
  assert.deepEqual(calls, ["initialize", "registerIpcHandlers", "broadcast:1"]);
});

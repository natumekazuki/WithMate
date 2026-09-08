import assert from "node:assert/strict";
import test from "node:test";

import { createMainBootstrapDeps } from "../../src-electron/main-bootstrap-deps.js";
import type { MainIpcRegistrationDeps } from "../../src-electron/main-ipc-registration.js";

// @test-value v2
// kind = "regression"
// claim = "bootstrapはResource budget設定を含むgrouped IPC依存をMain IPC登録へ渡す"
// oracle = { type = "contract", ref = "src-electron/main-bootstrap-deps.ts createMainBootstrapDeps" }
// fault = "Resource budget settings依存を含むIPC registration dependency groupがbootstrapで欠落する"
// observable = "registerMainIpcHandlersが受け取るregistrationDepsとbootstrap呼び出し記録"
// observation_boundary = "component-behavior"
// scope = "main-bootstrap-deps.test"
// lifecycle = "permanent"
// @end-test-value
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
        resolveSessionWindow: () => null,
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
        copySessionFilePreviewImage: async () => ({ status: "copied" }),
        showSessionFilePreviewImageContextMenu: async () => ({ status: "dismissed" }),
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
        updateChatLayoutPreference: () => ({}) as never,
        getResourceBudget: (input) => {
          calls.push(`budgetGet:${input.sessionId}`);
          return { accountId: "budget-root-1" } as never;
        },
        listResourceBudgets: (input) => {
          calls.push(`budgetList:${input.sessionId}:${input.limit}:${input.cursor ?? ""}`);
          return { items: [], nextCursor: "budget-root-2" };
        },
        configureResourceBudgetAsTrustedUser: (input) => {
          calls.push(
            `budgetConfigure:${input.sessionId}:${input.accountId}:${input.expectedRevision}:${input.idempotencyKey}`,
          );
          return { accountId: input.accountId, revision: input.expectedRevision + 1 } as never;
        },
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
      },
      promptTemplates: {
        listPromptTemplates: () => [],
        createPromptTemplate: () => [],
        updatePromptTemplate: () => [],
        deletePromptTemplate: () => [],
      },
      sessionQuery: {
        listSessionSummaryPage: () => ({ entries: [], nextCursor: null, hasMore: false }),
        listSessionCharacterUsage: () => [],
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
        listOpenSessionWindowIdsPage: () => ({ sessionIds: [], nextCursor: null, hasMore: false }),
        listOpenCompanionReviewWindowIds: () => [],
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
        deleteSessionsLastActiveBefore: () => ({ deletedSessionIds: [], skippedRunningSessionIds: [] }),
        runSessionTurn: async () => ({}) as never,
        cancelSessionRun: () => {},
      },
      sessionSchedules: {
        listSessionSchedules: () => [],
        getSessionSchedule: () => null,
        createSessionSchedule: () => ({}) as never,
        updateSessionSchedule: () => ({}) as never,
        pauseSessionSchedule: () => ({}) as never,
        resumeSessionSchedule: () => ({}) as never,
        deleteSessionSchedule: () => {},
        runSessionScheduleNow: () => ({}) as never,
      },
      character: {
        listCharacters: async () => [],
        getCharacter: async () => null,
        createCharacter: async () => ({}) as never,
        updateCharacterMetadata: async () => ({}) as never,
        updateCharacterDefinition: async () => ({}) as never,
        archiveCharacter: async () => ({}) as never,
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
  const registrationDeps = receivedDeps as MainIpcRegistrationDeps;
  const budget = await registrationDeps.getResourceBudget({ sessionId: "root-1" });
  const budgetPage = await registrationDeps.listResourceBudgets({
    sessionId: "root-1",
    limit: 25,
    cursor: "budget-root-1",
  });
  const configuredBudget = await registrationDeps.configureResourceBudgetAsTrustedUser({
    sessionId: "root-1",
    accountId: "budget-root-1",
    expectedRevision: 4,
    retryPerExecutionLimit: 5,
    idempotencyKey: "settings-1",
  });
  await deps.createHomeWindow();
  deps.broadcastModelCatalog(snapshot);

  assert.equal(registrationDeps.openHomeWindow instanceof Function, true);
  assert.deepEqual(budget, { accountId: "budget-root-1" });
  assert.deepEqual(budgetPage, { items: [], nextCursor: "budget-root-2" });
  assert.deepEqual(configuredBudget, { accountId: "budget-root-1", revision: 5 });
  assert.deepEqual(calls, [
    "initialize",
    "registerIpcHandlers",
    "budgetGet:root-1",
    "budgetList:root-1:25:budget-root-1",
    "budgetConfigure:root-1:budget-root-1:4:settings-1",
    "openHome",
    "broadcast:1",
  ]);
});

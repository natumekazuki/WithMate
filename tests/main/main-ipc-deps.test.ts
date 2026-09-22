import assert from "node:assert/strict";
import test from "node:test";
import type { WebContents } from "electron";

import { createMainIpcRegistrationDeps } from "../../src-electron/app/main-ipc-deps.js";
import type {
  MainIpcCatalogDepsArgs,
  MainIpcPromptTemplateDepsArgs,
  MainIpcSessionQueryDepsArgs,
  MainIpcSettingsDepsArgs,
  MainIpcWindowDepsArgs,
} from "../../src-electron/app/main-ipc-deps.js";

// @test-value v2
// kind = "contract"
// claim = "createMainIpcRegistrationDepsはSession Monitorのcontext menu、終了flush ACK、Auxiliary ID付きwindow delegateをwindow groupからregistration depsへ保持する"
// oracle = { type = "contract", ref = "createMainIpcRegistrationDeps window delegate mapping" }
// fault = "window groupに追加したdelegateが内部factoryからregistration depsへ欠落するか、Auxiliary IDを親Window delegateへ渡さない"
// observable = "生成されたregistration depsのflush ACK、context menu delegateへ渡るevent/request引数、およびwindow delegateの呼び出し引数"
// observation_boundary = "component-behavior"
// scope = "main IPC dependency grouping"
// lifecycle = "permanent"
// impact = "Main IPC handlerから終了flush ACKとSession Monitor native menu serviceへ到達できるようにする"
// distinction = "grouped dependency mappingだけを検証し、IPC request validationとnative selectionは別testで扱う"
// @end-test-value
test("createMainIpcRegistrationDeps は残存する window / mate delegate を組み立てる", async () => {
  const calls: string[] = [];
  const contextMenuArgs: unknown[][] = [];
  const showSessionMonitorContextMenu = async (event: unknown, request: unknown) => {
    contextMenuArgs.push([event, request]);
    calls.push("showSessionMonitorContextMenu");
    return { status: "dismissed" as const };
  };
  let acknowledged: { sender: unknown; payload: { requestId: string; success: boolean } } | null = null;
  const acknowledgeSessionDraftFlush = (event: { sender: unknown }, payload: { requestId: string; success: boolean }) => {
    acknowledged = { sender: event.sender, payload };
  };

  const deps = createMainIpcRegistrationDeps({
    window: {
      acknowledgeSessionDraftFlush,
      resolveEventWindow: () => null,
      resolveHomeWindow: () => null,
      resolveSessionWindow: () => null,
      async openSessionWindow(sessionId: string, auxiliarySessionId?: string) {
        calls.push(`openSession:${sessionId}:${auxiliarySessionId ?? "none"}`);
        return {} as never;
      },
      async getSessionWindowRestoreSet() {
        calls.push("getSessionWindowRestoreSet");
        return ["session-1"];
      },
      async restoreSessionWindows() {
        calls.push("restoreSessionWindows");
        return {
          requestedSessionIds: ["session-1"],
          openedSessionIds: ["session-1"],
          failures: [],
        };
      },
      async openHomeWindow() {
        calls.push("openHome");
        return {} as never;
      },
      async openSessionMonitorWindow() {
        return {} as never;
      },
      isSessionMonitorWindow() {
        return false;
      },
      showSessionMonitorContextMenu,
      async openSettingsWindow() {
        return {} as never;
      },
      async openMemoryV6ReviewWindow() {
        calls.push("openMemoryReview");
        return {} as never;
      },
      isSettingsWindow() {
        calls.push("isSettings");
        return true;
      },
      isMemoryV6ReviewWindow() {
        calls.push("isMemoryReview");
        return true;
      },
      async openCharacterEditorWindow() {
        return {} as never;
      },
      async openDiffWindow() {
        return {} as never;
      },
      isFilePreviewWindow: () => {
        throw new Error("unused window fixture method");
      },
      getFilePreviewWindowResource: () => {
        throw new Error("unused window fixture method");
      },
      isFilePreviewTokenWindow: () => {
        throw new Error("unused window fixture method");
      },
      async pickDirectory() {
        return null;
      },
      async validateWorkspaceDirectory() {
        return { valid: true };
      },
      async pickFile() {
        return null;
      },
      async pickFiles() {
        return [];
      },
      async pickSessionFiles() {
        return [];
      },
      async pickSessionFolder() {
        return null;
      },
      async pickSessionImageFile() {
        return null;
      },
      async pickImageFile() {
        return null;
      },
      copyFilesToSessionFiles: async () => {
        throw new Error("unused window fixture method");
      },
      savePastedSessionFile: async () => {
        throw new Error("unused window fixture method");
      },
      openSessionFilesDirectory: async () => {
        throw new Error("unused window fixture method");
      },
      openSessionFilesTerminal: async () => {
        throw new Error("unused window fixture method");
      },
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
      async openPathTarget() { return { status: "opened", targetType: "local-path", target: "" }; },
      async openAppLogFolder() {},
      async openCrashDumpFolder() {},
      async openSessionTerminal() {},
      async openTerminalAtPath() {},
    } satisfies MainIpcWindowDepsArgs,
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
      async resetAppDatabase() {
        return null;
      },
    } satisfies MainIpcSettingsDepsArgs,
    promptTemplates: {
      listPromptTemplates: () => [],
      createPromptTemplate: () => [],
      updatePromptTemplate: () => [],
      deletePromptTemplate: () => [],
    } satisfies MainIpcPromptTemplateDepsArgs,
    sessionQuery: {
      listSessionSummaryPage: () => ({ entries: [], nextCursor: null, hasMore: false }),
      listSessionCharacterUsage: () => [],
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
      async previewComposerInput() {
        return null;
      },
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
      deleteSessionsLastActiveBefore: () => ({ deletedSessionIds: [], skippedRunningSessionIds: [] }),
      async runSessionTurn() {
        return {} as never;
      },
      cancelSessionRun: () => {},
      setSessionPinned: () => { throw new Error("not used"); },
    },
    character: {
      async listCharacters() {
        return [];
      },
      async getCharacter() {
        return null;
      },
      async createCharacter() {
        return {} as never;
      },
      async updateCharacterMetadata() {
        return {} as never;
      },
      async updateCharacterDefinition() {
        return {} as never;
      },
      async archiveCharacter() {
        return {} as never;
      },
      async resolveLaunchCharacter() {
        return null;
      },
      async startCharacterAuthoringSession() { throw new Error("not used"); },
    },
    mate: {
      getMateState() {
        calls.push("getMateState");
        return "not_created";
      },
      getMateProfile() {
        calls.push("getMateProfile");
        return null;
      },
      async createMate(input) {
        calls.push(`createMate:${input.displayName}`);
        return {} as never;
      },
      async updateMate(input) {
        calls.push(`updateMate:${input.displayName}`);
        return {} as never;
      },
      async setMateAvatar(input) {
        calls.push(`setMateAvatar:${input.avatarFilePath ?? "clear"}`);
        return {} as never;
      },
      async resetMate() {
        calls.push("resetMate");
      },
    },
  });

  assert.equal(await deps.openHomeWindow(), undefined);
  assert.equal(deps.acknowledgeSessionDraftFlush, acknowledgeSessionDraftFlush);
  const sender = {} as WebContents;
  const payload = { requestId: "flush-1", success: true };
  deps.acknowledgeSessionDraftFlush({ sender }, payload);
  assert.deepEqual(acknowledged, { sender, payload });
  assert.equal(await deps.openMemoryV6ReviewWindow(), undefined);
  assert.equal(deps.isMemoryV6ReviewWindow({} as never), true);
  assert.equal(deps.isSettingsWindow({} as never), true);
  assert.equal(await deps.openSessionWindow("session-1", "aux-1"), undefined);
  assert.deepEqual(await deps.getSessionWindowRestoreSet(), ["session-1"]);
  assert.deepEqual((await deps.restoreSessionWindows()).openedSessionIds, ["session-1"]);
  const contextMenuEvent = { sender: "monitor" };
  const contextMenuRequest = { sessionId: "session-1", point: { x: 12, y: 34 } };
  assert.deepEqual(await deps.showSessionMonitorContextMenu(contextMenuEvent as never, contextMenuRequest as never), { status: "dismissed" });
  assert.deepEqual(contextMenuArgs, [[contextMenuEvent, contextMenuRequest]]);
  await deps.getMateState();
  await deps.getMateProfile();
  await deps.createMate({ displayName: "Buddy" });
  await deps.updateMate({ displayName: "Buddy 2" });
  await deps.setMateAvatar({ avatarFilePath: "C:/avatar.png" });
  await deps.resetMate();
  assert.deepEqual(calls, [
    "openHome",
    "openMemoryReview",
    "isMemoryReview",
    "isSettings",
    "openSession:session-1:aux-1",
    "getSessionWindowRestoreSet",
    "restoreSessionWindows",
    "showSessionMonitorContextMenu",
    "getMateState",
    "getMateProfile",
    "createMate:Buddy",
    "updateMate:Buddy 2",
    "setMateAvatar:C:/avatar.png",
    "resetMate",
  ]);
});

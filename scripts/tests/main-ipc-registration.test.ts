import assert from "node:assert/strict";
import test from "node:test";

import type { IpcMain } from "electron";
import type { MateGrowthApplyResult } from "../../src/mate/mate-growth-apply-result.js";

import {
  MATE_NOT_CREATED_ERROR_MESSAGE,
  registerMainIpcHandlers,
} from "../../src-electron/main-ipc-registration.js";
import {
  WITHMATE_CANCEL_SESSION_RUN_CHANNEL,
  WITHMATE_CANCEL_COMPANION_SESSION_RUN_CHANNEL,
  WITHMATE_CREATE_COMPANION_SESSION_CHANNEL,
  WITHMATE_CREATE_SESSION_CHANNEL,
  WITHMATE_CREATE_MATE_CHANNEL,
  WITHMATE_COPY_FILES_TO_SESSION_FILES_CHANNEL,
  WITHMATE_APPLY_MATE_GROWTH_CHANNEL,
  WITHMATE_LIST_MATE_GROWTH_EVENTS_CHANNEL,
  WITHMATE_CORRECT_MATE_GROWTH_EVENT_CHANNEL,
  WITHMATE_DISABLE_MATE_GROWTH_EVENT_CHANNEL,
  WITHMATE_FORGET_MATE_GROWTH_EVENT_CHANNEL,
  WITHMATE_DELETE_PROJECT_MEMORY_ENTRY_CHANNEL,
  WITHMATE_DELETE_SESSION_MEMORY_CHANNEL,
  WITHMATE_DELETE_SESSION_CHANNEL,
  WITHMATE_DISCARD_COMPANION_SESSION_CHANNEL,
  WITHMATE_DROP_COMPANION_TARGET_STASH_CHANNEL,
  WITHMATE_EXPORT_MODEL_CATALOG_CHANNEL,
  WITHMATE_EXPORT_MODEL_CATALOG_FILE_CHANNEL,
  WITHMATE_FORGET_MATE_PROFILE_ITEM_CHANNEL,
  WITHMATE_GET_APP_DATABASE_DIAGNOSTICS_CHANNEL,
  WITHMATE_GET_APP_SETTINGS_CHANNEL,
  WITHMATE_LIST_PROVIDER_INSTRUCTION_TARGETS_CHANNEL,
  WITHMATE_UPSERT_PROVIDER_INSTRUCTION_TARGET_CHANNEL,
  WITHMATE_GET_COMPANION_AUDIT_LOG_DETAIL_CHANNEL,
  WITHMATE_GET_COMPANION_AUDIT_LOG_DETAIL_SECTION_CHANNEL,
  WITHMATE_GET_COMPANION_AUDIT_LOG_OPERATION_DETAIL_CHANNEL,
  WITHMATE_GET_COMPANION_MESSAGE_ARTIFACT_CHANNEL,
  WITHMATE_GET_COMPANION_REVIEW_SNAPSHOT_CHANNEL,
  WITHMATE_GET_COMPANION_SESSION_CHANNEL,
  WITHMATE_GET_DIFF_PREVIEW_CHANNEL,
  WITHMATE_GET_LIVE_SESSION_RUN_CHANNEL,
  WITHMATE_GET_MEMORY_MANAGEMENT_PAGE_CHANNEL,
  WITHMATE_GET_MEMORY_MANAGEMENT_SNAPSHOT_CHANNEL,
  WITHMATE_GET_MATE_EMBEDDING_SETTINGS_CHANNEL,
  WITHMATE_GET_MATE_GROWTH_SETTINGS_CHANNEL,
  WITHMATE_UPDATE_MATE_GROWTH_SETTINGS_CHANNEL,
  WITHMATE_UPDATE_MATE_CHANNEL,
  WITHMATE_GET_MATE_PROFILE_CHANNEL,
  WITHMATE_GET_MATE_STATE_CHANNEL,
  WITHMATE_GET_MODEL_CATALOG_CHANNEL,
  WITHMATE_GET_PROVIDER_QUOTA_TELEMETRY_CHANNEL,
  WITHMATE_GET_SESSION_AUDIT_LOG_DETAIL_CHANNEL,
  WITHMATE_GET_SESSION_AUDIT_LOG_DETAIL_SECTION_CHANNEL,
  WITHMATE_GET_SESSION_AUDIT_LOG_OPERATION_DETAIL_CHANNEL,
  WITHMATE_GET_SESSION_BACKGROUND_ACTIVITY_CHANNEL,
  WITHMATE_GET_SESSION_CHANNEL,
  WITHMATE_GET_SESSION_CONTEXT_TELEMETRY_CHANNEL,
  WITHMATE_GET_SESSION_MESSAGE_ARTIFACT_CHANNEL,
  WITHMATE_IMPORT_MODEL_CATALOG_CHANNEL,
  WITHMATE_IMPORT_MODEL_CATALOG_FILE_CHANNEL,
  WITHMATE_LIST_COMPANION_AUDIT_LOGS_CHANNEL,
  WITHMATE_LIST_COMPANION_AUDIT_LOG_SUMMARIES_CHANNEL,
  WITHMATE_LIST_COMPANION_AUDIT_LOG_SUMMARY_PAGE_CHANNEL,
  WITHMATE_LIST_COMPANION_SESSION_SUMMARIES_CHANNEL,
  WITHMATE_LIST_OPEN_COMPANION_REVIEW_WINDOW_IDS_CHANNEL,
  WITHMATE_LIST_OPEN_SESSION_WINDOW_IDS_CHANNEL,
  WITHMATE_LIST_SESSION_AUDIT_LOGS_CHANNEL,
  WITHMATE_LIST_SESSION_AUDIT_LOG_SUMMARIES_CHANNEL,
  WITHMATE_LIST_SESSION_AUDIT_LOG_SUMMARY_PAGE_CHANNEL,
  WITHMATE_LIST_SESSION_CUSTOM_AGENTS_CHANNEL,
  WITHMATE_LIST_SESSION_SKILLS_CHANNEL,
  WITHMATE_LIST_SESSION_SUMMARIES_CHANNEL,
  WITHMATE_LIST_WORKSPACE_CUSTOM_AGENTS_CHANNEL,
  WITHMATE_LIST_WORKSPACE_SKILLS_CHANNEL,
  WITHMATE_MERGE_COMPANION_SELECTED_FILES_CHANNEL,
  WITHMATE_OPEN_APP_LOG_FOLDER_CHANNEL,
  WITHMATE_OPEN_COMPANION_MERGE_WINDOW_CHANNEL,
  WITHMATE_OPEN_COMPANION_REVIEW_WINDOW_CHANNEL,
  WITHMATE_OPEN_CRASH_DUMP_FOLDER_CHANNEL,
  WITHMATE_OPEN_DIFF_WINDOW_CHANNEL,
  WITHMATE_OPEN_HOME_WINDOW_CHANNEL,
  WITHMATE_OPEN_MATE_TALK_WINDOW_CHANNEL,
  WITHMATE_OPEN_MEMORY_MANAGEMENT_WINDOW_CHANNEL,
  WITHMATE_OPEN_PATH_CHANNEL,
  WITHMATE_OPEN_SESSION_CHANNEL,
  WITHMATE_OPEN_SESSION_FILES_DIRECTORY_CHANNEL,
  WITHMATE_OPEN_SESSION_FILES_TERMINAL_CHANNEL,
  WITHMATE_OPEN_SESSION_MONITOR_WINDOW_CHANNEL,
  WITHMATE_OPEN_SESSION_TERMINAL_CHANNEL,
  WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL,
  WITHMATE_OPEN_TERMINAL_AT_PATH_CHANNEL,
  WITHMATE_PICK_DIRECTORY_CHANNEL,
  WITHMATE_PICK_FILE_CHANNEL,
  WITHMATE_PICK_FILES_CHANNEL,
  WITHMATE_PICK_SESSION_FILES_CHANNEL,
  WITHMATE_PICK_IMAGE_FILE_CHANNEL,
  WITHMATE_PREVIEW_COMPANION_COMPOSER_INPUT_CHANNEL,
  WITHMATE_PREVIEW_COMPOSER_INPUT_CHANNEL,
  WITHMATE_RESET_APP_DATABASE_CHANNEL,
  WITHMATE_RESET_MATE_CHANNEL,
  WITHMATE_RESTORE_COMPANION_TARGET_STASH_CHANNEL,
  WITHMATE_RESOLVE_LIVE_APPROVAL_CHANNEL,
  WITHMATE_RESOLVE_LIVE_ELICITATION_CHANNEL,
  WITHMATE_RUN_MATE_TALK_TURN_CHANNEL,
  WITHMATE_RUN_SESSION_TURN_CHANNEL,
  WITHMATE_RUN_COMPANION_SESSION_TURN_CHANNEL,
  WITHMATE_SEARCH_COMPANION_WORKSPACE_FILES_CHANNEL,
  WITHMATE_SEARCH_WORKSPACE_FILES_CHANNEL,
  WITHMATE_SAVE_PASTED_SESSION_FILE_CHANNEL,
  WITHMATE_SET_MATE_AVATAR_CHANNEL,
  WITHMATE_STASH_COMPANION_TARGET_CHANGES_CHANNEL,
  WITHMATE_START_MATE_EMBEDDING_DOWNLOAD_CHANNEL,
  WITHMATE_SYNC_COMPANION_TARGET_CHANNEL,
  WITHMATE_UPDATE_APP_SETTINGS_CHANNEL,
  WITHMATE_UPDATE_COMPANION_SESSION_CHANNEL,
  WITHMATE_UPDATE_SESSION_CHANNEL,
} from "../../src/withmate-ipc-channels.js";

type Handler = (...args: unknown[]) => unknown;

const zeroGrowthResult: MateGrowthApplyResult = {
  candidateCount: 0,
  appliedCount: 0,
  skippedCount: 0,
  revisionId: null,
};

function createIpcMainStub() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle(channel: string, handler: Handler) {
      handlers.set(channel, handler);
    },
    on() {
      return ipcMain;
    },
  } as unknown as IpcMain;

  return { ipcMain, handlers };
}

test("registerMainIpcHandlers は主要 channel を登録して delegate を呼ぶ", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const calls: string[] = [];
  const auditPageRequests: unknown[] = [];
  const expectedGrowthResult = {
    candidateCount: 4,
    appliedCount: 3,
    skippedCount: 1,
    revisionId: "rev-001",
  };
  let mateState: "active" | "not_created" | "draft" | "deleted" = "active";

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
    async openMemoryManagementWindow() {
      calls.push("openMemory");
    },
    async openMateTalkWindow() {
      calls.push("openMateTalk");
    },
    async openDiffWindow() {
      calls.push("openDiff");
    },
    async openCompanionReviewWindow(sessionId) {
      calls.push(`openCompanionReview:${sessionId}`);
    },
    async openCompanionMergeWindow(sessionId) {
      calls.push(`openCompanionMerge:${sessionId}`);
    },
    listSessionSummaries: () => [],
    listCompanionSessionSummaries: () => [],
    listSessionAuditLogs: () => [],
    listSessionAuditLogSummaries: () => [],
    listSessionAuditLogSummaryPage: (sessionId, request) => {
      auditPageRequests.push({ sessionId, request });
      return { entries: [], nextCursor: null, hasMore: false, total: 0 };
    },
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
    listOpenSessionWindowIds: () => ["session-1"],
    listOpenCompanionReviewWindowIds: () => [],
    getAppSettings: () => ({ providers: {}, codingProviderSettings: {}, memoryExtractionProviderSettings: {} } as never),
    updateAppSettings: (settings) => settings,
    getAppDatabaseDiagnostics: () => ({}) as never,
    getMateEmbeddingSettings: () => null,
    getMateGrowthSettings: () => {
      calls.push("getMateGrowthSettings");
      return null;
    },
    updateMateGrowthSettings: () => {
      calls.push("updateMateGrowthSettings");
      return null;
    },
    listProviderInstructionTargets: () => [],
    upsertProviderInstructionTarget: (input) => input as never,
    startMateEmbeddingDownload: () => {
      calls.push("startMateEmbeddingDownload");
    },
    async resetAppDatabase() {
      return null;
    },
    getMemoryManagementSnapshot: () => ({ sessionMemories: [], projectMemories: [], mateProfileItems: [] }),
    getMemoryManagementPage: () => ({
      snapshot: { sessionMemories: [], projectMemories: [], mateProfileItems: [] },
      pages: {
        session: { nextCursor: null, hasMore: false, total: 0 },
        project: { nextCursor: null, hasMore: false, total: 0 },
        mate_profile: { nextCursor: null, hasMore: false, total: 0 },
      },
    }),
    deleteSessionMemory: () => {
      calls.push("deleteSessionMemory");
    },
    deleteProjectMemoryEntry: () => {
      calls.push("deleteProjectMemoryEntry");
    },
    forgetMateProfileItem: () => {
      calls.push("forgetMateProfileItem");
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
    getSessionMessageArtifact: () => null,
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
    resolveLiveElicitation: () => {
      calls.push("resolveElicitation");
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
    async pickDirectory() {
      return "dir";
    },
    async pickFile() {
      return "file";
    },
    async pickFiles() {
      return ["file-1", "file-2"];
    },
    async pickSessionFiles() {
      return ["session-file-1"];
    },
    async pickImageFile() {
      return "image";
    },
    async openPathTarget() {
      calls.push("openPath");
    },
    async openAppLogFolder() {
      calls.push("openLogs");
    },
    async openCrashDumpFolder() {
      calls.push("openCrashDumps");
    },
    async openSessionTerminal() {
      calls.push("openTerminal");
    },
    async openTerminalAtPath() {
      calls.push("openTerminalAtPath");
    },
    async createCompanionSession() {
      return {} as never;
    },
    getCompanionSession: () => null,
    getCompanionMessageArtifact: () => null,
    async getCompanionReviewSnapshot() {
      return null;
    },
    async mergeCompanionSelectedFiles() {
      return {} as never;
    },
    async syncCompanionTarget() {
      return {} as never;
    },
    async stashCompanionTargetChanges() {
      return {} as never;
    },
    async restoreCompanionTargetStash() {
      return {} as never;
    },
    async dropCompanionTargetStash() {
      return {} as never;
    },
    async discardCompanionSession() {
      return {} as never;
    },
    async updateCompanionSession(session) {
      return session;
    },
    async previewCompanionComposerInput() {
      return { attachments: [], errors: [] };
    },
    async searchCompanionWorkspaceFiles() {
      return [];
    },
    async runCompanionSessionTurn() {
      return {} as never;
    },
    cancelCompanionSessionRun: () => {
      calls.push("cancelCompanionRun");
    },
    getMateState() {
      calls.push("getMateState");
      return mateState;
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
    async applyPendingGrowth() {
      calls.push("applyPendingGrowth");
      return expectedGrowthResult;
    },
    async listMateGrowthEvents(request) {
      calls.push(`listMateGrowthEvents:${request?.limit ?? "default"}`);
      return {
        events: [],
        limit: request?.limit ?? 20,
      };
    },
    async correctMateGrowthEvent(request) {
      calls.push(`correctMateGrowthEvent:${request.eventId}:${request.statement}`);
      return { event: null };
    },
    async disableMateGrowthEvent(request) {
      calls.push(`disableMateGrowthEvent:${request.eventId}`);
      return { event: null };
    },
    async forgetMateGrowthEvent(request) {
      calls.push(`forgetMateGrowthEvent:${request.eventId}`);
      return { event: null };
    },
    async runMateTalkTurn(input) {
      calls.push(`runMateTalk:${input.message}`);
      return {
        mateId: "mate-1",
        userMessage: input.message,
        assistantMessage: "受け取ったよ。",
        createdAt: "2026-05-04T00:00:00.000Z",
      };
    },
    async resetMate() {
      calls.push("resetMate");
    },
  });

  assert.ok(handlers.has("withmate:open-session"));
  assert.ok(handlers.has("withmate:list-session-summaries"));
  assert.ok(handlers.has("withmate:get-app-settings"));
  assert.ok(handlers.has(WITHMATE_GET_MATE_EMBEDDING_SETTINGS_CHANNEL));
  assert.ok(handlers.has(WITHMATE_GET_MATE_GROWTH_SETTINGS_CHANNEL));
  assert.ok(handlers.has(WITHMATE_UPDATE_MATE_GROWTH_SETTINGS_CHANNEL));
  assert.ok(handlers.has(WITHMATE_LIST_PROVIDER_INSTRUCTION_TARGETS_CHANNEL));
  assert.ok(handlers.has(WITHMATE_START_MATE_EMBEDDING_DOWNLOAD_CHANNEL));
  assert.ok(handlers.has(WITHMATE_UPSERT_PROVIDER_INSTRUCTION_TARGET_CHANNEL));
  assert.ok(handlers.has(WITHMATE_OPEN_MATE_TALK_WINDOW_CHANNEL));
  assert.ok(handlers.has("withmate:run-session-turn"));
  assert.ok(handlers.has(WITHMATE_GET_MATE_STATE_CHANNEL));
  assert.ok(handlers.has(WITHMATE_GET_MATE_PROFILE_CHANNEL));
  assert.ok(handlers.has(WITHMATE_CREATE_MATE_CHANNEL));
  assert.ok(handlers.has(WITHMATE_UPDATE_MATE_CHANNEL));
  assert.ok(handlers.has(WITHMATE_SET_MATE_AVATAR_CHANNEL));
  assert.ok(handlers.has(WITHMATE_APPLY_MATE_GROWTH_CHANNEL));
  assert.ok(handlers.has(WITHMATE_CORRECT_MATE_GROWTH_EVENT_CHANNEL));
  assert.ok(handlers.has(WITHMATE_DISABLE_MATE_GROWTH_EVENT_CHANNEL));
  assert.ok(handlers.has(WITHMATE_FORGET_MATE_GROWTH_EVENT_CHANNEL));
  assert.ok(handlers.has(WITHMATE_RUN_MATE_TALK_TURN_CHANNEL));
  assert.ok(handlers.has(WITHMATE_RESET_MATE_CHANNEL));

  await handlers.get("withmate:open-session")?.({}, "session-1");
  await handlers.get("withmate:open-memory-management-window")?.({});
  await handlers.get(WITHMATE_OPEN_MATE_TALK_WINDOW_CHANNEL)?.({});
  await handlers.get("withmate:cancel-session-run")?.({}, "session-1");
  await handlers.get("withmate:open-path")?.({}, "target", null);
  await handlers.get(WITHMATE_OPEN_APP_LOG_FOLDER_CHANNEL)?.({});
  await handlers.get(WITHMATE_GET_MATE_STATE_CHANNEL)?.();
  await handlers.get(WITHMATE_GET_MATE_PROFILE_CHANNEL)?.();
  await handlers.get(WITHMATE_CREATE_MATE_CHANNEL)?.({}, { displayName: "Buddy" });
  await handlers.get(WITHMATE_UPDATE_MATE_CHANNEL)?.({}, { displayName: "Buddy 2" });
  await handlers.get(WITHMATE_SET_MATE_AVATAR_CHANNEL)?.({}, { avatarFilePath: "C:/avatar.png" });
  await handlers.get(WITHMATE_RUN_MATE_TALK_TURN_CHANNEL)?.({}, { message: "hello" });
  assert.deepEqual(
    await handlers.get(WITHMATE_APPLY_MATE_GROWTH_CHANNEL)?.(),
    expectedGrowthResult,
  );
  assert.deepEqual(
    await handlers.get(WITHMATE_LIST_MATE_GROWTH_EVENTS_CHANNEL)?.({}, { limit: 5 }),
    { events: [], limit: 5 },
  );
  assert.deepEqual(
    await handlers.get(WITHMATE_CORRECT_MATE_GROWTH_EVENT_CHANNEL)?.({}, { eventId: "event-0", statement: "修正後" }),
    { event: null },
  );
  assert.deepEqual(
    await handlers.get(WITHMATE_DISABLE_MATE_GROWTH_EVENT_CHANNEL)?.({}, { eventId: "event-1" }),
    { event: null },
  );
  assert.deepEqual(
    await handlers.get(WITHMATE_FORGET_MATE_GROWTH_EVENT_CHANNEL)?.({}, { eventId: "event-2" }),
    { event: null },
  );
  await handlers.get(WITHMATE_GET_MATE_GROWTH_SETTINGS_CHANNEL)?.();
  await handlers.get(WITHMATE_UPDATE_MATE_GROWTH_SETTINGS_CHANNEL)?.({}, { enabled: false });
  await handlers.get(WITHMATE_RESET_MATE_CHANNEL)?.();
  const auditPageResult = await handlers.get(WITHMATE_LIST_SESSION_AUDIT_LOG_SUMMARY_PAGE_CHANNEL)?.(
    {},
    "session-1",
    { cursor: 50, limit: 25 },
  );

  assert.deepEqual(calls, [
    "getMateState",
    "openSession:session-1",
    "getMateState",
    "openMemory",
    "getMateState",
    "openMateTalk",
    "getMateState",
    "cancelRun",
    "getMateState",
    "openPath",
    "openLogs",
    "getMateState",
    "getMateProfile",
    "createMate:Buddy",
    "getMateState",
    "updateMate:Buddy 2",
    "getMateState",
    "setMateAvatar:C:/avatar.png",
    "getMateState",
    "runMateTalk:hello",
    "getMateState",
    "applyPendingGrowth",
    "getMateState",
    "listMateGrowthEvents:5",
    "getMateState",
    "correctMateGrowthEvent:event-0:修正後",
    "getMateState",
    "disableMateGrowthEvent:event-1",
    "getMateState",
    "forgetMateGrowthEvent:event-2",
    "getMateGrowthSettings",
    "updateMateGrowthSettings",
    "resetMate",
    "getMateState",
  ]);
  mateState = "not_created";
  await assert.rejects(
    async () => handlers.get("withmate:open-session")?.({}, "session-1"),
    { message: MATE_NOT_CREATED_ERROR_MESSAGE },
  );
  const applyPendingGrowthCallCountBefore = calls.filter((call) => call === "applyPendingGrowth").length;
  await assert.rejects(
    async () => handlers.get(WITHMATE_APPLY_MATE_GROWTH_CHANNEL)?.(),
    { message: MATE_NOT_CREATED_ERROR_MESSAGE },
  );
  assert.strictEqual(
    calls.filter((call) => call === "applyPendingGrowth").length,
    applyPendingGrowthCallCountBefore,
    "applyPendingGrowth should not be executed when mate is not_created",
  );
  const openMemoryCallCountBefore = calls.filter((call) => call === "openMemory").length;
  await assert.rejects(
    async () => handlers.get("withmate:open-memory-management-window")?.({}),
    { message: MATE_NOT_CREATED_ERROR_MESSAGE },
  );
  assert.strictEqual(
    calls.filter((call) => call === "openMemory").length,
    openMemoryCallCountBefore,
    "openMemoryManagementWindow should not be executed when mate is not_created",
  );
  const deleteSessionMemoryCallCountBefore = calls.filter((call) => call === "deleteSessionMemory").length;
  await assert.rejects(
    async () => handlers.get(WITHMATE_DELETE_SESSION_MEMORY_CHANNEL)?.({}, "memory-1"),
    { message: MATE_NOT_CREATED_ERROR_MESSAGE },
  );
  assert.strictEqual(
    calls.filter((call) => call === "deleteSessionMemory").length,
    deleteSessionMemoryCallCountBefore,
    "deleteSessionMemory should not be executed when mate is not_created",
  );
  const forgetMateProfileItemCallCountBefore = calls.filter((call) => call === "forgetMateProfileItem").length;
  await assert.rejects(
    async () => handlers.get(WITHMATE_FORGET_MATE_PROFILE_ITEM_CHANNEL)?.({}, "mate-profile-item-1"),
    { message: MATE_NOT_CREATED_ERROR_MESSAGE },
  );
  assert.strictEqual(
    calls.filter((call) => call === "forgetMateProfileItem").length,
    forgetMateProfileItemCallCountBefore,
    "forgetMateProfileItem should not be executed when mate is not_created",
  );
  await handlers.get(WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL)?.({});
  await handlers.get(WITHMATE_LIST_OPEN_SESSION_WINDOW_IDS_CHANNEL)?.();
  await handlers.get(WITHMATE_GET_APP_SETTINGS_CHANNEL)?.();
  await handlers.get(WITHMATE_GET_MATE_EMBEDDING_SETTINGS_CHANNEL)?.();
  await handlers.get(WITHMATE_START_MATE_EMBEDDING_DOWNLOAD_CHANNEL)?.();

  assert.deepEqual(calls, [
    "getMateState",
    "openSession:session-1",
    "getMateState",
    "openMemory",
    "getMateState",
    "openMateTalk",
    "getMateState",
    "cancelRun",
    "getMateState",
    "openPath",
    "openLogs",
    "getMateState",
    "getMateProfile",
    "createMate:Buddy",
    "getMateState",
    "updateMate:Buddy 2",
    "getMateState",
    "setMateAvatar:C:/avatar.png",
    "getMateState",
    "runMateTalk:hello",
    "getMateState",
    "applyPendingGrowth",
    "getMateState",
    "listMateGrowthEvents:5",
    "getMateState",
    "correctMateGrowthEvent:event-0:修正後",
    "getMateState",
    "disableMateGrowthEvent:event-1",
    "getMateState",
    "forgetMateGrowthEvent:event-2",
    "getMateGrowthSettings",
    "updateMateGrowthSettings",
    "resetMate",
    "getMateState",
    "getMateState",
    "getMateState",
    "getMateState",
    "getMateState",
    "getMateState",
    "openSettings",
    "startMateEmbeddingDownload",
  ]);
  assert.deepEqual(auditPageRequests, [{ sessionId: "session-1", request: { cursor: 50, limit: 25 } }]);
  assert.deepEqual(auditPageResult, { entries: [], nextCursor: null, hasMore: false, total: 0 });

  mateState = "draft";
  const openSettingsCallCountBeforeDraft = calls.filter((call) => call === "openSettings").length;
  await handlers.get(WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL)?.({});
  assert.strictEqual(
    calls.filter((call) => call === "openSettings").length,
    openSettingsCallCountBeforeDraft + 1,
  );
  const deleteSessionCallCountBeforeDraft = calls.filter((call) => call === "deleteSession").length;
  await assert.rejects(
    async () => handlers.get(WITHMATE_DELETE_SESSION_CHANNEL)?.({}, "session-1"),
    { message: MATE_NOT_CREATED_ERROR_MESSAGE },
  );
  assert.strictEqual(
    calls.filter((call) => call === "deleteSession").length,
    deleteSessionCallCountBeforeDraft,
  );

  mateState = "deleted";
  const getMateStateCallCountBeforeDeleted = calls.filter((call) => call === "getMateState").length;
  await handlers.get(WITHMATE_GET_MATE_STATE_CHANNEL)?.();
  assert.strictEqual(
    calls.filter((call) => call === "getMateState").length,
    getMateStateCallCountBeforeDeleted + 1,
  );
});

test("registerMainIpcHandlers は current invoke channel を domain ごとにすべて登録する", () => {
  const { ipcMain, handlers } = createIpcMainStub();

  registerMainIpcHandlers(ipcMain, {
    resolveEventWindow: () => null,
    resolveHomeWindow: () => null,
    async openSessionWindow() {},
    async openHomeWindow() {},
    async openSessionMonitorWindow() {},
    async openSettingsWindow() {},
    async openMemoryManagementWindow() {},
    async openMateTalkWindow() {},
    async openDiffWindow() {},
    async openCompanionReviewWindow() {},
    async openCompanionMergeWindow() {},
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
    getAppSettings: () => ({ providers: {}, codingProviderSettings: {}, memoryExtractionProviderSettings: {} } as never),
    updateAppSettings: (settings) => settings,
    getAppDatabaseDiagnostics: () => ({}) as never,
    getMateEmbeddingSettings: () => null,
    getMateGrowthSettings: () => null,
    updateMateGrowthSettings: () => null,
    listProviderInstructionTargets: () => [],
    upsertProviderInstructionTarget: (input) => input as never,
    startMateEmbeddingDownload: () => {},
    async resetAppDatabase() { return null; },
    getMemoryManagementSnapshot: () => ({ sessionMemories: [], projectMemories: [], mateProfileItems: [] }),
    getMemoryManagementPage: () => ({
      snapshot: { sessionMemories: [], projectMemories: [], mateProfileItems: [] },
      pages: {
        session: { nextCursor: null, hasMore: false, total: 0 },
        project: { nextCursor: null, hasMore: false, total: 0 },
        mate_profile: { nextCursor: null, hasMore: false, total: 0 },
      },
    }),
    deleteSessionMemory() {},
    deleteProjectMemoryEntry() {},
    forgetMateProfileItem() {},
    getModelCatalog: () => null,
    importModelCatalogDocument: () => ({ revision: 1, providers: [] }),
    async importModelCatalogFromFile() { return null; },
    exportModelCatalogDocument: () => null,
    async exportModelCatalogToFile() { return null; },
    getSession: () => null,
    getSessionMessageArtifact: () => null,
    getDiffPreview: () => null,
    getLiveSessionRun: () => null,
    async getProviderQuotaTelemetry() { return null; },
    getSessionContextTelemetry: () => null,
    getSessionBackgroundActivity: () => null,
    resolveLiveApproval() {},
    resolveLiveElicitation() {},
    createSession: () => ({}) as never,
    updateSession: () => ({}) as never,
    deleteSession() {},
    async previewComposerInput() { return null; },
    async searchWorkspaceFiles() { return []; },
    async runSessionTurn() { return {} as never; },
    cancelSessionRun() {},
    async pickDirectory() { return null; },
    async pickFile() { return null; },
    async pickFiles() { return []; },
    async pickSessionFiles() { return []; },
    async pickImageFile() { return null; },
    async openPathTarget() {},
    async openAppLogFolder() {},
    async openCrashDumpFolder() {},
    async openSessionTerminal() {},
    async openTerminalAtPath() {},
    async createCompanionSession() { return {} as never; },
    getCompanionSession: () => null,
    getCompanionMessageArtifact: () => null,
    async getCompanionReviewSnapshot() { return null; },
    async mergeCompanionSelectedFiles() { return {} as never; },
    async syncCompanionTarget() { return {} as never; },
    async stashCompanionTargetChanges() { return {} as never; },
    async restoreCompanionTargetStash() { return {} as never; },
    async dropCompanionTargetStash() { return {} as never; },
    async discardCompanionSession() { return {} as never; },
    async updateCompanionSession(session) { return session; },
    async previewCompanionComposerInput() { return { attachments: [], errors: [] }; },
    async searchCompanionWorkspaceFiles() { return []; },
    async runCompanionSessionTurn() { return {} as never; },
    cancelCompanionSessionRun() {},
    getMateState() {
      return "not_created";
    },
    getMateProfile() {
      return null;
    },
    async applyPendingGrowth() {
      return zeroGrowthResult;
    },
    async listMateGrowthEvents() {
      return { events: [], limit: 20 };
    },
    async correctMateGrowthEvent() {
      return { event: null };
    },
    async disableMateGrowthEvent() {
      return { event: null };
    },
    async forgetMateGrowthEvent() {
      return { event: null };
    },
    async createMate() {
      return {} as never;
    },
    async updateMate() {
      return {} as never;
    },
    async setMateAvatar() {
      return {} as never;
    },
    async runMateTalkTurn() {
      return {} as never;
    },
    async resetMate() {
      return;
    },
  });

  const expectedChannels = [
    WITHMATE_OPEN_SESSION_CHANNEL,
    WITHMATE_OPEN_HOME_WINDOW_CHANNEL,
    WITHMATE_OPEN_SESSION_MONITOR_WINDOW_CHANNEL,
    WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL,
    WITHMATE_OPEN_MEMORY_MANAGEMENT_WINDOW_CHANNEL,
    WITHMATE_OPEN_MATE_TALK_WINDOW_CHANNEL,
    WITHMATE_OPEN_DIFF_WINDOW_CHANNEL,
    WITHMATE_OPEN_COMPANION_REVIEW_WINDOW_CHANNEL,
    WITHMATE_OPEN_COMPANION_MERGE_WINDOW_CHANNEL,
    WITHMATE_PICK_DIRECTORY_CHANNEL,
    WITHMATE_PICK_FILE_CHANNEL,
    WITHMATE_PICK_FILES_CHANNEL,
    WITHMATE_PICK_SESSION_FILES_CHANNEL,
    WITHMATE_PICK_IMAGE_FILE_CHANNEL,
    WITHMATE_COPY_FILES_TO_SESSION_FILES_CHANNEL,
    WITHMATE_SAVE_PASTED_SESSION_FILE_CHANNEL,
    WITHMATE_OPEN_SESSION_FILES_DIRECTORY_CHANNEL,
    WITHMATE_OPEN_SESSION_FILES_TERMINAL_CHANNEL,
    WITHMATE_OPEN_PATH_CHANNEL,
    WITHMATE_OPEN_APP_LOG_FOLDER_CHANNEL,
    WITHMATE_OPEN_CRASH_DUMP_FOLDER_CHANNEL,
    WITHMATE_OPEN_SESSION_TERMINAL_CHANNEL,
    WITHMATE_OPEN_TERMINAL_AT_PATH_CHANNEL,
    WITHMATE_GET_MODEL_CATALOG_CHANNEL,
    WITHMATE_IMPORT_MODEL_CATALOG_CHANNEL,
    WITHMATE_IMPORT_MODEL_CATALOG_FILE_CHANNEL,
    WITHMATE_EXPORT_MODEL_CATALOG_CHANNEL,
    WITHMATE_EXPORT_MODEL_CATALOG_FILE_CHANNEL,
    WITHMATE_GET_APP_SETTINGS_CHANNEL,
    WITHMATE_GET_APP_DATABASE_DIAGNOSTICS_CHANNEL,
    WITHMATE_LIST_PROVIDER_INSTRUCTION_TARGETS_CHANNEL,
    WITHMATE_UPDATE_APP_SETTINGS_CHANNEL,
    WITHMATE_UPSERT_PROVIDER_INSTRUCTION_TARGET_CHANNEL,
    WITHMATE_RESET_APP_DATABASE_CHANNEL,
    WITHMATE_GET_MEMORY_MANAGEMENT_SNAPSHOT_CHANNEL,
    WITHMATE_GET_MEMORY_MANAGEMENT_PAGE_CHANNEL,
    WITHMATE_DELETE_SESSION_MEMORY_CHANNEL,
    WITHMATE_DELETE_PROJECT_MEMORY_ENTRY_CHANNEL,
    WITHMATE_FORGET_MATE_PROFILE_ITEM_CHANNEL,
    WITHMATE_LIST_SESSION_SUMMARIES_CHANNEL,
    WITHMATE_LIST_SESSION_AUDIT_LOGS_CHANNEL,
    WITHMATE_LIST_SESSION_AUDIT_LOG_SUMMARIES_CHANNEL,
    WITHMATE_LIST_SESSION_AUDIT_LOG_SUMMARY_PAGE_CHANNEL,
    WITHMATE_GET_SESSION_AUDIT_LOG_DETAIL_CHANNEL,
    WITHMATE_GET_SESSION_AUDIT_LOG_DETAIL_SECTION_CHANNEL,
    WITHMATE_GET_SESSION_AUDIT_LOG_OPERATION_DETAIL_CHANNEL,
    WITHMATE_LIST_COMPANION_AUDIT_LOGS_CHANNEL,
    WITHMATE_LIST_COMPANION_AUDIT_LOG_SUMMARIES_CHANNEL,
    WITHMATE_LIST_COMPANION_AUDIT_LOG_SUMMARY_PAGE_CHANNEL,
    WITHMATE_GET_COMPANION_AUDIT_LOG_DETAIL_CHANNEL,
    WITHMATE_GET_COMPANION_AUDIT_LOG_DETAIL_SECTION_CHANNEL,
    WITHMATE_GET_COMPANION_AUDIT_LOG_OPERATION_DETAIL_CHANNEL,
    WITHMATE_LIST_SESSION_SKILLS_CHANNEL,
    WITHMATE_LIST_SESSION_CUSTOM_AGENTS_CHANNEL,
    WITHMATE_LIST_WORKSPACE_SKILLS_CHANNEL,
    WITHMATE_LIST_WORKSPACE_CUSTOM_AGENTS_CHANNEL,
    WITHMATE_LIST_OPEN_COMPANION_REVIEW_WINDOW_IDS_CHANNEL,
    WITHMATE_LIST_OPEN_SESSION_WINDOW_IDS_CHANNEL,
    WITHMATE_LIST_COMPANION_SESSION_SUMMARIES_CHANNEL,
    WITHMATE_GET_SESSION_CHANNEL,
    WITHMATE_GET_SESSION_MESSAGE_ARTIFACT_CHANNEL,
    WITHMATE_GET_DIFF_PREVIEW_CHANNEL,
    WITHMATE_PREVIEW_COMPOSER_INPUT_CHANNEL,
    WITHMATE_SEARCH_WORKSPACE_FILES_CHANNEL,
    WITHMATE_GET_LIVE_SESSION_RUN_CHANNEL,
    WITHMATE_GET_PROVIDER_QUOTA_TELEMETRY_CHANNEL,
    WITHMATE_GET_SESSION_CONTEXT_TELEMETRY_CHANNEL,
    WITHMATE_GET_SESSION_BACKGROUND_ACTIVITY_CHANNEL,
    WITHMATE_RESOLVE_LIVE_APPROVAL_CHANNEL,
    WITHMATE_RESOLVE_LIVE_ELICITATION_CHANNEL,
    WITHMATE_CREATE_SESSION_CHANNEL,
    WITHMATE_CREATE_COMPANION_SESSION_CHANNEL,
    WITHMATE_GET_COMPANION_SESSION_CHANNEL,
    WITHMATE_GET_COMPANION_MESSAGE_ARTIFACT_CHANNEL,
    WITHMATE_GET_COMPANION_REVIEW_SNAPSHOT_CHANNEL,
    WITHMATE_MERGE_COMPANION_SELECTED_FILES_CHANNEL,
    WITHMATE_SYNC_COMPANION_TARGET_CHANNEL,
    WITHMATE_STASH_COMPANION_TARGET_CHANGES_CHANNEL,
    WITHMATE_RESTORE_COMPANION_TARGET_STASH_CHANNEL,
    WITHMATE_DROP_COMPANION_TARGET_STASH_CHANNEL,
    WITHMATE_DISCARD_COMPANION_SESSION_CHANNEL,
    WITHMATE_UPDATE_COMPANION_SESSION_CHANNEL,
    WITHMATE_PREVIEW_COMPANION_COMPOSER_INPUT_CHANNEL,
    WITHMATE_SEARCH_COMPANION_WORKSPACE_FILES_CHANNEL,
    WITHMATE_RUN_COMPANION_SESSION_TURN_CHANNEL,
    WITHMATE_CANCEL_COMPANION_SESSION_RUN_CHANNEL,
    WITHMATE_UPDATE_SESSION_CHANNEL,
    WITHMATE_DELETE_SESSION_CHANNEL,
    WITHMATE_RUN_SESSION_TURN_CHANNEL,
    WITHMATE_CANCEL_SESSION_RUN_CHANNEL,
    WITHMATE_CORRECT_MATE_GROWTH_EVENT_CHANNEL,
    WITHMATE_GET_MATE_GROWTH_SETTINGS_CHANNEL,
    WITHMATE_UPDATE_MATE_GROWTH_SETTINGS_CHANNEL,
    WITHMATE_GET_MATE_EMBEDDING_SETTINGS_CHANNEL,
    WITHMATE_GET_MATE_STATE_CHANNEL,
    WITHMATE_GET_MATE_PROFILE_CHANNEL,
    WITHMATE_CREATE_MATE_CHANNEL,
    WITHMATE_UPDATE_MATE_CHANNEL,
    WITHMATE_SET_MATE_AVATAR_CHANNEL,
    WITHMATE_APPLY_MATE_GROWTH_CHANNEL,
    WITHMATE_LIST_MATE_GROWTH_EVENTS_CHANNEL,
    WITHMATE_DISABLE_MATE_GROWTH_EVENT_CHANNEL,
    WITHMATE_FORGET_MATE_GROWTH_EVENT_CHANNEL,
    WITHMATE_RUN_MATE_TALK_TURN_CHANNEL,
    WITHMATE_RESET_MATE_CHANNEL,
    WITHMATE_START_MATE_EMBEDDING_DOWNLOAD_CHANNEL,
  ];

  assert.deepEqual([...handlers.keys()].sort(), [...expectedChannels].sort());
});

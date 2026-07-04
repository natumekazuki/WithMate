import type { IpcRenderer } from "electron";

import type { RendererLogInput } from "../src/app-log-types.js";
import type {
  WithMateWindowApi,
  WithMateWindowCatalogApi,
  WithMateWindowCharacterApi,
  WithMateWindowCompanionApi,
  WithMateWindowNavigationApi,
  WithMateWindowObservabilityApi,
  WithMateWindowAuxiliaryApi,
  WithMateWindowPickerApi,
  WithMateWindowSessionApi,
  WithMateWindowSettingsApi,
  WithMateWindowMateApi,
  WithMateWindowSubscriptionApi,
} from "../src/withmate-window-api.js";
import {
  WITHMATE_APP_SETTINGS_CHANGED_EVENT,
  WITHMATE_APP_BOOT_STATUS_EVENT,
  WITHMATE_CANCEL_SESSION_RUN_CHANNEL,
  WITHMATE_CANCEL_COMPANION_SESSION_RUN_CHANNEL,
  WITHMATE_ARCHIVE_CHARACTER_CHANNEL,
  WITHMATE_CREATE_MATE_CHANNEL,
  WITHMATE_CREATE_CHARACTER_CHANNEL,
  WITHMATE_CREATE_COMPANION_SESSION_CHANNEL,
  WITHMATE_CREATE_SESSION_CHANNEL,
  WITHMATE_DELETE_SESSION_CHANNEL,
  WITHMATE_DELETE_SESSIONS_LAST_ACTIVE_BEFORE_CHANNEL,
  WITHMATE_DISCARD_COMPANION_SESSION_CHANNEL,
  WITHMATE_CANCEL_AUXILIARY_SESSION_RUN_CHANNEL,
  WITHMATE_CLOSE_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_EXPORT_MODEL_CATALOG_CHANNEL,
  WITHMATE_EXPORT_MODEL_CATALOG_FILE_CHANNEL,
  WITHMATE_GET_APP_DATABASE_DIAGNOSTICS_CHANNEL,
  WITHMATE_GET_APP_BOOT_STATUS_CHANNEL,
  WITHMATE_GET_APP_SETTINGS_CHANNEL,
  WITHMATE_GET_MEMORY_V6_DIAGNOSTICS_CHANNEL,
  WITHMATE_INSTALL_MEMORY_V6_CLI_SHIM_CHANNEL,
  WITHMATE_GET_ACTIVE_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_GET_CHARACTER_CHANNEL,
  WITHMATE_GET_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_CREATE_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_UPDATE_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_LIST_AUXILIARY_SESSIONS_CHANNEL,
  WITHMATE_LIST_CHARACTERS_CHANNEL,
  WITHMATE_GET_COMPANION_AUDIT_LOG_DETAIL_CHANNEL,
  WITHMATE_GET_COMPANION_AUDIT_LOG_DETAIL_SECTION_CHANNEL,
  WITHMATE_GET_COMPANION_AUDIT_LOG_OPERATION_DETAIL_CHANNEL,
  WITHMATE_GET_COMPANION_MESSAGE_ARTIFACT_CHANNEL,
  WITHMATE_GET_COMPANION_REVIEW_SNAPSHOT_CHANNEL,
  WITHMATE_GET_COMPANION_SESSION_CHANNEL,
  WITHMATE_GET_DIFF_PREVIEW_CHANNEL,
  WITHMATE_GET_LIVE_SESSION_RUN_CHANNEL,
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
  WITHMATE_LIVE_SESSION_RUN_EVENT,
  WITHMATE_MODEL_CATALOG_CHANGED_EVENT,
  WITHMATE_OPEN_DIFF_WINDOW_CHANNEL,
  WITHMATE_OPEN_COMPANION_MERGE_WINDOW_CHANNEL,
  WITHMATE_OPEN_COMPANION_REVIEW_WINDOW_CHANNEL,
  WITHMATE_OPEN_CHARACTER_EDITOR_WINDOW_CHANNEL,
  WITHMATE_OPEN_HOME_WINDOW_CHANNEL,
  WITHMATE_OPEN_APP_LOG_FOLDER_CHANNEL,
  WITHMATE_OPEN_CRASH_DUMP_FOLDER_CHANNEL,
  WITHMATE_OPEN_PATH_CHANNEL,
  WITHMATE_OPEN_SESSION_CHANNEL,
  WITHMATE_OPEN_SESSION_FILES_DIRECTORY_CHANNEL,
  WITHMATE_OPEN_SESSION_FILES_TERMINAL_CHANNEL,
  WITHMATE_OPEN_SESSION_MONITOR_WINDOW_CHANNEL,
  WITHMATE_OPEN_SESSION_TERMINAL_CHANNEL,
  WITHMATE_OPEN_SESSION_WINDOWS_CHANGED_EVENT,
  WITHMATE_OPEN_COMPANION_REVIEW_WINDOWS_CHANGED_EVENT,
  WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL,
  WITHMATE_OPEN_MEMORY_V6_REVIEW_WINDOW_CHANNEL,
  WITHMATE_OPEN_TERMINAL_AT_PATH_CHANNEL,
  WITHMATE_PICK_DIRECTORY_CHANNEL,
  WITHMATE_PICK_FILE_CHANNEL,
  WITHMATE_PICK_FILES_CHANNEL,
  WITHMATE_PICK_SESSION_FILES_CHANNEL,
  WITHMATE_PICK_SESSION_FOLDER_CHANNEL,
  WITHMATE_PICK_SESSION_IMAGE_FILE_CHANNEL,
  WITHMATE_PICK_IMAGE_FILE_CHANNEL,
  WITHMATE_COPY_FILES_TO_SESSION_FILES_CHANNEL,
  WITHMATE_PREVIEW_COMPANION_COMPOSER_INPUT_CHANNEL,
  WITHMATE_PREVIEW_COMPOSER_INPUT_CHANNEL,
  WITHMATE_PROVIDER_QUOTA_TELEMETRY_EVENT,
  WITHMATE_MERGE_COMPANION_SELECTED_FILES_CHANNEL,
  WITHMATE_RESET_APP_DATABASE_CHANNEL,
  WITHMATE_RESET_MATE_CHANNEL,
  WITHMATE_RESOLVE_LAUNCH_CHARACTER_CHANNEL,
  WITHMATE_SET_MATE_AVATAR_CHANNEL,
  WITHMATE_SET_DEFAULT_CHARACTER_CHANNEL,
  WITHMATE_SAVE_PASTED_SESSION_FILE_CHANNEL,
  WITHMATE_RUN_AUXILIARY_SESSION_TURN_CHANNEL,
  WITHMATE_RESOLVE_LIVE_APPROVAL_CHANNEL,
  WITHMATE_RESOLVE_LIVE_ELICITATION_CHANNEL,
  WITHMATE_RUN_SESSION_TURN_CHANNEL,
  WITHMATE_RUN_COMPANION_SESSION_TURN_CHANNEL,
  WITHMATE_SESSIONS_CHANGED_EVENT,
  WITHMATE_SYNC_COMPANION_TARGET_CHANNEL,
  WITHMATE_STASH_COMPANION_TARGET_CHANGES_CHANNEL,
  WITHMATE_RESTORE_COMPANION_TARGET_STASH_CHANNEL,
  WITHMATE_DROP_COMPANION_TARGET_STASH_CHANNEL,
  WITHMATE_SESSIONS_INVALIDATED_EVENT,
  WITHMATE_START_CHARACTER_AUTHORING_SESSION_CHANNEL,
  WITHMATE_COMPANION_SESSIONS_CHANGED_EVENT,
  WITHMATE_RENDERER_LOG_CHANNEL,
  WITHMATE_SESSION_BACKGROUND_ACTIVITY_EVENT,
  WITHMATE_SESSION_CONTEXT_TELEMETRY_EVENT,
  WITHMATE_UPDATE_APP_SETTINGS_CHANNEL,
  WITHMATE_UNINSTALL_MEMORY_V6_CLI_SHIM_CHANNEL,
  WITHMATE_UPDATE_CHARACTER_METADATA_CHANNEL,
  WITHMATE_UPDATE_CHARACTER_DEFINITION_CHANNEL,
  WITHMATE_UPDATE_MATE_CHANNEL,
  WITHMATE_UPDATE_COMPANION_SESSION_CHANNEL,
  WITHMATE_UPDATE_SESSION_CHANNEL,
  WITHMATE_SEARCH_MEMORY_V6_ENTRIES_CHANNEL,
  WITHMATE_GET_MEMORY_V6_ENTRY_CHANNEL,
  WITHMATE_FORGET_MEMORY_V6_ENTRY_CHANNEL,
} from "../src/withmate-ipc-channels.js";

type IpcRendererLike = Pick<IpcRenderer, "invoke" | "on" | "removeListener" | "send">;
type ListenerDisposer = () => void;
type ModelCatalogChangedPayload = Awaited<ReturnType<WithMateWindowApi["getModelCatalog"]>>;
type LiveSessionRunPayload = {
  sessionId: string;
  state: Awaited<ReturnType<WithMateWindowApi["getLiveSessionRun"]>>;
};
type ProviderQuotaTelemetryPayload = {
  providerId: string;
  telemetry: Awaited<ReturnType<WithMateWindowApi["getProviderQuotaTelemetry"]>>;
};
type SessionContextTelemetryPayload = {
  sessionId: string;
  telemetry: Awaited<ReturnType<WithMateWindowApi["getSessionContextTelemetry"]>>;
};
type SessionBackgroundActivityPayload = {
  sessionId: string;
  kind: Parameters<WithMateWindowApi["getSessionBackgroundActivity"]>[1];
  state: Awaited<ReturnType<WithMateWindowApi["getSessionBackgroundActivity"]>>;
};
type PreloadErrorEvent = {
  message?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  error?: unknown;
};
type PreloadUnhandledRejectionEvent = {
  reason?: unknown;
};
type PreloadWindow = {
  location: {
    href: string;
  };
  addEventListener(type: "error", listener: (event: PreloadErrorEvent) => void): void;
  addEventListener(type: "unhandledrejection", listener: (event: PreloadUnhandledRejectionEvent) => void): void;
};

declare const window: PreloadWindow | undefined;

let rendererErrorLoggingInstalled = false;

function subscribe<EventArgs extends unknown[]>(
  ipcRenderer: IpcRendererLike,
  channel: string,
  listener: (...args: EventArgs) => void,
): ListenerDisposer {
  const wrapped = (_event: unknown, ...args: EventArgs) => {
    listener(...args);
  };

  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

function createWindowApi(ipcRenderer: IpcRendererLike): WithMateWindowNavigationApi {
  return {
    openSession(sessionId) {
      return ipcRenderer.invoke(WITHMATE_OPEN_SESSION_CHANNEL, sessionId);
    },
    openHomeWindow() {
      return ipcRenderer.invoke(WITHMATE_OPEN_HOME_WINDOW_CHANNEL);
    },
    openSessionMonitorWindow() {
      return ipcRenderer.invoke(WITHMATE_OPEN_SESSION_MONITOR_WINDOW_CHANNEL);
    },
    openSettingsWindow() {
      return ipcRenderer.invoke(WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL);
    },
    openMemoryV6ReviewWindow() {
      return ipcRenderer.invoke(WITHMATE_OPEN_MEMORY_V6_REVIEW_WINDOW_CHANNEL);
    },
    openCharacterEditorWindow(characterId) {
      return ipcRenderer.invoke(WITHMATE_OPEN_CHARACTER_EDITOR_WINDOW_CHANNEL, characterId ?? null);
    },
    openDiffWindow(diffPreview) {
      return ipcRenderer.invoke(WITHMATE_OPEN_DIFF_WINDOW_CHANNEL, diffPreview);
    },
    openCompanionReviewWindow(sessionId) {
      return ipcRenderer.invoke(WITHMATE_OPEN_COMPANION_REVIEW_WINDOW_CHANNEL, sessionId);
    },
    openCompanionMergeWindow(sessionId) {
      return ipcRenderer.invoke(WITHMATE_OPEN_COMPANION_MERGE_WINDOW_CHANNEL, sessionId);
    },
    openPath(target, options) {
      return ipcRenderer.invoke(WITHMATE_OPEN_PATH_CHANNEL, target, options ?? null);
    },
    openAppLogFolder() {
      return ipcRenderer.invoke(WITHMATE_OPEN_APP_LOG_FOLDER_CHANNEL);
    },
    openCrashDumpFolder() {
      return ipcRenderer.invoke(WITHMATE_OPEN_CRASH_DUMP_FOLDER_CHANNEL);
    },
    openSessionTerminal(sessionId) {
      return ipcRenderer.invoke(WITHMATE_OPEN_SESSION_TERMINAL_CHANNEL, sessionId);
    },
    openTerminalAtPath(target) {
      return ipcRenderer.invoke(WITHMATE_OPEN_TERMINAL_AT_PATH_CHANNEL, target);
    },
  };
}

function createCatalogApi(ipcRenderer: IpcRendererLike): WithMateWindowCatalogApi {
  return {
    getModelCatalog(revision) {
      return ipcRenderer.invoke(WITHMATE_GET_MODEL_CATALOG_CHANNEL, revision ?? null);
    },
    importModelCatalog(document) {
      return ipcRenderer.invoke(WITHMATE_IMPORT_MODEL_CATALOG_CHANNEL, document);
    },
    exportModelCatalog(revision) {
      return ipcRenderer.invoke(WITHMATE_EXPORT_MODEL_CATALOG_CHANNEL, revision ?? null);
    },
    importModelCatalogFile() {
      return ipcRenderer.invoke(WITHMATE_IMPORT_MODEL_CATALOG_FILE_CHANNEL);
    },
    exportModelCatalogFile(revision) {
      return ipcRenderer.invoke(WITHMATE_EXPORT_MODEL_CATALOG_FILE_CHANNEL, revision ?? null);
    },
    getDiffPreview(token) {
      return ipcRenderer.invoke(WITHMATE_GET_DIFF_PREVIEW_CHANNEL, token);
    },
  };
}

function createSessionApi(ipcRenderer: IpcRendererLike): WithMateWindowSessionApi {
  return {
    listSessionSummaries() {
      return ipcRenderer.invoke(WITHMATE_LIST_SESSION_SUMMARIES_CHANNEL);
    },
    getSession(sessionId) {
      return ipcRenderer.invoke(WITHMATE_GET_SESSION_CHANNEL, sessionId);
    },
    getSessionMessageArtifact(sessionId, messageIndex) {
      return ipcRenderer.invoke(WITHMATE_GET_SESSION_MESSAGE_ARTIFACT_CHANNEL, sessionId, messageIndex);
    },
    createSession(input) {
      return ipcRenderer.invoke(WITHMATE_CREATE_SESSION_CHANNEL, input);
    },
    updateSession(session) {
      return ipcRenderer.invoke(WITHMATE_UPDATE_SESSION_CHANNEL, session);
    },
    deleteSession(sessionId) {
      return ipcRenderer.invoke(WITHMATE_DELETE_SESSION_CHANNEL, sessionId);
    },
    previewComposerInput(sessionId, userMessage) {
      return ipcRenderer.invoke(WITHMATE_PREVIEW_COMPOSER_INPUT_CHANNEL, sessionId, userMessage);
    },
    listSessionSkills(sessionId) {
      return ipcRenderer.invoke(WITHMATE_LIST_SESSION_SKILLS_CHANNEL, sessionId);
    },
    listSessionCustomAgents(sessionId) {
      return ipcRenderer.invoke(WITHMATE_LIST_SESSION_CUSTOM_AGENTS_CHANNEL, sessionId);
    },
    listWorkspaceSkills(providerId, workspacePath) {
      return ipcRenderer.invoke(WITHMATE_LIST_WORKSPACE_SKILLS_CHANNEL, providerId, workspacePath);
    },
    listWorkspaceCustomAgents(providerId, workspacePath) {
      return ipcRenderer.invoke(WITHMATE_LIST_WORKSPACE_CUSTOM_AGENTS_CHANNEL, providerId, workspacePath);
    },
    runSessionTurn(sessionId, request) {
      return ipcRenderer.invoke(WITHMATE_RUN_SESSION_TURN_CHANNEL, sessionId, request);
    },
    cancelSessionRun(sessionId) {
      return ipcRenderer.invoke(WITHMATE_CANCEL_SESSION_RUN_CHANNEL, sessionId);
    },
    listSessionAuditLogs(sessionId) {
      return ipcRenderer.invoke(WITHMATE_LIST_SESSION_AUDIT_LOGS_CHANNEL, sessionId);
    },
    listSessionAuditLogSummaries(sessionId) {
      return ipcRenderer.invoke(WITHMATE_LIST_SESSION_AUDIT_LOG_SUMMARIES_CHANNEL, sessionId);
    },
    listSessionAuditLogSummaryPage(sessionId, request) {
      return ipcRenderer.invoke(WITHMATE_LIST_SESSION_AUDIT_LOG_SUMMARY_PAGE_CHANNEL, sessionId, request ?? null);
    },
    getSessionAuditLogDetail(sessionId, auditLogId) {
      return ipcRenderer.invoke(WITHMATE_GET_SESSION_AUDIT_LOG_DETAIL_CHANNEL, sessionId, auditLogId);
    },
    getSessionAuditLogDetailSection(sessionId, auditLogId, section) {
      return ipcRenderer.invoke(WITHMATE_GET_SESSION_AUDIT_LOG_DETAIL_SECTION_CHANNEL, sessionId, auditLogId, section);
    },
    getSessionAuditLogOperationDetail(sessionId, auditLogId, operationIndex) {
      return ipcRenderer.invoke(WITHMATE_GET_SESSION_AUDIT_LOG_OPERATION_DETAIL_CHANNEL, sessionId, auditLogId, operationIndex);
    },
    getLiveSessionRun(sessionId) {
      return ipcRenderer.invoke(WITHMATE_GET_LIVE_SESSION_RUN_CHANNEL, sessionId);
    },
    resolveLiveApproval(sessionId, requestId, decision) {
      return ipcRenderer.invoke(WITHMATE_RESOLVE_LIVE_APPROVAL_CHANNEL, sessionId, requestId, decision);
    },
    resolveLiveElicitation(sessionId, requestId, response) {
      return ipcRenderer.invoke(WITHMATE_RESOLVE_LIVE_ELICITATION_CHANNEL, sessionId, requestId, response);
    },
  };
}

function createAuxiliaryApi(ipcRenderer: IpcRendererLike): WithMateWindowAuxiliaryApi {
  return {
    listAuxiliarySessions(parentSessionId) {
      return ipcRenderer.invoke(WITHMATE_LIST_AUXILIARY_SESSIONS_CHANNEL, parentSessionId);
    },
    getActiveAuxiliarySession(parentSessionId) {
      return ipcRenderer.invoke(WITHMATE_GET_ACTIVE_AUXILIARY_SESSION_CHANNEL, parentSessionId);
    },
    getAuxiliarySession(auxiliarySessionId) {
      return ipcRenderer.invoke(WITHMATE_GET_AUXILIARY_SESSION_CHANNEL, auxiliarySessionId);
    },
    createAuxiliarySession(input) {
      return ipcRenderer.invoke(WITHMATE_CREATE_AUXILIARY_SESSION_CHANNEL, input);
    },
    updateAuxiliarySession(session) {
      return ipcRenderer.invoke(WITHMATE_UPDATE_AUXILIARY_SESSION_CHANNEL, session);
    },
    closeAuxiliarySession(auxiliarySessionId) {
      return ipcRenderer.invoke(WITHMATE_CLOSE_AUXILIARY_SESSION_CHANNEL, auxiliarySessionId);
    },
    runAuxiliarySessionTurn(auxiliarySessionId, request) {
      return ipcRenderer.invoke(WITHMATE_RUN_AUXILIARY_SESSION_TURN_CHANNEL, auxiliarySessionId, request);
    },
    cancelAuxiliarySessionRun(auxiliarySessionId) {
      return ipcRenderer.invoke(WITHMATE_CANCEL_AUXILIARY_SESSION_RUN_CHANNEL, auxiliarySessionId);
    },
  };
}

function createCompanionApi(ipcRenderer: IpcRendererLike): WithMateWindowCompanionApi {
  return {
    listCompanionSessionSummaries() {
      return ipcRenderer.invoke(WITHMATE_LIST_COMPANION_SESSION_SUMMARIES_CHANNEL);
    },
    getCompanionSession(sessionId) {
      return ipcRenderer.invoke(WITHMATE_GET_COMPANION_SESSION_CHANNEL, sessionId);
    },
    getCompanionMessageArtifact(sessionId, messageIndex) {
      return ipcRenderer.invoke(WITHMATE_GET_COMPANION_MESSAGE_ARTIFACT_CHANNEL, sessionId, messageIndex);
    },
    getCompanionReviewSnapshot(sessionId) {
      return ipcRenderer.invoke(WITHMATE_GET_COMPANION_REVIEW_SNAPSHOT_CHANNEL, sessionId);
    },
    mergeCompanionSelectedFiles(request) {
      return ipcRenderer.invoke(WITHMATE_MERGE_COMPANION_SELECTED_FILES_CHANNEL, request);
    },
    syncCompanionTarget(sessionId) {
      return ipcRenderer.invoke(WITHMATE_SYNC_COMPANION_TARGET_CHANNEL, sessionId);
    },
    stashCompanionTargetChanges(sessionId) {
      return ipcRenderer.invoke(WITHMATE_STASH_COMPANION_TARGET_CHANGES_CHANNEL, sessionId);
    },
    restoreCompanionTargetStash(sessionId) {
      return ipcRenderer.invoke(WITHMATE_RESTORE_COMPANION_TARGET_STASH_CHANNEL, sessionId);
    },
    dropCompanionTargetStash(sessionId) {
      return ipcRenderer.invoke(WITHMATE_DROP_COMPANION_TARGET_STASH_CHANNEL, sessionId);
    },
    discardCompanionSession(sessionId) {
      return ipcRenderer.invoke(WITHMATE_DISCARD_COMPANION_SESSION_CHANNEL, sessionId);
    },
    createCompanionSession(input) {
      return ipcRenderer.invoke(WITHMATE_CREATE_COMPANION_SESSION_CHANNEL, input);
    },
    updateCompanionSession(session) {
      return ipcRenderer.invoke(WITHMATE_UPDATE_COMPANION_SESSION_CHANNEL, session);
    },
    previewCompanionComposerInput(sessionId, userMessage) {
      return ipcRenderer.invoke(WITHMATE_PREVIEW_COMPANION_COMPOSER_INPUT_CHANNEL, sessionId, userMessage);
    },
    runCompanionSessionTurn(sessionId, request) {
      return ipcRenderer.invoke(WITHMATE_RUN_COMPANION_SESSION_TURN_CHANNEL, sessionId, request);
    },
    cancelCompanionSessionRun(sessionId) {
      return ipcRenderer.invoke(WITHMATE_CANCEL_COMPANION_SESSION_RUN_CHANNEL, sessionId);
    },
    listCompanionAuditLogs(sessionId) {
      return ipcRenderer.invoke(WITHMATE_LIST_COMPANION_AUDIT_LOGS_CHANNEL, sessionId);
    },
    listCompanionAuditLogSummaries(sessionId) {
      return ipcRenderer.invoke(WITHMATE_LIST_COMPANION_AUDIT_LOG_SUMMARIES_CHANNEL, sessionId);
    },
    listCompanionAuditLogSummaryPage(sessionId, request) {
      return ipcRenderer.invoke(WITHMATE_LIST_COMPANION_AUDIT_LOG_SUMMARY_PAGE_CHANNEL, sessionId, request ?? null);
    },
    getCompanionAuditLogDetail(sessionId, auditLogId) {
      return ipcRenderer.invoke(WITHMATE_GET_COMPANION_AUDIT_LOG_DETAIL_CHANNEL, sessionId, auditLogId);
    },
    getCompanionAuditLogDetailSection(sessionId, auditLogId, section) {
      return ipcRenderer.invoke(WITHMATE_GET_COMPANION_AUDIT_LOG_DETAIL_SECTION_CHANNEL, sessionId, auditLogId, section);
    },
    getCompanionAuditLogOperationDetail(sessionId, auditLogId, operationIndex) {
      return ipcRenderer.invoke(WITHMATE_GET_COMPANION_AUDIT_LOG_OPERATION_DETAIL_CHANNEL, sessionId, auditLogId, operationIndex);
    },
  };
}

function createObservabilityApi(ipcRenderer: IpcRendererLike): Pick<
  WithMateWindowObservabilityApi,
  | "reportRendererLog"
  | "getProviderQuotaTelemetry"
  | "getSessionContextTelemetry"
  | "getSessionBackgroundActivity"
  | "listOpenSessionWindowIds"
  | "listOpenCompanionReviewWindowIds"
> {
  return {
    reportRendererLog(input) {
      reportRendererLog(ipcRenderer, input);
    },
    getProviderQuotaTelemetry(providerId) {
      return ipcRenderer.invoke(WITHMATE_GET_PROVIDER_QUOTA_TELEMETRY_CHANNEL, providerId);
    },
    getSessionContextTelemetry(sessionId) {
      return ipcRenderer.invoke(WITHMATE_GET_SESSION_CONTEXT_TELEMETRY_CHANNEL, sessionId);
    },
    getSessionBackgroundActivity(sessionId, kind) {
      return ipcRenderer.invoke(WITHMATE_GET_SESSION_BACKGROUND_ACTIVITY_CHANNEL, sessionId, kind);
    },
    listOpenSessionWindowIds() {
      return ipcRenderer.invoke(WITHMATE_LIST_OPEN_SESSION_WINDOW_IDS_CHANNEL);
    },
    listOpenCompanionReviewWindowIds() {
      return ipcRenderer.invoke(WITHMATE_LIST_OPEN_COMPANION_REVIEW_WINDOW_IDS_CHANNEL);
    },
  };
}

function createMateApi(ipcRenderer: IpcRendererLike): WithMateWindowMateApi {
  return {
    getMateState() {
      return ipcRenderer.invoke(WITHMATE_GET_MATE_STATE_CHANNEL);
    },
    getMateProfile() {
      return ipcRenderer.invoke(WITHMATE_GET_MATE_PROFILE_CHANNEL);
    },
    createMate(input) {
      return ipcRenderer.invoke(WITHMATE_CREATE_MATE_CHANNEL, input);
    },
    updateMate(input) {
      return ipcRenderer.invoke(WITHMATE_UPDATE_MATE_CHANNEL, input);
    },
    setMateAvatar(input) {
      return ipcRenderer.invoke(WITHMATE_SET_MATE_AVATAR_CHANNEL, input);
    },
    resetMate() {
      return ipcRenderer.invoke(WITHMATE_RESET_MATE_CHANNEL);
    },
  };
}

function createCharacterApi(ipcRenderer: IpcRendererLike): WithMateWindowCharacterApi {
  return {
    listCharacters(options) {
      return ipcRenderer.invoke(WITHMATE_LIST_CHARACTERS_CHANNEL, options ?? null);
    },
    getCharacter(characterId) {
      return ipcRenderer.invoke(WITHMATE_GET_CHARACTER_CHANNEL, characterId);
    },
    createCharacter(input) {
      return ipcRenderer.invoke(WITHMATE_CREATE_CHARACTER_CHANNEL, input);
    },
    updateCharacterMetadata(input) {
      return ipcRenderer.invoke(WITHMATE_UPDATE_CHARACTER_METADATA_CHANNEL, input);
    },
    updateCharacterDefinition(input) {
      return ipcRenderer.invoke(WITHMATE_UPDATE_CHARACTER_DEFINITION_CHANNEL, input);
    },
    archiveCharacter(characterId) {
      return ipcRenderer.invoke(WITHMATE_ARCHIVE_CHARACTER_CHANNEL, characterId);
    },
    setDefaultCharacter(characterId) {
      return ipcRenderer.invoke(WITHMATE_SET_DEFAULT_CHARACTER_CHANNEL, characterId);
    },
    resolveLaunchCharacter(input) {
      return ipcRenderer.invoke(WITHMATE_RESOLVE_LAUNCH_CHARACTER_CHANNEL, input ?? null);
    },
    startCharacterAuthoringSession(input) {
      return ipcRenderer.invoke(WITHMATE_START_CHARACTER_AUTHORING_SESSION_CHANNEL, input);
    },
  };
}

function createSettingsApi(ipcRenderer: IpcRendererLike): WithMateWindowSettingsApi {
  return {
    getAppSettings() {
      return ipcRenderer.invoke(WITHMATE_GET_APP_SETTINGS_CHANNEL);
    },
    updateAppSettings(settings) {
      return ipcRenderer.invoke(WITHMATE_UPDATE_APP_SETTINGS_CHANNEL, settings);
    },
    getAppDatabaseDiagnostics() {
      return ipcRenderer.invoke(WITHMATE_GET_APP_DATABASE_DIAGNOSTICS_CHANNEL);
    },
    getMemoryV6Diagnostics() {
      return ipcRenderer.invoke(WITHMATE_GET_MEMORY_V6_DIAGNOSTICS_CHANNEL);
    },
    installMemoryV6CliShim() {
      return ipcRenderer.invoke(WITHMATE_INSTALL_MEMORY_V6_CLI_SHIM_CHANNEL);
    },
    uninstallMemoryV6CliShim() {
      return ipcRenderer.invoke(WITHMATE_UNINSTALL_MEMORY_V6_CLI_SHIM_CHANNEL);
    },
    resetAppDatabase(request) {
      return ipcRenderer.invoke(WITHMATE_RESET_APP_DATABASE_CHANNEL, request);
    },
    deleteSessionsLastActiveBefore(request) {
      return ipcRenderer.invoke(WITHMATE_DELETE_SESSIONS_LAST_ACTIVE_BEFORE_CHANNEL, request);
    },
  };
}

function createMemoryV6ReviewApi(ipcRenderer: IpcRendererLike): Pick<
  WithMateWindowApi,
  "searchMemoryV6Entries" | "getMemoryV6Entry" | "forgetMemoryV6Entry"
> {
  return {
    searchMemoryV6Entries(request) {
      return ipcRenderer.invoke(WITHMATE_SEARCH_MEMORY_V6_ENTRIES_CHANNEL, request);
    },
    getMemoryV6Entry(entryId) {
      return ipcRenderer.invoke(WITHMATE_GET_MEMORY_V6_ENTRY_CHANNEL, entryId);
    },
    forgetMemoryV6Entry(entryId, reason) {
      return ipcRenderer.invoke(WITHMATE_FORGET_MEMORY_V6_ENTRY_CHANNEL, entryId, reason ?? "user_request");
    },
  };
}

function createPickerApi(ipcRenderer: IpcRendererLike): WithMateWindowPickerApi {
  return {
    pickDirectory(initialPath) {
      return ipcRenderer.invoke(WITHMATE_PICK_DIRECTORY_CHANNEL, initialPath ?? null);
    },
    pickFile(initialPath) {
      return ipcRenderer.invoke(WITHMATE_PICK_FILE_CHANNEL, initialPath ?? null);
    },
    pickFiles(initialPath) {
      return ipcRenderer.invoke(WITHMATE_PICK_FILES_CHANNEL, initialPath ?? null);
    },
    pickSessionFiles(sessionId) {
      return ipcRenderer.invoke(WITHMATE_PICK_SESSION_FILES_CHANNEL, sessionId);
    },
    pickSessionFolder(sessionId) {
      return ipcRenderer.invoke(WITHMATE_PICK_SESSION_FOLDER_CHANNEL, sessionId);
    },
    pickSessionImageFile(sessionId) {
      return ipcRenderer.invoke(WITHMATE_PICK_SESSION_IMAGE_FILE_CHANNEL, sessionId);
    },
    pickImageFile(initialPath) {
      return ipcRenderer.invoke(WITHMATE_PICK_IMAGE_FILE_CHANNEL, initialPath ?? null);
    },
    copyFilesToSessionFiles(sessionId, sourcePaths) {
      return ipcRenderer.invoke(WITHMATE_COPY_FILES_TO_SESSION_FILES_CHANNEL, sessionId, sourcePaths);
    },
    savePastedSessionFile(request) {
      return ipcRenderer.invoke(WITHMATE_SAVE_PASTED_SESSION_FILE_CHANNEL, request);
    },
    openSessionFilesDirectory(sessionId) {
      return ipcRenderer.invoke(WITHMATE_OPEN_SESSION_FILES_DIRECTORY_CHANNEL, sessionId);
    },
    openSessionFilesTerminal(sessionId) {
      return ipcRenderer.invoke(WITHMATE_OPEN_SESSION_FILES_TERMINAL_CHANNEL, sessionId);
    },
  };
}

function createSubscriptionApi(ipcRenderer: IpcRendererLike): WithMateWindowSubscriptionApi {
  return {
    getAppBootStatus() {
      return ipcRenderer.invoke(WITHMATE_GET_APP_BOOT_STATUS_CHANNEL);
    },
    subscribeAppBootStatus(listener) {
      return subscribe(ipcRenderer, WITHMATE_APP_BOOT_STATUS_EVENT, listener);
    },
    subscribeSessionSummaries(listener) {
      return subscribe(ipcRenderer, WITHMATE_SESSIONS_CHANGED_EVENT, listener);
    },
    subscribeSessionInvalidation(listener) {
      return subscribe(ipcRenderer, WITHMATE_SESSIONS_INVALIDATED_EVENT, listener);
    },
    subscribeModelCatalog(listener) {
      return subscribe(ipcRenderer, WITHMATE_MODEL_CATALOG_CHANGED_EVENT, (catalog: ModelCatalogChangedPayload) => {
        if (catalog) {
          listener(catalog);
        }
      });
    },
    subscribeAppSettings(listener) {
      return subscribe(ipcRenderer, WITHMATE_APP_SETTINGS_CHANGED_EVENT, listener);
    },
    subscribeLiveSessionRun(listener) {
      return subscribe(ipcRenderer, WITHMATE_LIVE_SESSION_RUN_EVENT, (payload: LiveSessionRunPayload) => {
        listener(payload.sessionId, payload.state ?? null);
      });
    },
    subscribeProviderQuotaTelemetry(listener) {
      return subscribe(ipcRenderer, WITHMATE_PROVIDER_QUOTA_TELEMETRY_EVENT, (payload: ProviderQuotaTelemetryPayload) => {
        listener(payload.providerId, payload.telemetry ?? null);
      });
    },
    subscribeSessionContextTelemetry(listener) {
      return subscribe(ipcRenderer, WITHMATE_SESSION_CONTEXT_TELEMETRY_EVENT, (payload: SessionContextTelemetryPayload) => {
        listener(payload.sessionId, payload.telemetry ?? null);
      });
    },
    subscribeSessionBackgroundActivity(listener) {
      return subscribe(
        ipcRenderer,
        WITHMATE_SESSION_BACKGROUND_ACTIVITY_EVENT,
        (payload: SessionBackgroundActivityPayload) => {
        listener(payload.sessionId, payload.kind, payload.state ?? null);
        },
      );
    },
    subscribeOpenSessionWindowIds(listener) {
      return subscribe(ipcRenderer, WITHMATE_OPEN_SESSION_WINDOWS_CHANGED_EVENT, listener);
    },
    subscribeOpenCompanionReviewWindowIds(listener) {
      return subscribe(ipcRenderer, WITHMATE_OPEN_COMPANION_REVIEW_WINDOWS_CHANGED_EVENT, listener);
    },
    subscribeCompanionSessionSummaries(listener) {
      return subscribe(ipcRenderer, WITHMATE_COMPANION_SESSIONS_CHANGED_EVENT, listener);
    },
  };
}

function reportRendererLog(ipcRenderer: IpcRendererLike, input: RendererLogInput): void {
  ipcRenderer.send(WITHMATE_RENDERER_LOG_CHANNEL, input);
}

function installRendererErrorLogging(ipcRenderer: IpcRendererLike): void {
  if (rendererErrorLoggingInstalled || typeof window === "undefined") {
    return;
  }

  rendererErrorLoggingInstalled = true;
  window.addEventListener("error", (event) => {
    reportRendererLog(ipcRenderer, {
      level: "error",
      kind: "renderer.error",
      message: event.message || "Renderer error",
      url: window.location.href,
      data: {
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
      },
      error: event.error instanceof Error
        ? {
          name: event.error.name,
          message: event.error.message,
          stack: event.error.stack,
        }
        : {
          message: event.message || "Renderer error",
        },
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    reportRendererLog(ipcRenderer, {
      level: "error",
      kind: "renderer.unhandled-rejection",
      message: reason instanceof Error ? reason.message : "Renderer unhandled rejection",
      url: window.location.href,
      error: reason instanceof Error
        ? {
          name: reason.name,
          message: reason.message,
          stack: reason.stack,
        }
        : {
          message: typeof reason === "string" ? reason : "Renderer unhandled rejection",
        },
      data: reason instanceof Error ? undefined : { reason },
    });
  });
}

export function createWithMateWindowApi(ipcRenderer: IpcRendererLike): WithMateWindowApi {
  installRendererErrorLogging(ipcRenderer);
  return {
    ...createWindowApi(ipcRenderer),
    ...createMemoryV6ReviewApi(ipcRenderer),
    ...createCatalogApi(ipcRenderer),
    ...createSessionApi(ipcRenderer),
    ...createAuxiliaryApi(ipcRenderer),
    ...createCompanionApi(ipcRenderer),
    ...createObservabilityApi(ipcRenderer),
    ...createSettingsApi(ipcRenderer),
    ...createPickerApi(ipcRenderer),
    ...createSubscriptionApi(ipcRenderer),
    ...createMateApi(ipcRenderer),
    ...createCharacterApi(ipcRenderer),
  };
}

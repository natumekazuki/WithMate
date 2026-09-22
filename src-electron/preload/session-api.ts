import type { WithMateWindowSessionApi } from "../../src-shared/ipc/withmate-window-api.js";
import * as channels from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { IpcRendererLike } from "./ipc.js";

export function createSessionApi(
  ipcRenderer: IpcRendererLike,
  platform: NodeJS.Platform,
): WithMateWindowSessionApi {
  return {
    isSessionFileObjectCopyAvailable() {
      return platform === "win32";
    },
    listSessionSummaryPage(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_SESSION_SUMMARY_PAGE_CHANNEL,
        request ?? null,
      );
    },
    listSessionCharacterUsage() {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_SESSION_CHARACTER_USAGE_CHANNEL,
      );
    },
    getSession(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_SESSION_CHANNEL,
        sessionId,
      );
    },
    getSessionGlossaryProjection(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_SESSION_GLOSSARY_PROJECTION_CHANNEL,
        sessionId,
      );
    },
    searchSessionGlossary(sessionId, request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SEARCH_SESSION_GLOSSARY_CHANNEL,
        sessionId,
        request,
      );
    },
    validateSessionWorkspace(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_VALIDATE_SESSION_WORKSPACE_CHANNEL,
        sessionId,
      );
    },
    listSessionFileRoots(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_SESSION_FILE_ROOTS_CHANNEL,
        sessionId,
      );
    },
    listSessionDirectory(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_SESSION_DIRECTORY_CHANNEL,
        request,
      );
    },
    inspectSessionFile(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_INSPECT_SESSION_FILE_CHANNEL,
        request,
      );
    },
    readSessionFileChunk(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_READ_SESSION_FILE_CHUNK_CHANNEL,
        request,
      );
    },
    openSessionFile(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_OPEN_SESSION_FILE_CHANNEL,
        request,
      );
    },
    getSessionFilePreviewWindowPayload(token) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_SESSION_FILE_PREVIEW_WINDOW_PAYLOAD_CHANNEL,
        token,
      );
    },
    copySessionFilePreviewImage(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_COPY_SESSION_FILE_PREVIEW_IMAGE_CHANNEL,
        request,
      );
    },
    showSessionFilePreviewImageContextMenu(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SHOW_SESSION_FILE_PREVIEW_IMAGE_CONTEXT_MENU_CHANNEL,
        request,
      );
    },
    copySessionFileObject(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_COPY_SESSION_FILE_OBJECT_CHANNEL,
        request,
      );
    },
    showSessionFileObjectCopyContextMenu(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SHOW_SESSION_FILE_OBJECT_COPY_CONTEXT_MENU_CHANNEL,
        request,
      );
    },
    showSessionFileTreeContextMenu(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SHOW_SESSION_FILE_TREE_CONTEXT_MENU_CHANNEL,
        request,
      );
    },
    listFileRootChanges(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_FILE_ROOT_CHANGES_CHANNEL,
        request,
      );
    },
    listFileRootChangesRepositories(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_FILE_ROOT_CHANGES_REPOSITORIES_CHANNEL,
        request,
      );
    },
    getFileRootDiff(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_FILE_ROOT_DIFF_CHANNEL,
        request,
      );
    },
    listFileRootGitHistoryRepositories(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_FILE_ROOT_GIT_HISTORY_REPOSITORIES_CHANNEL,
        request,
      );
    },
    listFileRootGitHistoryCommits(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_FILE_ROOT_GIT_HISTORY_COMMITS_CHANNEL,
        request,
      );
    },
    getFileRootGitHistoryCommitDetail(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_FILE_ROOT_GIT_HISTORY_COMMIT_DETAIL_CHANNEL,
        request,
      );
    },
    getFileRootGitHistoryComparison(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_FILE_ROOT_GIT_HISTORY_COMPARISON_CHANNEL,
        request,
      );
    },
    getFileRootGitHistoryDiff(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_FILE_ROOT_GIT_HISTORY_DIFF_CHANNEL,
        request,
      );
    },
    getSessionMessageArtifact(sessionId, messageIndex) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_SESSION_MESSAGE_ARTIFACT_CHANNEL,
        sessionId,
        messageIndex,
      );
    },
    createSession(input) {
      return ipcRenderer.invoke(
        channels.WITHMATE_CREATE_SESSION_CHANNEL,
        input,
      );
    },
    updateSession(session) {
      return ipcRenderer.invoke(
        channels.WITHMATE_UPDATE_SESSION_CHANNEL,
        session,
      );
    },
    setSessionPinned(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SET_SESSION_PINNED_CHANNEL,
        request,
      );
    },
    deleteSession(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_DELETE_SESSION_CHANNEL,
        sessionId,
      );
    },
    previewComposerInput(sessionId, userMessage) {
      return ipcRenderer.invoke(
        channels.WITHMATE_PREVIEW_COMPOSER_INPUT_CHANNEL,
        sessionId,
        userMessage,
      );
    },
    listSessionSkills(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_SESSION_SKILLS_CHANNEL,
        sessionId,
      );
    },
    listSessionCustomAgents(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_SESSION_CUSTOM_AGENTS_CHANNEL,
        sessionId,
      );
    },
    listWorkspaceSkills(providerId, workspacePath) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_WORKSPACE_SKILLS_CHANNEL,
        providerId,
        workspacePath,
      );
    },
    listWorkspaceCustomAgents(providerId, workspacePath) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_WORKSPACE_CUSTOM_AGENTS_CHANNEL,
        providerId,
        workspacePath,
      );
    },
    runSessionTurn(sessionId, request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_RUN_SESSION_TURN_CHANNEL,
        sessionId,
        request,
      );
    },
    cancelSessionRun(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_CANCEL_SESSION_RUN_CHANNEL,
        sessionId,
      );
    },
    listSessionAuditLogs(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_SESSION_AUDIT_LOGS_CHANNEL,
        sessionId,
      );
    },
    listSessionAuditLogSummaries(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_SESSION_AUDIT_LOG_SUMMARIES_CHANNEL,
        sessionId,
      );
    },
    listSessionAuditLogSummaryPage(sessionId, request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_SESSION_AUDIT_LOG_SUMMARY_PAGE_CHANNEL,
        sessionId,
        request ?? null,
      );
    },
    getSessionAuditLogDetail(sessionId, auditLogId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_SESSION_AUDIT_LOG_DETAIL_CHANNEL,
        sessionId,
        auditLogId,
      );
    },
    getSessionAuditLogDetailSection(sessionId, auditLogId, section) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_SESSION_AUDIT_LOG_DETAIL_SECTION_CHANNEL,
        sessionId,
        auditLogId,
        section,
      );
    },
    getSessionAuditLogOperationDetail(sessionId, auditLogId, operationIndex) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_SESSION_AUDIT_LOG_OPERATION_DETAIL_CHANNEL,
        sessionId,
        auditLogId,
        operationIndex,
      );
    },
    getLiveSessionRun(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_LIVE_SESSION_RUN_CHANNEL,
        sessionId,
      );
    },
    resolveLiveApproval(sessionId, requestId, decision) {
      return ipcRenderer.invoke(
        channels.WITHMATE_RESOLVE_LIVE_APPROVAL_CHANNEL,
        sessionId,
        requestId,
        decision,
      );
    },
    resolveLiveElicitation(sessionId, requestId, response) {
      return ipcRenderer.invoke(
        channels.WITHMATE_RESOLVE_LIVE_ELICITATION_CHANNEL,
        sessionId,
        requestId,
        response,
      );
    },
  };
}

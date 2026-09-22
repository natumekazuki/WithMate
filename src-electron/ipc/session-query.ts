import type {
  AuditLogDetailSection,
  AuditLogSummaryPageRequest,
} from "../../src-shared/session/runtime-state.js";

import type { SessionSummaryPageRequest } from "../../src-shared/session/session-state.js";

import type {
  SessionDirectoryRequest,
  SessionFileChunkRequest,
  SessionFileOpenRequest,
  SessionFilePreviewWindowOpenRequest,
  SessionFilePreviewResourceRequest,
  FileRootChangesRequest,
  FileRootChangesRepositoriesRequest,
  FileRootFileDiffRequest,
  FileRootGitHistoryCommitDetailRequest,
  FileRootGitHistoryCommitsRequest,
  FileRootGitHistoryComparisonRequest,
  FileRootGitHistoryDiffRequest,
  FileRootGitHistoryRepositoriesRequest,
} from "../../src-shared/file-explorer/file-explorer-contract.js";

import type { GlossarySearchRequest } from "../../src-shared/glossary/glossary-contract.js";
import {
  areSessionFileResourcesEqual,
  isFileRootGitHistoryComparisonDiffRequest,
  isSessionFileGitCommitResource,
  isSessionFileRootResource,
} from "../../src-shared/file-explorer/file-explorer-contract.js";

import { parseSessionSummaryPageRequest } from "../session/session-summary-query.js";
import {
  WITHMATE_GET_DIFF_PREVIEW_CHANNEL,
  WITHMATE_GET_SESSION_AUDIT_LOG_DETAIL_CHANNEL,
  WITHMATE_GET_SESSION_AUDIT_LOG_DETAIL_SECTION_CHANNEL,
  WITHMATE_GET_SESSION_AUDIT_LOG_OPERATION_DETAIL_CHANNEL,
  WITHMATE_GET_SESSION_CHANNEL,
  WITHMATE_GET_SESSION_GLOSSARY_PROJECTION_CHANNEL,
  WITHMATE_VALIDATE_SESSION_WORKSPACE_CHANNEL,
  WITHMATE_LIST_SESSION_FILE_ROOTS_CHANNEL,
  WITHMATE_LIST_SESSION_DIRECTORY_CHANNEL,
  WITHMATE_INSPECT_SESSION_FILE_CHANNEL,
  WITHMATE_READ_SESSION_FILE_CHUNK_CHANNEL,
  WITHMATE_OPEN_SESSION_FILE_CHANNEL,
  WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL,
  WITHMATE_GET_SESSION_FILE_PREVIEW_WINDOW_PAYLOAD_CHANNEL,
  WITHMATE_COPY_SESSION_FILE_PREVIEW_IMAGE_CHANNEL,
  WITHMATE_SHOW_SESSION_FILE_PREVIEW_IMAGE_CONTEXT_MENU_CHANNEL,
  WITHMATE_COPY_SESSION_FILE_OBJECT_CHANNEL,
  WITHMATE_SHOW_SESSION_FILE_OBJECT_COPY_CONTEXT_MENU_CHANNEL,
  WITHMATE_SHOW_SESSION_FILE_TREE_CONTEXT_MENU_CHANNEL,
  WITHMATE_SHOW_MARKDOWN_LINK_CONTEXT_MENU_CHANNEL,
  WITHMATE_LIST_FILE_ROOT_CHANGES_CHANNEL,
  WITHMATE_LIST_FILE_ROOT_CHANGES_REPOSITORIES_CHANNEL,
  WITHMATE_GET_FILE_ROOT_DIFF_CHANNEL,
  WITHMATE_LIST_FILE_ROOT_GIT_HISTORY_REPOSITORIES_CHANNEL,
  WITHMATE_LIST_FILE_ROOT_GIT_HISTORY_COMMITS_CHANNEL,
  WITHMATE_GET_FILE_ROOT_GIT_HISTORY_COMMIT_DETAIL_CHANNEL,
  WITHMATE_GET_FILE_ROOT_GIT_HISTORY_COMPARISON_CHANNEL,
  WITHMATE_GET_FILE_ROOT_GIT_HISTORY_DIFF_CHANNEL,
  WITHMATE_GET_SESSION_MESSAGE_ARTIFACT_CHANNEL,
  WITHMATE_LIST_OPEN_SESSION_WINDOW_IDS_CHANNEL,
  WITHMATE_LIST_SESSION_AUDIT_LOGS_CHANNEL,
  WITHMATE_LIST_SESSION_AUDIT_LOG_SUMMARIES_CHANNEL,
  WITHMATE_LIST_SESSION_AUDIT_LOG_SUMMARY_PAGE_CHANNEL,
  WITHMATE_LIST_SESSION_CUSTOM_AGENTS_CHANNEL,
  WITHMATE_LIST_SESSION_SKILLS_CHANNEL,
  WITHMATE_LIST_SESSION_SUMMARY_PAGE_CHANNEL,
  WITHMATE_LIST_SESSION_CHARACTER_USAGE_CHANNEL,
  WITHMATE_LIST_WORKSPACE_CUSTOM_AGENTS_CHANNEL,
  WITHMATE_LIST_WORKSPACE_SKILLS_CHANNEL,
  WITHMATE_PREVIEW_COMPOSER_INPUT_CHANNEL,
  WITHMATE_SEARCH_SESSION_GLOSSARY_CHANNEL,
} from "../../src-shared/ipc/withmate-ipc-channels.js";
import {
  parseOpenSessionWindowIdsPageRequest,
  type OpenSessionWindowIdsPageRequest,
} from "../../src-shared/window/withmate-window-types.js";

import type {
  IpcHandleRegistrar,
  MainIpcSessionQueryDeps,
} from "./contracts.js";
import {
  assertOwningSessionWindowSender,
  assertSessionFileExplorerSender,
  assertOwningSessionFileExplorerSender,
  assertValidSessionFilePreviewResourceRequest,
  assertValidSessionFileResourceRequest,
  assertSessionFileResourceSender,
  assertValidGitHistoryDiffRequest,
  assertValidGitHistoryCommitsRequest,
  assertValidGitHistoryCursor,
  assertValidGitHistoryRequest,
  assertValidGitHistoryCommitId,
  assertValidGitHistoryComparisonSelector,
  assertValidGitHistoryComparison,
  assertValidGitHistoryRelativePath,
  assertSessionFileLinkSender,
  parseSessionFilePreviewImageActionRequest,
  parseSessionFileObjectCopyRequest,
  parseSessionFileObjectCopyContextMenuRequest,
  parseSessionFileTreeContextMenuRequest,
  parseMarkdownLinkContextMenuRequest,
} from "./shared.js";

export function registerSessionQueryHandlers(
  ipcMain: IpcHandleRegistrar,
  deps: MainIpcSessionQueryDeps,
): void {
  ipcMain.handle(
    WITHMATE_LIST_SESSION_SUMMARY_PAGE_CHANNEL,
    (_event, request: SessionSummaryPageRequest | null | undefined) =>
      deps.listSessionSummaryPage(parseSessionSummaryPageRequest(request)),
  );
  ipcMain.handle(WITHMATE_LIST_SESSION_CHARACTER_USAGE_CHANNEL, () =>
    deps.listSessionCharacterUsage(),
  );
  ipcMain.handle(
    WITHMATE_LIST_SESSION_AUDIT_LOGS_CHANNEL,
    (_event, sessionId: string) => deps.listSessionAuditLogs(sessionId),
  );
  ipcMain.handle(
    WITHMATE_LIST_SESSION_AUDIT_LOG_SUMMARIES_CHANNEL,
    (_event, sessionId: string) => deps.listSessionAuditLogSummaries(sessionId),
  );
  ipcMain.handle(
    WITHMATE_LIST_SESSION_AUDIT_LOG_SUMMARY_PAGE_CHANNEL,
    (
      _event,
      sessionId: string,
      request: AuditLogSummaryPageRequest | null | undefined,
    ) => deps.listSessionAuditLogSummaryPage(sessionId, request),
  );
  ipcMain.handle(
    WITHMATE_GET_SESSION_AUDIT_LOG_DETAIL_CHANNEL,
    (_event, sessionId: string, auditLogId: number) =>
      deps.getSessionAuditLogDetail(sessionId, auditLogId),
  );
  ipcMain.handle(
    WITHMATE_GET_SESSION_AUDIT_LOG_DETAIL_SECTION_CHANNEL,
    (
      _event,
      sessionId: string,
      auditLogId: number,
      section: AuditLogDetailSection,
    ) => deps.getSessionAuditLogDetailSection(sessionId, auditLogId, section),
  );
  ipcMain.handle(
    WITHMATE_GET_SESSION_AUDIT_LOG_OPERATION_DETAIL_CHANNEL,
    (_event, sessionId: string, auditLogId: number, operationIndex: number) =>
      deps.getSessionAuditLogOperationDetail(
        sessionId,
        auditLogId,
        operationIndex,
      ),
  );
  ipcMain.handle(
    WITHMATE_LIST_SESSION_SKILLS_CHANNEL,
    async (_event, sessionId: string) => deps.listSessionSkills(sessionId),
  );
  ipcMain.handle(
    WITHMATE_LIST_SESSION_CUSTOM_AGENTS_CHANNEL,
    async (_event, sessionId: string) =>
      deps.listSessionCustomAgents(sessionId),
  );
  ipcMain.handle(
    WITHMATE_LIST_WORKSPACE_SKILLS_CHANNEL,
    async (_event, providerId: string, workspacePath: string) =>
      deps.listWorkspaceSkills(providerId, workspacePath),
  );
  ipcMain.handle(
    WITHMATE_LIST_WORKSPACE_CUSTOM_AGENTS_CHANNEL,
    async (_event, providerId: string, workspacePath: string) =>
      deps.listWorkspaceCustomAgents(providerId, workspacePath),
  );
  ipcMain.handle(
    WITHMATE_LIST_OPEN_SESSION_WINDOW_IDS_CHANNEL,
    (_event, request: OpenSessionWindowIdsPageRequest | null | undefined) =>
      deps.listOpenSessionWindowIdsPage(
        parseOpenSessionWindowIdsPageRequest(request),
      ),
  );
  ipcMain.handle(WITHMATE_GET_SESSION_CHANNEL, (_event, sessionId: string) => {
    if (!sessionId) {
      return null;
    }
    return deps.getSession(sessionId);
  });
  ipcMain.handle(
    WITHMATE_GET_SESSION_GLOSSARY_PROJECTION_CHANNEL,
    async (event, sessionId: string) => {
      if (typeof sessionId !== "string" || !sessionId) {
        throw new TypeError("Session ID is invalid.");
      }
      assertOwningSessionWindowSender(event, sessionId, deps);
      await deps.ensureSessionGlossarySubscription(sessionId);
      return deps.getSessionGlossaryProjection(sessionId);
    },
  );
  ipcMain.handle(
    WITHMATE_SEARCH_SESSION_GLOSSARY_CHANNEL,
    async (event, sessionId: string, request: GlossarySearchRequest) => {
      if (
        typeof sessionId !== "string" ||
        !sessionId ||
        !request ||
        typeof request.query !== "string"
      ) {
        throw new TypeError("Glossary search request is invalid.");
      }
      assertOwningSessionWindowSender(event, sessionId, deps);
      return deps.searchSessionGlossary(sessionId, request);
    },
  );
  ipcMain.handle(
    WITHMATE_VALIDATE_SESSION_WORKSPACE_CHANNEL,
    async (event, sessionId: string) => {
      if (typeof sessionId !== "string" || !sessionId) {
        throw new TypeError("Session ID is invalid.");
      }
      const window = deps.resolveEventWindow(event);
      if (!window || deps.resolveSessionWindow(sessionId) !== window) {
        throw new Error(
          "Session workspace validation IPC is only available from the target Session window.",
        );
      }
      const session = await deps.getSession(sessionId);
      if (!session) {
        return { valid: false, reason: "unavailable" };
      }
      return deps.validateWorkspaceDirectory(session.workspacePath);
    },
  );
  ipcMain.handle(
    WITHMATE_LIST_SESSION_FILE_ROOTS_CHANNEL,
    async (event, sessionId: string) => {
      if (typeof sessionId !== "string" || !sessionId) {
        throw new TypeError("Session ID is invalid.");
      }
      await assertSessionFileExplorerSender(event, sessionId, deps);
      return deps.listSessionFileRoots(sessionId);
    },
  );
  ipcMain.handle(
    WITHMATE_LIST_SESSION_DIRECTORY_CHANNEL,
    async (event, request: SessionDirectoryRequest) => {
      if (
        !request ||
        typeof request.sessionId !== "string" ||
        !request.sessionId
      ) {
        throw new TypeError("File Explorer request is invalid.");
      }
      await assertOwningSessionFileExplorerSender(
        event,
        request.sessionId,
        deps,
      );
      return deps.listSessionDirectory(request);
    },
  );
  ipcMain.handle(
    WITHMATE_INSPECT_SESSION_FILE_CHANNEL,
    async (event, request: SessionFilePreviewResourceRequest) => {
      assertValidSessionFilePreviewResourceRequest(request);
      await assertSessionFileResourceSender(event, request, deps);
      return deps.inspectSessionFile(request);
    },
  );
  ipcMain.handle(
    WITHMATE_READ_SESSION_FILE_CHUNK_CHANNEL,
    async (event, request: SessionFileChunkRequest) => {
      assertValidSessionFilePreviewResourceRequest(request);
      await assertSessionFileResourceSender(event, request, deps);
      return deps.readSessionFileChunk(request);
    },
  );
  ipcMain.handle(
    WITHMATE_OPEN_SESSION_FILE_CHANNEL,
    async (event, request: SessionFileOpenRequest) => {
      assertValidSessionFileResourceRequest(request);
      await assertSessionFileResourceSender(event, request, deps);
      return deps.openSessionFile(request);
    },
  );
  ipcMain.handle(
    WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL,
    async (event, request: SessionFilePreviewWindowOpenRequest) => {
      if (
        !request ||
        (request.kind !== "resource" &&
          request.kind !== "link" &&
          request.kind !== "history-diff")
      ) {
        throw new TypeError("File preview navigation request is invalid.");
      }
      if (request.kind === "history-diff") {
        assertValidGitHistoryDiffRequest(request.request);
        await assertOwningSessionFileExplorerSender(
          event,
          request.request.sessionId,
          deps,
        );
      } else if (request.kind === "resource") {
        assertValidSessionFilePreviewResourceRequest(request.resource);
        if (
          !isSessionFileRootResource(request.resource) &&
          !isSessionFileGitCommitResource(request.resource)
        ) {
          throw new TypeError(
            "Direct file preview resources must be root-scoped or commit-scoped.",
          );
        }
        if (
          request.view !== undefined &&
          (!request.view ||
            (request.view.kind !== "preview" && request.view.kind !== "diff") ||
            (request.view.kind === "diff" &&
              request.view.scope !== "working-tree" &&
              request.view.scope !== "staged"))
        ) {
          throw new TypeError("File preview window view is invalid.");
        }
        if (
          isSessionFileGitCommitResource(request.resource) &&
          request.view?.kind === "diff"
        ) {
          throw new TypeError(
            "Git commit preview resources do not support working tree diff views.",
          );
        }
        await assertOwningSessionFileExplorerSender(
          event,
          request.resource.sessionId,
          deps,
        );
      } else {
        if (
          typeof request.sessionId !== "string" ||
          !request.sessionId ||
          typeof request.target !== "string"
        ) {
          throw new TypeError("File preview navigation request is invalid.");
        }
        if (request.baseResource !== undefined) {
          assertValidSessionFilePreviewResourceRequest(
            request.baseResource,
            request.sessionId,
          );
        }
        await assertSessionFileLinkSender(
          event,
          request.sessionId,
          request.baseResource,
          deps,
        );
      }
      return deps.openSessionFilePreviewWindow(request);
    },
  );
  ipcMain.handle(
    WITHMATE_GET_SESSION_FILE_PREVIEW_WINDOW_PAYLOAD_CHANNEL,
    (event, token: string) => {
      const window = deps.resolveEventWindow(event);
      if (!token || !window || !deps.isFilePreviewTokenWindow(window, token)) {
        return null;
      }
      return deps.getSessionFilePreviewWindowPayload(token);
    },
  );
  ipcMain.handle(
    WITHMATE_COPY_SESSION_FILE_PREVIEW_IMAGE_CHANNEL,
    async (event, input: unknown) => {
      const request = parseSessionFilePreviewImageActionRequest(input);
      await assertSessionFileExplorerSender(event, request.sessionId, deps);
      return deps.copySessionFilePreviewImage(event, request);
    },
  );
  ipcMain.handle(
    WITHMATE_SHOW_SESSION_FILE_PREVIEW_IMAGE_CONTEXT_MENU_CHANNEL,
    async (event, input: unknown) => {
      const request = parseSessionFilePreviewImageActionRequest(input);
      await assertSessionFileExplorerSender(event, request.sessionId, deps);
      return deps.showSessionFilePreviewImageContextMenu(event, request);
    },
  );
  ipcMain.handle(
    WITHMATE_COPY_SESSION_FILE_OBJECT_CHANNEL,
    async (event, input: unknown) => {
      const request = parseSessionFileObjectCopyRequest(input);
      await assertSessionFileResourceSender(event, request.resource, deps);
      return deps.copySessionFileObject(event, request);
    },
  );
  ipcMain.handle(
    WITHMATE_SHOW_SESSION_FILE_OBJECT_COPY_CONTEXT_MENU_CHANNEL,
    async (event, input: unknown) => {
      const request = parseSessionFileObjectCopyContextMenuRequest(input);
      await assertSessionFileResourceSender(event, request.resource, deps);
      return deps.showSessionFileObjectCopyContextMenu(event, request);
    },
  );
  ipcMain.handle(
    WITHMATE_SHOW_SESSION_FILE_TREE_CONTEXT_MENU_CHANNEL,
    async (event, input: unknown) => {
      const request = parseSessionFileTreeContextMenuRequest(input);
      await assertOwningSessionFileExplorerSender(
        event,
        request.sessionId,
        deps,
      );
      return deps.showSessionFileTreeContextMenu(event, request);
    },
  );
  ipcMain.handle(
    WITHMATE_SHOW_MARKDOWN_LINK_CONTEXT_MENU_CHANNEL,
    async (event, input: unknown) => {
      const request = parseMarkdownLinkContextMenuRequest(input);
      if (!deps.resolveEventWindow(event)) {
        throw new TypeError(
          "Markdown link context menu is only available from a WithMate window.",
        );
      }
      if (request.fileContext) {
        await assertSessionFileLinkSender(
          event,
          request.fileContext.sessionId,
          request.fileContext.baseResource,
          deps,
        );
      }
      return deps.showMarkdownLinkContextMenu(event, request);
    },
  );
  ipcMain.handle(
    WITHMATE_LIST_FILE_ROOT_CHANGES_CHANNEL,
    async (event, request: FileRootChangesRequest) => {
      if (
        !request ||
        typeof request.sessionId !== "string" ||
        !request.sessionId ||
        typeof request.rootId !== "string" ||
        !request.rootId
      ) {
        throw new TypeError("File root changes request is invalid.");
      }
      const currentResource = await assertSessionFileExplorerSender(
        event,
        request.sessionId,
        deps,
      );
      if (
        currentResource &&
        (!isSessionFileRootResource(currentResource) ||
          currentResource.rootId !== request.rootId)
      ) {
        throw new Error(
          "Git changes are only available for the current Preview resource.",
        );
      }
      const result = await deps.listFileRootChanges(request);
      if (!currentResource || result.status !== "ok") {
        return result;
      }
      return {
        ...result,
        entries: result.entries.filter((entry) =>
          areSessionFileResourcesEqual(currentResource, {
            sessionId: request.sessionId,
            rootId: request.rootId,
            relativePath: entry.relativePath,
          }),
        ),
      };
    },
  );
  ipcMain.handle(
    WITHMATE_LIST_FILE_ROOT_CHANGES_REPOSITORIES_CHANNEL,
    async (event, request: FileRootChangesRepositoriesRequest) => {
      if (
        !request ||
        typeof request.sessionId !== "string" ||
        !request.sessionId ||
        !Array.isArray(request.rootIds) ||
        request.rootIds.length > 256 ||
        request.rootIds.some(
          (rootId) => typeof rootId !== "string" || !rootId,
        ) ||
        new Set(request.rootIds).size !== request.rootIds.length
      ) {
        throw new TypeError("Git repositories request is invalid.");
      }
      await assertOwningSessionFileExplorerSender(
        event,
        request.sessionId,
        deps,
      );
      return deps.listFileRootChangesRepositories(request);
    },
  );
  ipcMain.handle(
    WITHMATE_GET_FILE_ROOT_DIFF_CHANNEL,
    async (event, request: FileRootFileDiffRequest) => {
      if (
        !request ||
        typeof request.sessionId !== "string" ||
        !request.sessionId ||
        typeof request.rootId !== "string" ||
        !request.rootId ||
        typeof request.relativePath !== "string" ||
        !request.relativePath ||
        (request.scope !== "working-tree" && request.scope !== "staged")
      ) {
        throw new TypeError("Git Diff request is invalid.");
      }
      await assertSessionFileResourceSender(
        event,
        {
          sessionId: request.sessionId,
          rootId: request.rootId,
          relativePath: request.relativePath,
        },
        deps,
      );
      return deps.getFileRootDiff(request);
    },
  );
  ipcMain.handle(
    WITHMATE_LIST_FILE_ROOT_GIT_HISTORY_REPOSITORIES_CHANNEL,
    async (event, request: FileRootGitHistoryRepositoriesRequest) => {
      if (
        !request ||
        typeof request.sessionId !== "string" ||
        !request.sessionId
      ) {
        throw new TypeError("Git history repositories request is invalid.");
      }
      await assertOwningSessionFileExplorerSender(
        event,
        request.sessionId,
        deps,
      );
      return deps.listFileRootGitHistoryRepositories(request);
    },
  );
  ipcMain.handle(
    WITHMATE_LIST_FILE_ROOT_GIT_HISTORY_COMMITS_CHANNEL,
    async (event, request: FileRootGitHistoryCommitsRequest) => {
      assertValidGitHistoryCommitsRequest(request);
      assertValidGitHistoryCursor(request.cursor);
      await assertOwningSessionFileExplorerSender(
        event,
        request.sessionId,
        deps,
      );
      return deps.listFileRootGitHistoryCommits(request);
    },
  );
  ipcMain.handle(
    WITHMATE_GET_FILE_ROOT_GIT_HISTORY_COMMIT_DETAIL_CHANNEL,
    async (event, request: FileRootGitHistoryCommitDetailRequest) => {
      assertValidGitHistoryRequest(request);
      assertValidGitHistoryCommitId(request.commitId);
      await assertOwningSessionFileExplorerSender(
        event,
        request.sessionId,
        deps,
      );
      return deps.getFileRootGitHistoryCommitDetail(request);
    },
  );
  ipcMain.handle(
    WITHMATE_GET_FILE_ROOT_GIT_HISTORY_COMPARISON_CHANNEL,
    async (event, request: FileRootGitHistoryComparisonRequest) => {
      assertValidGitHistoryRequest(request);
      if (request.mode !== "direct" && request.mode !== "branch") {
        throw new TypeError("Git history comparison mode is invalid.");
      }
      assertValidGitHistoryComparisonSelector(request.base);
      assertValidGitHistoryComparisonSelector(request.target);
      await assertOwningSessionFileExplorerSender(
        event,
        request.sessionId,
        deps,
      );
      return deps.getFileRootGitHistoryComparison(request);
    },
  );
  ipcMain.handle(
    WITHMATE_GET_FILE_ROOT_GIT_HISTORY_DIFF_CHANNEL,
    async (event, request: FileRootGitHistoryDiffRequest) => {
      assertValidGitHistoryRequest(request);
      if (isFileRootGitHistoryComparisonDiffRequest(request)) {
        assertValidGitHistoryComparison(request.comparison);
      } else {
        assertValidGitHistoryCommitId(request.commitId);
      }
      assertValidGitHistoryRelativePath(request.relativePath);
      await assertOwningSessionFileExplorerSender(
        event,
        request.sessionId,
        deps,
      );
      return deps.getFileRootGitHistoryDiff(request);
    },
  );
  ipcMain.handle(
    WITHMATE_GET_SESSION_MESSAGE_ARTIFACT_CHANNEL,
    (_event, sessionId: string, messageIndex: number) => {
      if (!sessionId || !Number.isInteger(messageIndex) || messageIndex < 0) {
        return null;
      }
      return deps.getSessionMessageArtifact(sessionId, messageIndex);
    },
  );
  ipcMain.handle(WITHMATE_GET_DIFF_PREVIEW_CHANNEL, (_event, token: string) => {
    if (!token) {
      return null;
    }
    return deps.getDiffPreview(token);
  });
  ipcMain.handle(
    WITHMATE_PREVIEW_COMPOSER_INPUT_CHANNEL,
    (_event, sessionId: string, userMessage: string) =>
      deps.previewComposerInput(sessionId, userMessage),
  );
}

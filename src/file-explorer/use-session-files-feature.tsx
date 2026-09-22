import { useState } from "react";

import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import {
  buildSessionFileExplorerRootsRevision,
  isFileRootGitHistoryComparisonDiffRequest,
  type FileRootGitHistoryComparison,
  type FileRootGitHistoryDiffRequest,
  type SessionFileGitCommitResourceRequest,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import { FileRootChangesPane } from "./FileRootChangesPane.js";
import { FileRootGitHistoryPane } from "./FileRootGitHistoryPane.js";
import { SessionFileExplorerPane } from "./SessionFileExplorerPane.js";
import { SessionDiffPreview, SessionFilePreview } from "./SessionFilePreview.js";
import { useFileRootPreviewController } from "./use-file-root-preview-controller.js";

function formatGitHistoryComparisonSelector(selector: FileRootGitHistoryComparison["base"]): string {
  if (selector.kind === "head") return "HEAD";
  if (selector.kind === "commit") return `Commit ${selector.objectId.slice(0, 7)}`;
  return selector.name;
}

function formatGitHistoryDiffTitle(request: FileRootGitHistoryDiffRequest): string {
  if (isFileRootGitHistoryComparisonDiffRequest(request)) {
    return request.relativePath
      ?? `${formatGitHistoryComparisonSelector(request.comparison.base)} → ${formatGitHistoryComparisonSelector(request.comparison.target)}`;
  }
  return request.relativePath ?? `Commit ${request.commitId.slice(0, 7)}`;
}

function formatGitHistoryDiffContext(request: FileRootGitHistoryDiffRequest): string | undefined {
  if (!isFileRootGitHistoryComparisonDiffRequest(request)) return undefined;
  const mergeBase = request.comparison.mergeBaseCommitId
    ? ` · merge-base ${request.comparison.mergeBaseCommitId.slice(0, 7)}`
    : "";
  return `${request.comparison.mode === "branch" ? "Branch changes" : "Direct comparison"} · ${request.comparison.baseCommitId.slice(0, 7)} → ${request.comparison.targetCommitId.slice(0, 7)}${mergeBase}`;
}

export function useSessionFilesFeature(input: {
  api: WithMateWindowApi | null;
  activeRunSessionId: string | null;
  prepareCentralSurfaceOpen: () => boolean;
  workspacePath: string | null;
  additionalDirectories: readonly string[];
  enabled: boolean;
}) {
  const controller = useFileRootPreviewController(input);
  const [activeTab, setActiveTab] = useState<"files" | "changes" | "history">("files");
  const [changesRefreshRevision, setChangesRefreshRevision] = useState(0);
  const [historyRefreshRevision, setHistoryRefreshRevision] = useState(0);
  const rootsRevision = buildSessionFileExplorerRootsRevision({
    sessionId: input.activeRunSessionId,
    workspacePath: input.workspacePath,
    additionalDirectories: input.additionalDirectories,
  });
  const { view, actions } = controller;

  const openHistoryPreview = async (resource: SessionFileGitCommitResourceRequest): Promise<string | null> => {
    if (!input.api || resource.sessionId !== input.activeRunSessionId) {
      return "Git history file preview is not available for this session.";
    }
    try {
      const result = await input.api.openSessionFilePreviewWindow({ kind: "resource", resource });
      return result.status === "opened" ? null : result.message;
    } catch (error) {
      return error instanceof Error ? error.message : "The Git history file preview could not be opened.";
    }
  };

  function renderPane(composer: { canInsertPathReference: boolean; insertReferencePaths: (paths: string[]) => void }) {
    return (
      <SessionFileExplorerPane
        api={input.api}
        sessionId={input.activeRunSessionId}
        enabled={input.enabled}
        rootsRevision={rootsRevision}
        selectedFile={view.selectedFilePreview}
        activeTab={activeTab}
        onActiveTabChange={(tab) => {
          if (tab !== "history") actions.clearHistoryDiffPreview();
          setActiveTab(tab);
        }}
        onRefreshChanges={() => setChangesRefreshRevision((current) => current + 1)}
        onRefreshHistory={() => setHistoryRefreshRevision((current) => current + 1)}
        onOpenFile={(request, openInWindow) => {
          void actions.handleOpenFileRootFile(request, openInWindow).then((message) => {
            if (message) window.alert(message);
          });
        }}
        canInsertPathReference={composer.canInsertPathReference}
        onInsertPathReference={(ownerSessionId, absolutePath) => {
          if (ownerSessionId !== input.activeRunSessionId || !composer.canInsertPathReference) return;
          composer.insertReferencePaths([absolutePath]);
        }}
        renderChangesContent={(roots) => (
          <FileRootChangesPane
            api={input.api}
            sessionId={input.activeRunSessionId}
            enabled={input.enabled}
            roots={roots}
            rootsRevision={rootsRevision}
            refreshRevision={changesRefreshRevision}
            onOpenFile={actions.handleOpenFileRootFile}
            onOpenDiff={actions.handleShowFileRootDiff}
          />
        )}
        historyContent={(
          <FileRootGitHistoryPane
            api={input.api}
            sessionId={input.activeRunSessionId}
            enabled={input.enabled}
            rootsRevision={rootsRevision}
            refreshRevision={historyRefreshRevision}
            onOpenDiff={actions.handleShowFileRootGitHistoryDiff}
            onRepositoryChange={actions.clearHistoryDiffPreview}
          />
        )}
      />
    );
  }

  function renderPreview(bindings: {
    onBack: () => void;
    onCopyText: (text: string) => void;
    onQuoteText: (text: string) => void;
    chatNotice: string;
  }) {
    const {
      selectedFilePreview, selectedFileDiffScopes, selectedFileDiffAvailabilityMessage,
      fileRootDiffPreview, fileRootDiffPendingPreview, fileRootDiffLoadingScope,
      fileRootGitHistoryDiffPreview, fileRootGitHistoryDiffPendingPreview, fileRootGitHistoryDiffLoading,
    } = view;
    const shared = {
      backNavigation: { label: "Back to Chat", onBack: bindings.onBack },
      onCopyText: bindings.onCopyText,
      onQuoteText: bindings.onQuoteText,
      chatNotice: bindings.chatNotice,
    };
    if (fileRootGitHistoryDiffPendingPreview) {
      return (
        <SessionDiffPreview
          {...shared}
          title={formatGitHistoryDiffTitle(fileRootGitHistoryDiffPendingPreview.request)}
          contextLabel={formatGitHistoryDiffContext(fileRootGitHistoryDiffPendingPreview.request)}
          previewRevision={fileRootGitHistoryDiffPendingPreview.generation}
          patch=""
          loading
          onReload={() => actions.handleShowFileRootGitHistoryDiff(fileRootGitHistoryDiffPendingPreview.request)}
          reloadPending
        />
      );
    }
    if (fileRootGitHistoryDiffPreview) {
      return (
        <SessionDiffPreview
          {...shared}
          title={formatGitHistoryDiffTitle(fileRootGitHistoryDiffPreview.request)}
          contextLabel={formatGitHistoryDiffContext(fileRootGitHistoryDiffPreview.request)}
          previewRevision={fileRootGitHistoryDiffPreview.generation}
          patch={fileRootGitHistoryDiffPreview.patch}
          onOpenPreview={fileRootGitHistoryDiffPreview.previewResource && !fileRootGitHistoryDiffPreview.comparison
            ? () => openHistoryPreview(fileRootGitHistoryDiffPreview.previewResource!) : undefined}
          onOpenBeforePreview={fileRootGitHistoryDiffPreview.previewBeforeResource
            ? () => openHistoryPreview(fileRootGitHistoryDiffPreview.previewBeforeResource!) : undefined}
          onOpenAfterPreview={fileRootGitHistoryDiffPreview.previewAfterResource
            ? () => openHistoryPreview(fileRootGitHistoryDiffPreview.previewAfterResource!) : undefined}
          onReload={actions.handleReloadFileRootGitHistoryDiff}
          reloadPending={fileRootGitHistoryDiffLoading}
        />
      );
    }
    if (fileRootDiffPendingPreview) {
      return (
        <SessionDiffPreview
          {...shared}
          title={`${fileRootDiffPendingPreview.relativePath} · ${fileRootDiffPendingPreview.scope === "staged" ? "Staged" : "Working Tree"}`}
          previewRevision={fileRootDiffPendingPreview.generation}
          patch=""
          loading
          onOpenPreview={() => actions.handleOpenFileRootFile({
            sessionId: fileRootDiffPendingPreview.sessionId,
            rootId: fileRootDiffPendingPreview.rootId,
            relativePath: fileRootDiffPendingPreview.relativePath,
          })}
          onReload={() => actions.handleShowFileRootDiff(fileRootDiffPendingPreview)}
          reloadPending
        />
      );
    }
    if (fileRootDiffPreview) {
      return (
        <SessionDiffPreview
          {...shared}
          title={`${fileRootDiffPreview.relativePath} · ${fileRootDiffPreview.scope === "staged" ? "Staged" : "Working Tree"}`}
          previewRevision={fileRootDiffPreview.generation}
          patch={fileRootDiffPreview.patch}
          onOpenPreview={() => actions.handleOpenFileRootFile({
            sessionId: fileRootDiffPreview.sessionId,
            rootId: fileRootDiffPreview.rootId,
            relativePath: fileRootDiffPreview.relativePath,
          })}
          onReload={actions.handleReloadFileRootDiff}
          reloadPending={fileRootDiffLoadingScope === fileRootDiffPreview.scope}
        />
      );
    }
    if (selectedFilePreview) {
      return (
        <SessionFilePreview
          {...shared}
          api={input.api}
          request={selectedFilePreview}
          diffScopes={selectedFileDiffScopes}
          diffAvailabilityMessage={selectedFileDiffAvailabilityMessage}
          onOpenDiff={selectedFileDiffScopes.length > 0 ? actions.handleOpenSelectedFileDiff : undefined}
          diffLoadingScope={fileRootDiffLoadingScope}
        />
      );
    }
    return undefined;
  }

  return {
    isPreviewActive: view.selectedFilePreview !== null
      || view.fileRootDiffPreview !== null
      || view.fileRootDiffPendingPreview !== null
      || view.fileRootGitHistoryDiffPreview !== null
      || view.fileRootGitHistoryDiffPendingPreview !== null,
    closeFilePreviews: actions.closeFilePreviews,
    renderPane,
    renderPreview,
  };
}

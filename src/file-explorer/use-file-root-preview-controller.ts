import { useCallback, useEffect, useRef, useState } from "react";

import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type {
  FileRootFileDiffRequest,
  FileRootGitDiffScope,
  FileRootGitHistoryComparison,
  FileRootGitHistoryDiffRequest,
  SessionFileGitCommitResourceRequest,
  SessionFileRootResourceRequest,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import { buildFileRootDiffPreviewWindowRequest } from "../../src-shared/file-explorer/file-explorer-contract.js";
import { projectFileRootDiffAvailability } from "./file-preview-utils.js";

type FileRootPreviewApi = Pick<WithMateWindowApi,
  "getFileRootDiff"
  | "getFileRootGitHistoryDiff"
  | "listFileRootChanges"
  | "openSessionFilePreviewWindow"
>;

type FileRootDiffPreview = {
  sessionId: string;
  rootId: string;
  relativePath: string;
  scope: FileRootGitDiffScope;
  generation: number;
  patch: string;
};

type FileRootGitHistoryDiffPreview = {
  request: FileRootGitHistoryDiffRequest;
  generation: number;
  patch: string;
  previewResource: SessionFileGitCommitResourceRequest | null;
  comparison: FileRootGitHistoryComparison | null;
  previewBeforeResource: SessionFileGitCommitResourceRequest | null;
  previewAfterResource: SessionFileGitCommitResourceRequest | null;
};

export function useFileRootPreviewController({
  api,
  activeRunSessionId,
  prepareCentralSurfaceOpen,
}: {
  api: FileRootPreviewApi | null;
  activeRunSessionId: string | null;
  prepareCentralSurfaceOpen: () => boolean;
}) {
  const [selectedFilePreview, setSelectedFilePreview] = useState<SessionFileRootResourceRequest | null>(null);
  const [selectedFileDiffScopes, setSelectedFileDiffScopes] = useState<FileRootGitDiffScope[]>([]);
  const [selectedFileDiffAvailabilityMessage, setSelectedFileDiffAvailabilityMessage] = useState("");
  const [fileRootDiffPreview, setFileRootDiffPreview] = useState<FileRootDiffPreview | null>(null);
  const [fileRootDiffPendingPreview, setFileRootDiffPendingPreview] = useState<(FileRootFileDiffRequest & { generation: number }) | null>(null);
  const [fileRootDiffLoadingScope, setFileRootDiffLoadingScope] = useState<FileRootGitDiffScope | null>(null);
  const [fileRootGitHistoryDiffPreview, setFileRootGitHistoryDiffPreview] = useState<FileRootGitHistoryDiffPreview | null>(null);
  const [fileRootGitHistoryDiffPendingPreview, setFileRootGitHistoryDiffPendingPreview] = useState<{ request: FileRootGitHistoryDiffRequest; generation: number } | null>(null);
  const [fileRootGitHistoryDiffLoading, setFileRootGitHistoryDiffLoading] = useState(false);
  const fileRootDiffRequestRevisionRef = useRef(0);
  const fileRootGitHistoryDiffRequestRevisionRef = useRef(0);

  const clearHistoryDiffPreview = useCallback(() => {
    fileRootGitHistoryDiffRequestRevisionRef.current += 1;
    setFileRootGitHistoryDiffPendingPreview(null);
    setFileRootGitHistoryDiffPreview(null);
    setFileRootGitHistoryDiffLoading(false);
  }, []);
  const closeFilePreviews = useCallback(() => {
    fileRootDiffRequestRevisionRef.current += 1;
    setFileRootDiffLoadingScope(null);
    setFileRootDiffPendingPreview(null);
    setFileRootDiffPreview(null);
    setSelectedFileDiffAvailabilityMessage("");
    setSelectedFilePreview(null);
    clearHistoryDiffPreview();
  }, [clearHistoryDiffPreview]);

  useEffect(() => {
    fileRootDiffRequestRevisionRef.current += 1;
    setSelectedFilePreview((current) => current?.sessionId === activeRunSessionId ? current : null);
    setSelectedFileDiffScopes([]);
    setSelectedFileDiffAvailabilityMessage("");
    setFileRootDiffPendingPreview(null);
    setFileRootDiffPreview(null);
    setFileRootDiffLoadingScope(null);
    clearHistoryDiffPreview();
  }, [activeRunSessionId, clearHistoryDiffPreview]);

  useEffect(() => {
    let active = true;
    setSelectedFileDiffScopes([]);
    setSelectedFileDiffAvailabilityMessage("");
    if (!api || !activeRunSessionId || !selectedFilePreview) {
      return () => {
        active = false;
      };
    }
    void api.listFileRootChanges({ sessionId: activeRunSessionId, rootId: selectedFilePreview.rootId }).then((result) => {
      if (active) {
        const availability = projectFileRootDiffAvailability(result, selectedFilePreview.relativePath);
        setSelectedFileDiffScopes(availability.scopes);
        setSelectedFileDiffAvailabilityMessage(availability.message);
      }
    }).catch(() => {
      if (active) {
        setSelectedFileDiffScopes([]);
        setSelectedFileDiffAvailabilityMessage("");
      }
    });
    return () => {
      active = false;
    };
  }, [activeRunSessionId, api, selectedFilePreview]);

  const handleOpenFileRootFile = useCallback(async (request: SessionFileRootResourceRequest, openInWindow = false): Promise<string | null> => {
    if (openInWindow) {
      if (!api) return "The file preview could not be opened.";
      try {
        const result = await api.openSessionFilePreviewWindow({ kind: "resource", resource: request });
        return result.status === "opened" ? null : result.message;
      } catch (error) {
        return error instanceof Error ? error.message : "The file preview could not be opened.";
      }
    }
    if (!prepareCentralSurfaceOpen()) return null;
    fileRootDiffRequestRevisionRef.current += 1;
    setFileRootDiffLoadingScope(null);
    setFileRootDiffPendingPreview(null);
    setFileRootDiffPreview(null);
    setSelectedFileDiffAvailabilityMessage("");
    setSelectedFilePreview(request);
    return null;
  }, [api, prepareCentralSurfaceOpen]);

  const handleShowFileRootDiff = useCallback((request: FileRootFileDiffRequest, openInWindow = false): Promise<string | null> => {
    if (!api || request.sessionId !== activeRunSessionId) return Promise.resolve("Git diff is not available for this session.");
    if (openInWindow) return api.openSessionFilePreviewWindow(buildFileRootDiffPreviewWindowRequest(request)).then((result) => result.status === "opened" ? null : result.message).catch((error) => error instanceof Error ? error.message : "The Git diff preview could not be opened.");
    if (!prepareCentralSurfaceOpen()) return Promise.resolve(null);
    const revision = fileRootDiffRequestRevisionRef.current + 1;
    fileRootDiffRequestRevisionRef.current = revision;
    setFileRootDiffPendingPreview({ ...request, generation: revision });
    setFileRootDiffLoadingScope(request.scope);
    return api.getFileRootDiff(request).then((result) => {
      if (fileRootDiffRequestRevisionRef.current !== revision) return null;
      if (result.status !== "ok") return result.message;
      setFileRootDiffPreview({ sessionId: request.sessionId, rootId: request.rootId, relativePath: result.relativePath, scope: result.scope, generation: revision, patch: result.patch });
      setFileRootDiffPendingPreview(null);
      return null;
    }).catch((error) => fileRootDiffRequestRevisionRef.current === revision ? error instanceof Error ? error.message : "Git diff failed." : null).finally(() => {
      if (fileRootDiffRequestRevisionRef.current === revision) {
        setFileRootDiffPendingPreview(null);
        setFileRootDiffLoadingScope(null);
      }
    });
  }, [activeRunSessionId, api, prepareCentralSurfaceOpen]);

  const handleOpenSelectedFileDiff = useCallback(async (scope: FileRootGitDiffScope): Promise<string | null> => {
    if (!api || !activeRunSessionId || !selectedFilePreview) return "Git Diff is not available for this file.";
    if (!prepareCentralSurfaceOpen()) return null;
    const revision = fileRootDiffRequestRevisionRef.current + 1;
    fileRootDiffRequestRevisionRef.current = revision;
    const request = { ...selectedFilePreview };
    setFileRootDiffPendingPreview({ ...request, scope, generation: revision });
    setFileRootDiffLoadingScope(scope);
    try {
      const status = await api.listFileRootChanges({ sessionId: activeRunSessionId, rootId: request.rootId });
      if (fileRootDiffRequestRevisionRef.current !== revision) return null;
      if (status.status !== "ok") return status.message;
      const change = status.entries.find((entry) => entry.relativePath === request.relativePath);
      if (!change) return "This file has no Git changes.";
      if (change.kinds[scope] === "untracked") return "Untracked files do not have a Git diff yet.";
      if (!change.scopes.includes(scope)) return "This file is no longer changed in the selected Git scope.";
      const result = await api.getFileRootDiff({ sessionId: activeRunSessionId, rootId: request.rootId, relativePath: request.relativePath, scope });
      if (fileRootDiffRequestRevisionRef.current !== revision) return null;
      if (result.status !== "ok") return result.message;
      setFileRootDiffPreview({ sessionId: activeRunSessionId, rootId: request.rootId, relativePath: result.relativePath, scope: result.scope, generation: revision, patch: result.patch });
      setFileRootDiffPendingPreview(null);
      return null;
    } catch (error) {
      return fileRootDiffRequestRevisionRef.current === revision ? error instanceof Error ? error.message : "Git diff failed." : null;
    } finally {
      if (fileRootDiffRequestRevisionRef.current === revision) {
        setFileRootDiffPendingPreview(null);
        setFileRootDiffLoadingScope(null);
      }
    }
  }, [activeRunSessionId, api, prepareCentralSurfaceOpen, selectedFilePreview]);

  const handleReloadFileRootDiff = useCallback(async (): Promise<string | null> => {
    if (!api || !fileRootDiffPreview || fileRootDiffPreview.sessionId !== activeRunSessionId) return "Git diff is no longer available for this session.";
    const revision = fileRootDiffRequestRevisionRef.current + 1;
    fileRootDiffRequestRevisionRef.current = revision;
    setFileRootDiffLoadingScope(fileRootDiffPreview.scope);
    try {
      const result = await api.getFileRootDiff({ sessionId: fileRootDiffPreview.sessionId, rootId: fileRootDiffPreview.rootId, relativePath: fileRootDiffPreview.relativePath, scope: fileRootDiffPreview.scope });
      if (fileRootDiffRequestRevisionRef.current !== revision) return null;
      if (result.status !== "ok") return result.message;
      setFileRootDiffPreview({ sessionId: fileRootDiffPreview.sessionId, rootId: fileRootDiffPreview.rootId, relativePath: result.relativePath, scope: result.scope, generation: revision, patch: result.patch });
      return null;
    } catch (error) {
      return fileRootDiffRequestRevisionRef.current === revision ? error instanceof Error ? error.message : "Git diff failed." : null;
    } finally {
      if (fileRootDiffRequestRevisionRef.current === revision) setFileRootDiffLoadingScope(null);
    }
  }, [activeRunSessionId, api, fileRootDiffPreview]);

  const handleShowFileRootGitHistoryDiff = useCallback((request: FileRootGitHistoryDiffRequest, openInWindow = false): Promise<string | null> => {
    if (!api || request.sessionId !== activeRunSessionId) return Promise.resolve("Git history diff is not available for this session.");
    if (openInWindow) return api.openSessionFilePreviewWindow({ kind: "history-diff", request }).then((result) => result.status === "opened" ? null : result.message).catch((error) => error instanceof Error ? error.message : "The Git history diff preview could not be opened.");
    if (!prepareCentralSurfaceOpen()) return Promise.resolve(null);
    const revision = fileRootGitHistoryDiffRequestRevisionRef.current + 1;
    fileRootGitHistoryDiffRequestRevisionRef.current = revision;
    setFileRootGitHistoryDiffPendingPreview({ request, generation: revision });
    setFileRootGitHistoryDiffLoading(true);
    return api.getFileRootGitHistoryDiff(request).then((result) => {
      if (fileRootGitHistoryDiffRequestRevisionRef.current !== revision) return null;
      if (result.status !== "ok") return result.message;
      setFileRootGitHistoryDiffPreview({ request, generation: revision, patch: result.patch, previewResource: "previewResource" in result ? result.previewResource : null, comparison: "comparison" in result ? result.comparison : null, previewBeforeResource: "previewBeforeResource" in result ? result.previewBeforeResource : null, previewAfterResource: "previewAfterResource" in result ? result.previewAfterResource : null });
      setFileRootGitHistoryDiffPendingPreview(null);
      return null;
    }).catch((error) => fileRootGitHistoryDiffRequestRevisionRef.current === revision ? error instanceof Error ? error.message : "Git history diff failed." : null).finally(() => {
      if (fileRootGitHistoryDiffRequestRevisionRef.current === revision) {
        setFileRootGitHistoryDiffPendingPreview(null);
        setFileRootGitHistoryDiffLoading(false);
      }
    });
  }, [activeRunSessionId, api, prepareCentralSurfaceOpen]);

  const handleReloadFileRootGitHistoryDiff = useCallback(async (): Promise<string | null> => {
    const preview = fileRootGitHistoryDiffPreview;
    if (!api || !preview || preview.request.sessionId !== activeRunSessionId) return "Git history diff is no longer available for this session.";
    const revision = fileRootGitHistoryDiffRequestRevisionRef.current + 1;
    fileRootGitHistoryDiffRequestRevisionRef.current = revision;
    setFileRootGitHistoryDiffLoading(true);
    try {
      const result = await api.getFileRootGitHistoryDiff(preview.request);
      if (fileRootGitHistoryDiffRequestRevisionRef.current !== revision) return null;
      if (result.status !== "ok") return result.message;
      setFileRootGitHistoryDiffPreview({ request: preview.request, generation: revision, patch: result.patch, previewResource: "previewResource" in result ? result.previewResource : null, comparison: "comparison" in result ? result.comparison : null, previewBeforeResource: "previewBeforeResource" in result ? result.previewBeforeResource : null, previewAfterResource: "previewAfterResource" in result ? result.previewAfterResource : null });
      return null;
    } catch (error) {
      return fileRootGitHistoryDiffRequestRevisionRef.current === revision ? error instanceof Error ? error.message : "Git history diff failed." : null;
    } finally {
      if (fileRootGitHistoryDiffRequestRevisionRef.current === revision) setFileRootGitHistoryDiffLoading(false);
    }
  }, [activeRunSessionId, api, fileRootGitHistoryDiffPreview]);

  return {
    view: {
      selectedFilePreview,
      selectedFileDiffScopes,
      selectedFileDiffAvailabilityMessage,
      fileRootDiffPreview,
      fileRootDiffPendingPreview,
      fileRootDiffLoadingScope,
      fileRootGitHistoryDiffPreview,
      fileRootGitHistoryDiffPendingPreview,
      fileRootGitHistoryDiffLoading,
    },
    actions: {
      closeFilePreviews,
      clearHistoryDiffPreview,
      handleOpenFileRootFile,
      handleShowFileRootDiff,
      handleOpenSelectedFileDiff,
      handleReloadFileRootDiff,
      handleShowFileRootGitHistoryDiff,
      handleReloadFileRootGitHistoryDiff,
    },
  };
}

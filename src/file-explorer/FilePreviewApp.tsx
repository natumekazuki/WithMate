import { useCallback, useEffect, useRef, useState } from "react";

import { getWithMateApi, isDesktopRuntime } from "../app/renderer-withmate-api.js";
import { SessionDiffPreview, SessionFilePreview } from "./SessionFilePreview.js";
import { projectFileRootDiffAvailability } from "./file-preview-utils.js";
import type {
  FileRootGitHistoryComparisonSelector,
  FileRootGitHistoryDiffRequest,
  FileRootGitDiffScope,
  SessionFilePreviewWindowPayload,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import {
  areSessionFileResourcesEqual,
  getSessionFileResourceDisplayPath,
  isFileRootGitHistoryComparisonDiffRequest,
  isSessionFileRootResource,
} from "../../src-shared/file-explorer/file-explorer-contract.js";

type DiffState = {
  scope: FileRootGitDiffScope;
  patch: string;
  revision: number;
};

type PayloadLoadState = "loading" | "ready" | "unavailable" | "error";

function getToken(): string {
  return new URLSearchParams(window.location.search).get("token")?.trim() ?? "";
}

function formatHistoryDiffSelector(selector: FileRootGitHistoryComparisonSelector): string {
  if (selector.kind === "head") {
    return "HEAD";
  }
  if (selector.kind === "commit") {
    return `Commit ${selector.objectId.slice(0, 7)}`;
  }
  return selector.name;
}

function formatHistoryDiffTitle(request: FileRootGitHistoryDiffRequest): string {
  if (isFileRootGitHistoryComparisonDiffRequest(request)) {
    return request.relativePath
      ?? `${formatHistoryDiffSelector(request.comparison.base)} → ${formatHistoryDiffSelector(request.comparison.target)}`;
  }
  return request.relativePath ?? `Commit ${request.commitId.slice(0, 7)}`;
}

function formatHistoryDiffContext(request: FileRootGitHistoryDiffRequest): string | undefined {
  if (!isFileRootGitHistoryComparisonDiffRequest(request)) {
    return undefined;
  }
  const mergeBase = request.comparison.mergeBaseCommitId
    ? ` · merge-base ${request.comparison.mergeBaseCommitId.slice(0, 7)}`
    : "";
  return `${request.comparison.mode === "branch" ? "Branch changes" : "Direct comparison"} · ${request.comparison.baseCommitId.slice(0, 7)} → ${request.comparison.targetCommitId.slice(0, 7)}${mergeBase}`;
}

function areFilePreviewPayloadsEqual(
  left: SessionFilePreviewWindowPayload,
  right: SessionFilePreviewWindowPayload,
): boolean {
  if ("historyDiff" in left || "historyDiff" in right) {
    return "historyDiff" in left
      && "historyDiff" in right
      && JSON.stringify(left.historyDiff.request) === JSON.stringify(right.historyDiff.request);
  }
  return areSessionFileResourcesEqual(left.resource, right.resource);
}

function FilePreviewWindowLoading({ label }: { label: string }) {
  return (
    <main className="file-preview-window-page" aria-busy="true">
      <section className="session-file-preview file-preview-window-loading" aria-label="File preview">
        <span className="visually-hidden" role="status" aria-live="polite">{label}</span>
        <header className="session-file-preview-header" aria-hidden="true">
          <span className="file-preview-loading-title" />
          <span className="file-preview-loading-actions" />
        </header>
        <div className="file-preview-loading-content" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
      </section>
    </main>
  );
}

export default function FilePreviewApp() {
  const api = getWithMateApi();
  const [payload, setPayload] = useState<SessionFilePreviewWindowPayload | null>(null);
  const [payloadLoadState, setPayloadLoadState] = useState<PayloadLoadState>(() => (
    api && getToken() ? "loading" : "unavailable"
  ));
  const [payloadLoadMessage, setPayloadLoadMessage] = useState("");
  const [diffScopes, setDiffScopes] = useState<FileRootGitDiffScope[]>([]);
  const [diffState, setDiffState] = useState<DiffState | null>(null);
  const [diffLoadingScope, setDiffLoadingScope] = useState<FileRootGitDiffScope | null>(null);
  const [navigationMessage, setNavigationMessage] = useState("");
  const diffRequestRevisionRef = useRef(0);

  useEffect(() => {
    let active = true;
    const token = getToken();
    if (!api || !token) {
      setPayload(null);
      setPayloadLoadMessage("");
      setPayloadLoadState("unavailable");
      return () => {
        active = false;
      };
    }
    setPayloadLoadMessage("");
    setPayloadLoadState("loading");
    void api.getSessionFilePreviewWindowPayload(token).then((nextPayload) => {
      if (active) {
        setPayload(nextPayload);
        setPayloadLoadState("ready");
      }
    }).catch((error) => {
      if (active) {
        setPayloadLoadState("error");
        setPayloadLoadMessage(error instanceof Error ? error.message : "File preview could not be loaded.");
      }
    });
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    if (!api) {
      return;
    }
    return api.subscribeSessionFilePreviewNavigation((nextPayload) => {
      setPayload((current) => (
        current && areFilePreviewPayloadsEqual(current, nextPayload)
          ? nextPayload
          : current
      ));
    });
  }, [api]);

  useEffect(() => {
    if (payload) {
      document.title = payload.windowTitle;
    }
  }, [payload]);

  useEffect(() => {
    let active = true;
    if (!api || !payload || "historyDiff" in payload || !isSessionFileRootResource(payload.resource)) {
      setDiffScopes([]);
      return () => {
        active = false;
      };
    }
    const resource = payload.resource;
    void api.listFileRootChanges({
      sessionId: resource.sessionId,
      rootId: resource.rootId,
    }).then((result) => {
      if (active) {
        setDiffScopes(projectFileRootDiffAvailability(result, resource.relativePath).scopes);
      }
    }).catch(() => {
      if (active) {
        setDiffScopes([]);
      }
    });
    return () => {
      active = false;
    };
  }, [api, payload]);

  const loadDiff = useCallback(async (scope: FileRootGitDiffScope): Promise<string | null> => {
    if (!api || !payload || "historyDiff" in payload || !isSessionFileRootResource(payload.resource)) {
      return "Git diff is not available for this file.";
    }
    const revision = diffRequestRevisionRef.current + 1;
    diffRequestRevisionRef.current = revision;
    setDiffLoadingScope(scope);
    try {
      const result = await api.getFileRootDiff({ ...payload.resource, scope });
      if (diffRequestRevisionRef.current !== revision) {
        return null;
      }
      if (result.status !== "ok") {
        return result.message;
      }
      setDiffState((current) => ({ scope, patch: result.patch, revision: (current?.revision ?? 0) + 1 }));
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "Git diff could not be loaded.";
    } finally {
      if (diffRequestRevisionRef.current === revision) {
        setDiffLoadingScope(null);
      }
    }
  }, [api, payload]);

  const showPreview = useCallback(() => {
    diffRequestRevisionRef.current += 1;
    setDiffLoadingScope(null);
    setDiffState(null);
    setNavigationMessage("");
    setPayload((current) => current && !("historyDiff" in current) && current.view?.kind === "diff"
      ? { ...current, view: { kind: "preview" } }
      : current);
  }, []);

  useEffect(() => {
    if (!payload || "historyDiff" in payload) {
      setDiffState(null);
      setDiffLoadingScope(null);
      setNavigationMessage("");
      return;
    }
    const view = payload.view ?? { kind: "preview" as const };
    if (view.kind === "diff") {
      let active = true;
      setDiffState(null);
      setNavigationMessage("");
      void loadDiff(view.scope).then((message) => {
        if (active) {
          setNavigationMessage(message ?? "");
        }
      });
      return () => {
        active = false;
      };
    } else {
      showPreview();
    }
  }, [loadDiff, payload, showPreview]);

  if (!isDesktopRuntime()) {
    return <main className="file-preview-window-page"><p>File preview must be opened from the desktop app.</p></main>;
  }
  if (payloadLoadState === "loading") {
    return <FilePreviewWindowLoading label="Loading file preview" />;
  }
  if (payloadLoadState === "error") {
    return (
      <main className="file-preview-window-page">
        <section className="panel empty-session-card" role="alert">
          <h2>File preview could not be loaded</h2>
          <p>{payloadLoadMessage || "Try opening the file again from the originating Session."}</p>
        </section>
      </main>
    );
  }
  if (payloadLoadState === "unavailable" || !api || !payload) {
    return (
      <main className="file-preview-window-page">
        <section className="panel empty-session-card">
          <h2>File preview is unavailable</h2>
          <p>Open the file again from the originating Session.</p>
        </section>
      </main>
    );
  }
  if ("historyDiff" in payload) {
    return (
      <main className="file-preview-window-page">
        <SessionDiffPreview
          title={formatHistoryDiffTitle(payload.historyDiff.request)}
          contextLabel={formatHistoryDiffContext(payload.historyDiff.request)}
          previewRevision={1}
          patch={payload.historyDiff.patch}
          onCopyText={(text) => void navigator.clipboard.writeText(text)}
        />
      </main>
    );
  }
  if (payload.view?.kind === "diff" && !diffState && !navigationMessage) {
    const loadingScope = payload.view.scope;
    return (
      <main className="file-preview-window-page">
        <SessionDiffPreview
          title={getSessionFileResourceDisplayPath(payload.resource)}
          previewRevision={0}
          patch=""
          loading
          backNavigation={{ label: "Back to preview", onBack: showPreview }}
          onCopyText={(text) => void navigator.clipboard.writeText(text)}
          onOpenPreview={async () => {
            showPreview();
            return null;
          }}
          onReload={() => loadDiff(loadingScope)}
          reloadPending={diffLoadingScope !== null}
        />
      </main>
    );
  }

  return (
    <main className="file-preview-window-page">
      {diffState ? (
        <SessionDiffPreview
          title={getSessionFileResourceDisplayPath(payload.resource)}
          previewRevision={diffState.revision}
          patch={diffState.patch}
          backNavigation={{ label: "Back to preview", onBack: showPreview }}
          onCopyText={(text) => void navigator.clipboard.writeText(text)}
          onOpenPreview={async () => {
            showPreview();
            return null;
          }}
          onReload={() => loadDiff(diffState.scope)}
          reloadPending={diffLoadingScope !== null}
        />
      ) : (
        <SessionFilePreview
          api={api}
          request={payload.resource}
          onCopyText={(text) => void navigator.clipboard.writeText(text)}
          diffScopes={diffScopes}
          diffAvailabilityMessage={navigationMessage}
          onOpenDiff={loadDiff}
          diffLoadingScope={diffLoadingScope}
        />
      )}
    </main>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";

import { getWithMateApi, isDesktopRuntime } from "./renderer-withmate-api.js";
import { SessionDiffPreview, SessionFilePreview } from "./file-explorer/SessionFilePreview.js";
import { projectFileRootDiffAvailability } from "./file-explorer/file-preview-utils.js";
import type {
  FileRootGitChangeScope,
  SessionFilePreviewWindowPayload,
} from "./file-explorer/file-explorer-contract.js";
import {
  areSessionFileResourcesEqual,
  getSessionFileResourceDisplayPath,
  isSessionFileRootResource,
} from "./file-explorer/file-explorer-contract.js";

type DiffState = {
  scope: FileRootGitChangeScope;
  patch: string;
  revision: number;
};

function getToken(): string {
  return new URLSearchParams(window.location.search).get("token")?.trim() ?? "";
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
  const [loadFinished, setLoadFinished] = useState(false);
  const [diffScopes, setDiffScopes] = useState<FileRootGitChangeScope[]>([]);
  const [diffState, setDiffState] = useState<DiffState | null>(null);
  const [diffLoadingScope, setDiffLoadingScope] = useState<FileRootGitChangeScope | null>(null);
  const [navigationMessage, setNavigationMessage] = useState("");
  const diffRequestRevisionRef = useRef(0);

  useEffect(() => {
    let active = true;
    const token = getToken();
    if (!api || !token) {
      setLoadFinished(true);
      return () => {
        active = false;
      };
    }
    void api.getSessionFilePreviewWindowPayload(token).then((nextPayload) => {
      if (active) {
        setPayload(nextPayload);
        setLoadFinished(true);
      }
    }).catch(() => {
      if (active) {
        setLoadFinished(true);
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
        current && areSessionFileResourcesEqual(current.resource, nextPayload.resource)
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
    if (!api || !payload || !isSessionFileRootResource(payload.resource)) {
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

  const loadDiff = useCallback(async (scope: FileRootGitChangeScope): Promise<string | null> => {
    if (!api || !payload || !isSessionFileRootResource(payload.resource)) {
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
    setPayload((current) => current?.view?.kind === "diff"
      ? { ...current, view: { kind: "preview" } }
      : current);
  }, []);

  useEffect(() => {
    if (!payload) {
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
    return <main className="file-preview-window-page"><p>File Preview must be opened from the desktop app.</p></main>;
  }
  if (!loadFinished) {
    return <FilePreviewWindowLoading label="Loading file preview" />;
  }
  if (!api || !payload) {
    return (
      <main className="file-preview-window-page">
        <section className="panel empty-session-card">
          <h2>No file is available to preview</h2>
          <p>Open the file again from the originating Session.</p>
        </section>
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
          backNavigation={{ label: "Back to Preview", onBack: showPreview }}
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
          backNavigation={{ label: "Back to Preview", onBack: showPreview }}
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

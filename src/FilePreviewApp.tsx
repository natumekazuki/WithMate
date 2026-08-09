import { useEffect, useState } from "react";

import { getWithMateApi, isDesktopRuntime } from "./renderer-withmate-api.js";
import { SessionDiffPreview, SessionFilePreview } from "./file-explorer/SessionFilePreview.js";
import { projectFileRootDiffAvailability } from "./file-explorer/file-preview-utils.js";
import type {
  FileRootGitChangeScope,
  SessionFilePreviewWindowPayload,
} from "./file-explorer/file-explorer-contract.js";
import {
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

export default function FilePreviewApp() {
  const api = getWithMateApi();
  const [payload, setPayload] = useState<SessionFilePreviewWindowPayload | null>(null);
  const [loadFinished, setLoadFinished] = useState(false);
  const [diffScopes, setDiffScopes] = useState<FileRootGitChangeScope[]>([]);
  const [diffState, setDiffState] = useState<DiffState | null>(null);
  const [diffLoadingScope, setDiffLoadingScope] = useState<FileRootGitChangeScope | null>(null);

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

  const loadDiff = async (scope: FileRootGitChangeScope): Promise<string | null> => {
    if (!api || !payload || !isSessionFileRootResource(payload.resource)) {
      return "Git diff is not available for this file.";
    }
    setDiffLoadingScope(scope);
    try {
      const result = await api.getFileRootDiff({ ...payload.resource, scope });
      if (result.status !== "ok") {
        return result.message;
      }
      setDiffState((current) => ({ scope, patch: result.patch, revision: (current?.revision ?? 0) + 1 }));
      return null;
    } finally {
      setDiffLoadingScope(null);
    }
  };

  if (!isDesktopRuntime()) {
    return <main className="file-preview-window-page"><p>File Preview must be opened from the desktop app.</p></main>;
  }
  if (!loadFinished) {
    return <main className="file-preview-window-page"><p>Loading preview…</p></main>;
  }
  if (!api || !payload) {
    return (
      <main className="file-preview-window-page">
        <section className="panel empty-session-card">
          <h2>No file is available to preview</h2>
          <p>Open the file again from the originating Session.</p>
          <button type="button" onClick={() => window.close()}>Close</button>
        </section>
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
          onClose={() => setDiffState(null)}
          closeLabel="Back to Preview"
          onCopyText={(text) => void navigator.clipboard.writeText(text)}
          onReload={() => loadDiff(diffState.scope)}
          reloadPending={diffLoadingScope !== null}
        />
      ) : (
        <SessionFilePreview
          api={api}
          request={payload.resource}
          onClose={() => window.close()}
          closeLabel="Close"
          onCopyText={(text) => void navigator.clipboard.writeText(text)}
          diffScopes={diffScopes}
          onOpenDiff={loadDiff}
          diffLoadingScope={diffLoadingScope}
        />
      )}
    </main>
  );
}

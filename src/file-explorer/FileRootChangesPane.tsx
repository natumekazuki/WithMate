import { useCallback, useEffect, useRef, useState } from "react";

import type { WithMateWindowApi } from "../withmate-window-api.js";
import {
  FileRootChangesGroup,
  type GitRootChanges,
} from "./FileRootChangesGroup.js";
import type {
  FileRootFileDiffRequest,
  FileRootChangesResult,
    FileRootGitChangeEntry,
    FileRootGitChangeScope,
  SessionFileRootResourceRequest,
} from "./file-explorer-contract.js";

type FileRootChangesApi = Pick<
  WithMateWindowApi,
  "listSessionFileRoots" | "listFileRootChanges"
>;

export type FileRootChangesPaneProps = {
  api: FileRootChangesApi | null;
  sessionId: string | null;
  enabled: boolean;
  rootsRevision: string;
  refreshRevision: number;
  onOpenFile: (
    request: SessionFileRootResourceRequest,
    openInWindow: boolean,
  ) => void | Promise<string | null>;
  onOpenDiff: (
    request: FileRootFileDiffRequest,
    openInWindow: boolean,
  ) => Promise<string | null>;
};

function directoryStateKey(rootId: string, scope: FileRootGitChangeScope, relativePath: string): string {
  return `${rootId}\u0000${scope}\u0000${relativePath}`;
}

export function FileRootChangesPane({
  api,
  sessionId,
  enabled,
  rootsRevision,
  refreshRevision,
  onOpenFile,
  onOpenDiff,
}: FileRootChangesPaneProps) {
  const requestRevisionRef = useRef(0);
  const diffRevisionRef = useRef(0);
  const rootChangesSessionIdRef = useRef<string | null>(null);
  const [rootChanges, setRootChanges] = useState<GitRootChanges[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingKey, setLoadingKey] = useState("");
  const [message, setMessage] = useState("");
  const [collapsedDirectories, setCollapsedDirectories] = useState<Record<string, boolean>>({});

  const reload = useCallback(async () => {
    const revision = requestRevisionRef.current + 1;
    requestRevisionRef.current = revision;
    if (!api || !sessionId || !enabled) {
      rootChangesSessionIdRef.current = sessionId;
      setRootChanges([]);
      setLoading(false);
      setMessage("");
      return;
    }
    if (rootChangesSessionIdRef.current !== sessionId) {
      rootChangesSessionIdRef.current = sessionId;
      setRootChanges([]);
    }
    setLoading(true);
    setMessage("");
    try {
      const roots = await api.listSessionFileRoots(sessionId);
      const nextRootChanges: GitRootChanges[] = [];
      for (const root of roots) {
        if (requestRevisionRef.current !== revision) {
          return;
        }
        let result: FileRootChangesResult;
        try {
          result = await api.listFileRootChanges({ sessionId, rootId: root.id });
        } catch (error) {
          if (requestRevisionRef.current !== revision) {
            return;
          }
          nextRootChanges.push({
            root,
            entries: [],
            message: error instanceof Error ? error.message : "Git status failed.",
          });
          continue;
        }
        if (requestRevisionRef.current !== revision) {
          return;
        }
        if (result.status === "ok") {
          nextRootChanges.push({ root, entries: result.entries, message: "" });
        } else if (result.status === "failed") {
          nextRootChanges.push({ root, entries: [], message: result.message });
        }
      }
      if (requestRevisionRef.current === revision) {
        setRootChanges(nextRootChanges);
      }
    } catch (error) {
      if (requestRevisionRef.current === revision) {
        setMessage(error instanceof Error ? error.message : "Git status failed.");
      }
    } finally {
      if (requestRevisionRef.current === revision) {
        setLoading(false);
      }
    }
  }, [api, enabled, sessionId]);

  useEffect(() => {
    void reload();
    return () => {
      requestRevisionRef.current += 1;
      diffRevisionRef.current += 1;
    };
  }, [refreshRevision, reload, rootsRevision]);

  useEffect(() => {
    setCollapsedDirectories({});
  }, [rootsRevision, sessionId]);

  const toggleDirectory = (rootId: string, scope: FileRootGitChangeScope, relativePath: string) => {
    const key = directoryStateKey(rootId, scope, relativePath);
    setCollapsedDirectories((current) => ({ ...current, [key]: !current[key] }));
  };

  const openEntry = async (
    rootId: string,
    entry: FileRootGitChangeEntry,
    scope: FileRootGitChangeScope,
    openInWindow: boolean,
  ) => {
    if (!api || !sessionId) {
      return;
    }
    if (entry.kinds[scope] === "untracked") {
      setMessage("");
      try {
        const resultMessage = await onOpenFile(
          { sessionId, rootId, relativePath: entry.relativePath },
          openInWindow,
        );
        if (resultMessage) {
          setMessage(resultMessage);
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "The file preview could not be opened.");
      }
      return;
    }
    if (scope === "commit") {
      return;
    }
    const request = { sessionId, rootId, relativePath: entry.relativePath, scope };
    const key = `${rootId}:${scope}:${entry.relativePath}`;
    const revision = diffRevisionRef.current + 1;
    diffRevisionRef.current = revision;
    setLoadingKey(key);
    setMessage("");
    try {
      const resultMessage = await onOpenDiff(request, openInWindow);
      if (diffRevisionRef.current !== revision) {
        return;
      }
      if (resultMessage) {
        setMessage(resultMessage);
      }
    } catch (error) {
      if (diffRevisionRef.current === revision) {
        setMessage(error instanceof Error ? error.message : "Git diff failed.");
      }
    } finally {
      if (diffRevisionRef.current === revision) {
        setLoadingKey("");
      }
    }
  };

  return (
    <div className="workspace-changes-pane" aria-busy={loading}>
      {message ? <p className="workspace-changes-message" role="alert">{message}</p> : null}
      {loading ? (
        <div
          className="workspace-changes-loading"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="workspace-changes-spinner" aria-hidden="true" />
          <span className="visually-hidden">
            {rootChanges.length > 0 ? "Refreshing changes" : "Loading changes"}
          </span>
        </div>
      ) : null}
      {rootChanges.length > 0 ? (
        <div className="workspace-changes-groups" role="list" aria-label="File root changes">
          {rootChanges.map((rootChange) => (
            <FileRootChangesGroup
              key={`${sessionId ?? ""}:${rootChange.root.id}`}
              rootChange={rootChange}
              groupCount={rootChanges.length}
              collapsedDirectories={collapsedDirectories}
              loadingKey={loadingKey}
              onToggleDirectory={toggleDirectory}
              onOpenEntry={openEntry}
            />
          ))}
        </div>
      ) : !loading && !message ? (
        <p className="workspace-changes-empty">No Git repositories.</p>
      ) : null}
    </div>
  );
}

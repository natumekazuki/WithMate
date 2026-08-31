import { useCallback, useEffect, useRef, useState } from "react";

import type { WithMateWindowApi } from "../withmate-window-api.js";
import {
  FileRootChangesGroup,
  type GitRootChanges,
} from "./FileRootChangesGroup.js";
import type {
  FileRootFileDiffRequest,
  FileRootGitChangeEntry,
  FileRootGitChangeScope,
  SessionFileRoot,
  SessionFileRootResourceRequest,
} from "./file-explorer-contract.js";

type FileRootChangesApi = Pick<
  WithMateWindowApi,
  "listFileRootChanges" | "listFileRootChangesRepositories"
>;

export type FileRootChangesPaneProps = {
  api: FileRootChangesApi | null;
  sessionId: string | null;
  enabled: boolean;
  roots: SessionFileRoot[];
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

function createUnloadedRootChanges(roots: SessionFileRoot[]): GitRootChanges[] {
  return roots.map((root) => ({
    root,
    status: "idle",
    entries: [],
    message: "",
  }));
}

export function FileRootChangesPane({
  api,
  sessionId,
  enabled,
  roots,
  rootsRevision,
  refreshRevision,
  onOpenFile,
  onOpenDiff,
}: FileRootChangesPaneProps) {
  const requestRevisionRef = useRef(0);
  const repositoryRequestRevisionRef = useRef(0);
  const repositoryRootsRef = useRef<SessionFileRoot[]>([]);
  const repositoriesReadyRef = useRef(false);
  const lastRefreshRevisionRef = useRef(refreshRevision);
  const diffRevisionRef = useRef(0);
  const [rootChanges, setRootChanges] = useState<GitRootChanges[]>([]);
  const [repositoriesLoading, setRepositoriesLoading] = useState(false);
  const [repositoriesReady, setRepositoriesReady] = useState(false);
  const [repositoryMessage, setRepositoryMessage] = useState("");
  const [loadingKey, setLoadingKey] = useState("");
  const [message, setMessage] = useState("");
  const [collapsedDirectories, setCollapsedDirectories] = useState<Record<string, boolean>>({});

  const refresh = useCallback(() => {
    const revision = requestRevisionRef.current + 1;
    requestRevisionRef.current = revision;
    if (!api || !sessionId || !enabled) {
      return;
    }
    setMessage("");
    const repositoryRoots = repositoryRootsRef.current;
    setRootChanges((current) => repositoryRoots.map((root) => {
      const existing = current.find((rootChange) => rootChange.root.id === root.id);
      return {
        root,
        status: "pending",
        entries: existing?.entries ?? [],
        message: "",
      };
    }));

    for (const root of repositoryRoots) {
      void api.listFileRootChanges({ sessionId, rootId: root.id }).then((result) => {
        if (requestRevisionRef.current !== revision) {
          return;
        }
        setRootChanges((current) => {
          if (result.status === "not-git" || result.status === "root-not-found") {
            return current.filter((rootChange) => rootChange.root.id !== root.id);
          }
          return current.map((rootChange) => {
            if (rootChange.root.id !== root.id) {
              return rootChange;
            }
            if (result.status === "ok") {
              return {
                ...rootChange,
                status: result.entries.length > 0 ? "success" : "empty",
                entries: result.entries,
                message: "",
              };
            }
            return {
              ...rootChange,
              status: "failed",
              message: result.message,
            };
          });
        });
      }).catch((error) => {
        if (requestRevisionRef.current !== revision) {
          return;
        }
        setRootChanges((current) => current.map((rootChange) => rootChange.root.id === root.id
          ? {
              ...rootChange,
              status: "failed",
              message: error instanceof Error ? error.message : "Git status failed.",
            }
          : rootChange));
      });
    }
  }, [api, enabled, sessionId]);

  const discoverRepositories = useCallback(async () => {
    const revision = repositoryRequestRevisionRef.current + 1;
    repositoryRequestRevisionRef.current = revision;
    requestRevisionRef.current += 1;
    repositoryRootsRef.current = [];
    setRootChanges([]);
    setRepositoryMessage("");
    repositoriesReadyRef.current = false;
    setRepositoriesReady(false);
    if (!api || !sessionId || !enabled || roots.length === 0) {
      setRepositoriesLoading(false);
      repositoriesReadyRef.current = true;
      setRepositoriesReady(true);
      return;
    }
    setRepositoriesLoading(true);
    try {
      const result = await api.listFileRootChangesRepositories({
        sessionId,
        rootIds: roots.map((root) => root.id),
      });
      if (repositoryRequestRevisionRef.current !== revision) {
        return;
      }
      if (result.status === "failed") {
        setRepositoryMessage(result.message);
        return;
      }
      const repositoryRootIds = new Set(result.repositories.map((repository) => repository.rootId));
      const failuresByRootId = new Map(result.failures.map((failure) => [failure.rootId, failure.message]));
      const nextRootChanges = roots.flatMap<GitRootChanges>((root) => {
        if (repositoryRootIds.has(root.id)) {
          return createUnloadedRootChanges([root]);
        }
        const failureMessage = failuresByRootId.get(root.id);
        return failureMessage
          ? [{ root, status: "failed", entries: [], message: failureMessage }]
          : [];
      });
      repositoryRootsRef.current = nextRootChanges.map((rootChange) => rootChange.root);
      setRootChanges(nextRootChanges);
    } catch (error) {
      if (repositoryRequestRevisionRef.current === revision) {
        setRepositoryMessage(error instanceof Error ? error.message : "Git repositories could not be resolved.");
      }
    } finally {
      if (repositoryRequestRevisionRef.current === revision) {
        setRepositoriesLoading(false);
        repositoriesReadyRef.current = true;
        setRepositoriesReady(true);
      }
    }
  }, [api, enabled, roots, sessionId]);

  useEffect(() => {
    diffRevisionRef.current += 1;
    setMessage("");
    setLoadingKey("");
    setCollapsedDirectories({});
    void discoverRepositories();
  }, [discoverRepositories, rootsRevision]);

  useEffect(() => {
    if (lastRefreshRevisionRef.current === refreshRevision) {
      return;
    }
    if (!repositoriesReadyRef.current) {
      return;
    }
    lastRefreshRevisionRef.current = refreshRevision;
    refresh();
  }, [refresh, refreshRevision, repositoriesReady]);

  useEffect(() => {
    return () => {
      requestRevisionRef.current += 1;
      repositoryRequestRevisionRef.current += 1;
      diffRevisionRef.current += 1;
    };
  }, []);

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
    <div className="workspace-changes-pane">
      {repositoryMessage ? <p className="workspace-changes-message" role="alert">{repositoryMessage}</p> : null}
      {message ? <p className="workspace-changes-message" role="alert">{message}</p> : null}
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
      ) : repositoriesLoading ? (
        <div className="workspace-changes-discovery-loading" role="status" aria-live="polite">
          <span className="workspace-changes-spinner" aria-hidden="true" />
          <span className="visually-hidden">Discovering Git repositories</span>
        </div>
      ) : !message && !repositoryMessage ? (
        <p className="workspace-changes-empty">No Git repositories.</p>
      ) : null}
    </div>
  );
}

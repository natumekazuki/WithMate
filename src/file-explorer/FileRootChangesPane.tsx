import { useCallback, useEffect, useRef, useState } from "react";

import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
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
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";

type FileRootChangesApi = Pick<
  WithMateWindowApi,
  "listFileRootChanges" | "listFileRootChangesRepositories"
>;

export type FileRootChangesPaneProps = {
  api: FileRootChangesApi | null;
  sessionId: string | null;
  enabled: boolean;
  visible?: boolean;
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

const MAX_CONCURRENT_FILE_ROOT_CHANGES_REQUESTS = 2;

type RepositoryDiscoveryState = "pending" | "ready" | "unavailable" | "error";

type ChangesRefreshQueue = {
  revision: number;
  sessionId: string;
  roots: SessionFileRoot[];
  nextIndex: number;
};

export function FileRootChangesPane({
  api,
  sessionId,
  enabled,
  visible = true,
  roots,
  rootsRevision,
  refreshRevision,
  onOpenFile,
  onOpenDiff,
}: FileRootChangesPaneProps) {
  const rootsKey = JSON.stringify(roots.map((root) => [root.id, root.displayPath]));
  const requestRevisionRef = useRef(0);
  const refreshQueueRef = useRef<ChangesRefreshQueue | null>(null);
  const activeRefreshRequestsRef = useRef(0);
  const refreshingRef = useRef(false);
  const refreshPendingRef = useRef(false);
  const drainRefreshQueueRef = useRef<() => void>(() => undefined);
  const refreshRef = useRef<() => void>(() => undefined);
  const currentRef = useRef({ api, sessionId, enabled, visible, roots });
  currentRef.current = { api, sessionId, enabled, visible, roots };
  const ownerRef = useRef({ api, sessionId, enabled, roots });
  const diffRevisionRef = useRef(0);
  const [rootChanges, setRootChanges] = useState<GitRootChanges[]>([]);
  const [repositoriesLoading, setRepositoriesLoading] = useState(false);
  const [repositoryDiscoveryState, setRepositoryDiscoveryState] = useState<RepositoryDiscoveryState>("unavailable");
  const [repositoryMessage, setRepositoryMessage] = useState("");
  const [loadingKey, setLoadingKey] = useState("");
  const [message, setMessage] = useState("");
  const [collapsedDirectories, setCollapsedDirectories] = useState<Record<string, boolean>>({});

  const finishRefresh = useCallback(() => {
    refreshingRef.current = false;
    refreshQueueRef.current = null;
    if (refreshPendingRef.current) {
      refreshRef.current();
    }
  }, []);

  const drainRefreshQueue = useCallback(() => {
    const { api: currentApi, sessionId: currentSessionId, enabled: available, visible: active } = currentRef.current;
    const queue = refreshQueueRef.current;
    if (!currentApi || !currentSessionId || !available || !active || !queue || queue.sessionId !== currentSessionId) {
      return;
    }
    while (
      activeRefreshRequestsRef.current < MAX_CONCURRENT_FILE_ROOT_CHANGES_REQUESTS
      && queue.nextIndex < queue.roots.length
    ) {
      const root = queue.roots[queue.nextIndex];
      queue.nextIndex += 1;
      activeRefreshRequestsRef.current += 1;
      void currentApi.listFileRootChanges({ sessionId: currentSessionId, rootId: root.id }).then((result) => {
        if (requestRevisionRef.current !== queue.revision) {
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
            return { ...rootChange, status: "failed", message: result.message };
          });
        });
      }).catch((error) => {
        if (requestRevisionRef.current === queue.revision) {
          setRootChanges((current) => current.map((rootChange) => rootChange.root.id === root.id
            ? { ...rootChange, status: "failed", message: error instanceof Error ? error.message : "Git status failed." }
            : rootChange));
        }
      }).finally(() => {
        activeRefreshRequestsRef.current -= 1;
        drainRefreshQueueRef.current();
      });
    }
    if (queue.nextIndex === queue.roots.length && activeRefreshRequestsRef.current === 0) {
      finishRefresh();
    }
  }, [finishRefresh]);
  drainRefreshQueueRef.current = drainRefreshQueue;

  const refresh = useCallback(() => {
    const { api: currentApi, sessionId: currentSessionId, enabled: available, visible: active, roots: currentRoots } = currentRef.current;
    refreshPendingRef.current = true;
    if (!currentApi || !currentSessionId || !available || !active || refreshingRef.current) {
      return;
    }
    refreshPendingRef.current = false;
    refreshingRef.current = true;
    const revision = requestRevisionRef.current;
    setRepositoryMessage("");
    if (currentRoots.length === 0) {
      setRootChanges([]);
      setRepositoryDiscoveryState("ready");
      finishRefresh();
      return;
    }
    setRepositoriesLoading(true);
    setRepositoryDiscoveryState("pending");
    void currentApi.listFileRootChangesRepositories({
      sessionId: currentSessionId,
      rootIds: currentRoots.map((root) => root.id),
    }).then((result) => {
      if (requestRevisionRef.current !== revision) {
        return;
      }
      if (result.status === "failed") {
        setRepositoryDiscoveryState("error");
        setRepositoryMessage(result.message);
        finishRefresh();
        return;
      }
      const repositoryIds = new Set(result.repositories.map((repository) => repository.rootId));
      const failures = new Map(result.failures.map((failure) => [failure.rootId, failure.message]));
      setRootChanges((current) => currentRoots.flatMap<GitRootChanges>((root) => {
        const existing = current.find((item) => item.root.id === root.id);
        if (repositoryIds.has(root.id)) {
          return [{ root, status: "pending", entries: existing?.entries ?? [], message: "" }];
        }
        const failure = failures.get(root.id);
        return failure ? [{ root, status: "failed", entries: existing?.entries ?? [], message: failure }] : [];
      }));
      refreshQueueRef.current = {
        revision,
        sessionId: currentSessionId,
        roots: currentRoots.filter((root) => repositoryIds.has(root.id)),
        nextIndex: 0,
      };
      setRepositoryDiscoveryState("ready");
      drainRefreshQueueRef.current();
    }).catch((error) => {
      if (requestRevisionRef.current === revision) {
        setRepositoryDiscoveryState("error");
        setRepositoryMessage(error instanceof Error ? error.message : "Git repositories could not be resolved.");
        finishRefresh();
      }
    }).finally(() => {
      if (requestRevisionRef.current === revision) {
        setRepositoriesLoading(false);
      }
    });
  }, [finishRefresh]);
  refreshRef.current = refresh;

  useEffect(() => {
    const previous = ownerRef.current;
    const sameOwner = previous.api === api && previous.sessionId === sessionId && previous.enabled === enabled;
    const retainedRootIds = new Set(roots.filter((root) => sameOwner && previous.roots.some(
      (prior) => prior.id === root.id && prior.displayPath === root.displayPath,
    )).map((root) => root.id));
    ownerRef.current = { api, sessionId, enabled, roots };
    requestRevisionRef.current += 1;
    diffRevisionRef.current += 1;
    refreshQueueRef.current = null;
    refreshingRef.current = false;
    refreshPendingRef.current = false;
    setRootChanges((current) => current.filter((item) => retainedRootIds.has(item.root.id)));
    setRepositoryMessage("");
    setRepositoriesLoading(false);
    setRepositoryDiscoveryState("unavailable");
    setMessage("");
    setLoadingKey("");
    setCollapsedDirectories((current) => Object.fromEntries(
      Object.entries(current).filter(([key]) => retainedRootIds.has(key.split("\u0000")[0])),
    ));
    return () => {
      requestRevisionRef.current += 1;
      diffRevisionRef.current += 1;
      refreshQueueRef.current = null;
      refreshingRef.current = false;
      refreshPendingRef.current = false;
    };
  }, [api, sessionId, enabled, rootsRevision, rootsKey]);

  useEffect(() => {
    if (visible) {
      // Resume an unfinished queue first; activation is coalesced into one trailing refresh.
      refresh();
      drainRefreshQueueRef.current();
    }
  }, [api, sessionId, enabled, rootsRevision, rootsKey, visible, refreshRevision, refresh]);

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
      const resultMessage = entry.kinds[scope] === "untracked"
        ? await onOpenFile(
            { sessionId, rootId, relativePath: entry.relativePath },
            openInWindow,
          )
        : await onOpenDiff(request, openInWindow);
      if (diffRevisionRef.current !== revision) {
        return;
      }
      if (resultMessage) {
        setMessage(resultMessage);
      }
    } catch (error) {
      if (diffRevisionRef.current === revision) {
        setMessage(error instanceof Error
          ? error.message
          : entry.kinds[scope] === "untracked"
            ? "The file preview could not be opened."
            : "Git diff failed.");
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
              preserveScrollAnchor
              groupCount={rootChanges.length}
              collapsedDirectories={collapsedDirectories}
              loadingKey={loadingKey}
              onToggleDirectory={toggleDirectory}
              onOpenEntry={openEntry}
            />
          ))}
        </div>
      ) : repositoriesLoading || repositoryDiscoveryState === "pending" ? (
        <div
          className="workspace-changes-discovery-loading"
        >
          <LoadingIndicator label="Discovering Git repositories" />
        </div>
      ) : repositoryDiscoveryState === "error" && !message && !repositoryMessage ? (
        <p className="workspace-changes-message" role="alert">Changes could not be loaded.</p>
      ) : null}
    </div>
  );
}

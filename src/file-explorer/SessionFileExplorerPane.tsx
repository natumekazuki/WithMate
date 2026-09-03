import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type {
  SessionDirectoryEntry,
  SessionFileRootResourceRequest,
  SessionFileRoot,
} from "./file-explorer-contract.js";
import type { WithMateWindowApi } from "../withmate-window-api.js";

type FileExplorerApi = Pick<
  WithMateWindowApi,
  | "listSessionFileRoots"
  | "listSessionDirectory"
  | "showSessionFileTreeContextMenu"
>;

type SessionFileExplorerPaneProps = {
  api: FileExplorerApi | null;
  sessionId: string | null;
  enabled: boolean;
  rootsRevision: string;
  selectedFile: SessionFileRootResourceRequest | null;
  activeTab: "files" | "changes" | "history";
  onActiveTabChange: (tab: "files" | "changes" | "history") => void;
  onRefreshChanges: () => void;
  onRefreshHistory?: () => void;
  onOpenFile: (request: SessionFileRootResourceRequest, openInWindow: boolean) => void;
  canInsertPathReference: boolean;
  onInsertPathReference: (ownerSessionId: string, absolutePath: string) => void;
  renderChangesContent?: (roots: SessionFileRoot[]) => ReactNode;
  historyContent?: ReactNode;
};

type FileTreeRow =
  | { kind: "root"; root: SessionFileRoot; depth: number }
  | { kind: "entry"; rootId: string; entry: SessionDirectoryEntry; depth: number }
  | { kind: "status"; id: string; label: string; depth: number };

type DirectoryLoadRequest = {
  revision: number;
  requestId: number;
  promise: Promise<void>;
};

type FileTreeInsertionOwnerSnapshot = {
  sessionId: string | null;
  rootsRevision: string;
  canInsert: boolean;
  insertPathReference: (ownerSessionId: string, absolutePath: string) => void;
};

export function applySessionFileTreePathInsertionResult(input: {
  result: { status: string; ownerSessionId?: string; absolutePath?: string };
  currentOwnerSessionId: string | null;
  requestedRootsRevision: string;
  currentRootsRevision: string;
  canInsert: boolean;
  insertPathReference: (ownerSessionId: string, absolutePath: string) => void;
}): boolean {
  if (
    input.result.status !== "insert-path"
    || input.result.ownerSessionId !== input.currentOwnerSessionId
    || input.requestedRootsRevision !== input.currentRootsRevision
    || !input.canInsert
    || !input.result.absolutePath
  ) {
    return false;
  }
  input.insertPathReference(input.result.ownerSessionId, input.result.absolutePath);
  return true;
}

function directoryKey(rootId: string, relativePath: string): string {
  return `${rootId}\u0000${relativePath}`;
}

function entryIcon(entry: SessionDirectoryEntry): string {
  if (entry.kind === "directory") {
    return "▸";
  }
  if (entry.kind === "symbolic-link") {
    return "↗";
  }
  return "·";
}

export function SessionFileExplorerPane({
  api,
  sessionId,
  enabled,
  rootsRevision,
  selectedFile,
  activeTab,
  onActiveTabChange,
  onRefreshChanges,
  onRefreshHistory,
  onOpenFile,
  canInsertPathReference,
  onInsertPathReference,
  renderChangesContent,
  historyContent,
}: SessionFileExplorerPaneProps) {
  const insertionOwnerSnapshotRef = useRef<FileTreeInsertionOwnerSnapshot>({
    sessionId,
    rootsRevision,
    canInsert: canInsertPathReference,
    insertPathReference: onInsertPathReference,
  });
  useLayoutEffect(() => {
    insertionOwnerSnapshotRef.current = {
      sessionId,
      rootsRevision,
      canInsert: canInsertPathReference,
      insertPathReference: onInsertPathReference,
    };
  }, [canInsertPathReference, onInsertPathReference, rootsRevision, sessionId]);
  const loadRevisionRef = useRef(0);
  const directoryRequestSequenceRef = useRef(0);
  const inFlightDirectoryLoadsRef = useRef(new Map<string, DirectoryLoadRequest>());
  const latestDirectoryRequestsRef = useRef(new Map<string, Pick<DirectoryLoadRequest, "revision" | "requestId">>());
  const [roots, setRoots] = useState<SessionFileRoot[]>([]);
  const [entriesByDirectory, setEntriesByDirectory] = useState<Record<string, SessionDirectoryEntry[]>>({});
  const entriesByDirectoryRef = useRef(entriesByDirectory);
  const [expandedDirectories, setExpandedDirectories] = useState<Record<string, boolean>>({});
  const expandedDirectoriesRef = useRef(expandedDirectories);
  const [loadingDirectories, setLoadingDirectories] = useState<Record<string, boolean>>({});
  const [errorMessage, setErrorMessage] = useState("");
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const tabPanelId = useId();
  const tabOwnerKey = `${sessionId ?? ""}\u0000${rootsRevision}`;
  const [mountedTabState, setMountedTabState] = useState(() => ({
    ownerKey: tabOwnerKey,
    changes: activeTab === "changes",
    history: activeTab === "history",
  }));
  const mountedTabs = mountedTabState.ownerKey === tabOwnerKey
    ? mountedTabState
    : {
        ownerKey: tabOwnerKey,
        changes: activeTab === "changes",
        history: activeTab === "history",
      };

  useEffect(() => {
    setMountedTabState((current) => {
      const next = current.ownerKey === tabOwnerKey
        ? current
        : {
            ownerKey: tabOwnerKey,
            changes: activeTab === "changes",
            history: activeTab === "history",
          };
      if (activeTab === "files" || next[activeTab]) {
        return next;
      }
      return { ...next, [activeTab]: true };
    });
  }, [activeTab, tabOwnerKey]);

  const loadDirectory = useCallback((rootId: string, relativePath: string, revision: number): Promise<void> => {
    if (!api || !sessionId) {
      return Promise.resolve();
    }
    const key = directoryKey(rootId, relativePath);
    const existing = inFlightDirectoryLoadsRef.current.get(key);
    if (existing?.revision === revision) {
      return existing.promise;
    }
    const requestId = directoryRequestSequenceRef.current + 1;
    directoryRequestSequenceRef.current = requestId;
    latestDirectoryRequestsRef.current.set(key, { revision, requestId });
    setLoadingDirectories((current) => ({ ...current, [key]: true }));
    let request!: DirectoryLoadRequest;
    const promise = Promise.resolve().then(async () => {
      const isCurrentRequest = () => {
        const latest = latestDirectoryRequestsRef.current.get(key);
        return loadRevisionRef.current === revision && latest?.revision === revision && latest.requestId === requestId;
      };
      try {
        const entries = await api.listSessionDirectory({ sessionId, rootId, relativePath });
        if (!isCurrentRequest()) {
          return;
        }
        setEntriesByDirectory((current) => {
          const next = { ...current, [key]: entries };
          entriesByDirectoryRef.current = next;
          return next;
        });
        setErrorMessage("");
      } catch (error) {
        if (isCurrentRequest()) {
          setErrorMessage(error instanceof Error ? error.message : "Directory を読み込めなかったよ。");
        }
      } finally {
        if (isCurrentRequest()) {
          setLoadingDirectories((current) => ({ ...current, [key]: false }));
        }
        if (inFlightDirectoryLoadsRef.current.get(key) === request) {
          inFlightDirectoryLoadsRef.current.delete(key);
        }
      }
    });
    request = { revision, requestId, promise };
    inFlightDirectoryLoadsRef.current.set(key, request);
    return promise;
  }, [api, sessionId]);

  const reloadRoots = useCallback(async () => {
    const revision = loadRevisionRef.current + 1;
    loadRevisionRef.current = revision;
    inFlightDirectoryLoadsRef.current.clear();
    latestDirectoryRequestsRef.current.clear();
    setRoots([]);
    setEntriesByDirectory({});
    entriesByDirectoryRef.current = {};
    setExpandedDirectories({});
    expandedDirectoriesRef.current = {};
    setLoadingDirectories({});
    setErrorMessage("");
    setFeedbackMessage("");
    if (!api || !sessionId || !enabled) {
      return;
    }
    try {
      const nextRoots = await api.listSessionFileRoots(sessionId);
      if (loadRevisionRef.current !== revision) {
        return;
      }
      setRoots(nextRoots);
    } catch (error) {
      if (loadRevisionRef.current === revision) {
        setErrorMessage(error instanceof Error ? error.message : "File roots を読み込めなかったよ。");
      }
    }
  }, [api, enabled, sessionId]);

  useEffect(() => {
    void reloadRoots();
    return () => {
      loadRevisionRef.current += 1;
    };
  }, [reloadRoots, rootsRevision]);

  const toggleDirectory = (rootId: string, relativePath: string) => {
    const key = directoryKey(rootId, relativePath);
    const shouldExpand = !expandedDirectoriesRef.current[key];
    const nextExpandedDirectories = { ...expandedDirectoriesRef.current, [key]: shouldExpand };
    expandedDirectoriesRef.current = nextExpandedDirectories;
    setExpandedDirectories(nextExpandedDirectories);
    if (!shouldExpand) {
      return;
    }
    if (!entriesByDirectoryRef.current[key]) {
      void loadDirectory(rootId, relativePath, loadRevisionRef.current);
    }
  };

  const showPathContextMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    target: { rootId: string; relativePath: string; nodeKind: "root" | "directory" | "file" },
  ) => {
    if (!api || !sessionId) {
      return;
    }
    event.preventDefault();
    const requestedRootsRevision = rootsRevision;
    void api.showSessionFileTreeContextMenu({
      sessionId,
      ...target,
      canInsert: canInsertPathReference,
      point: {
        x: Math.max(0, Math.round(event.clientX)),
        y: Math.max(0, Math.round(event.clientY)),
      },
    }).then((result) => {
      if (result.status === "failed") {
        setFeedbackMessage(result.message);
        return;
      }
      const currentInsertionOwner = insertionOwnerSnapshotRef.current;
      applySessionFileTreePathInsertionResult({
        result,
        currentOwnerSessionId: currentInsertionOwner.sessionId,
        requestedRootsRevision,
        currentRootsRevision: currentInsertionOwner.rootsRevision,
        canInsert: currentInsertionOwner.canInsert,
        insertPathReference: currentInsertionOwner.insertPathReference,
      });
    }).catch(() => {
      setFeedbackMessage("Path menu could not be opened.");
    });
  };

  const treeRows = useMemo(() => {
    const rows: FileTreeRow[] = [];
    const appendDirectory = (rootId: string, relativePath: string, depth: number) => {
      const key = directoryKey(rootId, relativePath);
      if (!expandedDirectories[key]) {
        return;
      }
      if (loadingDirectories[key] && !entriesByDirectory[key]) {
        rows.push({ kind: "status", id: `${key}\u0000loading`, label: "Loading…", depth });
        return;
      }
      for (const entry of entriesByDirectory[key] ?? []) {
        rows.push({ kind: "entry", rootId, entry, depth });
        if (entry.kind === "directory") {
          appendDirectory(rootId, entry.relativePath, depth + 1);
        }
      }
    };
    for (const root of roots) {
      rows.push({ kind: "root", root, depth: 0 });
      appendDirectory(root.id, "", 1);
    }
    return rows;
  }, [entriesByDirectory, expandedDirectories, loadingDirectories, roots]);
  const treeVirtualizer = useVirtualizer({
    count: treeRows.length,
    getScrollElement: () => treeScrollRef.current,
    estimateSize: () => 31,
    overscan: 18,
    useFlushSync: false,
  });

  return (
    <aside className="session-file-explorer" aria-label="File Explorer">
      <div className="session-file-explorer-header">
        <div className="session-file-explorer-tabs" role="tablist" aria-label="File Explorer view">
          <button
            id={`${tabPanelId}-files-tab`}
            className={activeTab === "files" ? "is-active" : ""}
            type="button"
            role="tab"
            aria-selected={activeTab === "files"}
            aria-controls={`${tabPanelId}-files-panel`}
            onClick={() => onActiveTabChange("files")}
          >
            Files
          </button>
          <button
            id={`${tabPanelId}-changes-tab`}
            className={activeTab === "changes" ? "is-active" : ""}
            type="button"
            role="tab"
            aria-selected={activeTab === "changes"}
            aria-controls={`${tabPanelId}-changes-panel`}
            onClick={() => onActiveTabChange("changes")}
          >
            Changes
          </button>
          <button
            id={`${tabPanelId}-history-tab`}
            className={activeTab === "history" ? "is-active" : ""}
            type="button"
            role="tab"
            aria-selected={activeTab === "history"}
            aria-controls={`${tabPanelId}-history-panel`}
            onClick={() => onActiveTabChange("history")}
          >
            History
          </button>
        </div>
        <button
          className="session-file-explorer-refresh"
          type="button"
          onClick={() => {
            if (activeTab === "changes") {
              onRefreshChanges();
              return;
            }
            if (activeTab === "history") {
              onRefreshHistory?.();
              return;
            }
            void reloadRoots();
          }}
          aria-label={activeTab === "changes" ? "Refresh changes" : activeTab === "history" ? "Refresh history" : "Refresh files"}
          title={activeTab === "changes" ? "Refresh changes" : activeTab === "history" ? "Refresh history" : "Refresh files"}
        >
          ↻
        </button>
      </div>

      <div
        ref={treeScrollRef}
        id={`${tabPanelId}-files-panel`}
        className="session-file-explorer-body"
        role="tabpanel"
        aria-labelledby={`${tabPanelId}-files-tab`}
        hidden={activeTab !== "files"}
      >
        {errorMessage ? <p className="session-file-tree-error">{errorMessage}</p> : null}
        {feedbackMessage ? (
          <p className="session-file-tree-feedback" role="status" aria-live="polite">{feedbackMessage}</p>
        ) : null}
        {!errorMessage && roots.length === 0 ? <p className="session-file-tree-empty">Loading roots…</p> : null}
        <div className="session-file-tree-virtual" style={{ height: treeVirtualizer.getTotalSize() }}>
          {treeVirtualizer.getVirtualItems().map((virtualRow) => {
            const row = treeRows[virtualRow.index];
            if (!row) {
              return null;
            }
            const rowKey = row.kind === "root"
              ? `root:${row.root.id}`
              : row.kind === "entry"
                ? `entry:${directoryKey(row.rootId, row.entry.relativePath)}`
                : row.id;
            return (
              <div
                className="session-file-tree-virtual-row"
                key={rowKey}
                style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
              >
                {row.kind === "status" ? (
                  <div className="session-file-tree-status" style={{ paddingLeft: `${10 + row.depth * 14}px` }}>{row.label}</div>
                ) : row.kind === "root" ? (
                  <button
                    className="session-file-root-row"
                    type="button"
                    onClick={() => toggleDirectory(row.root.id, "")}
                    onContextMenu={(event) => showPathContextMenu(event, {
                      rootId: row.root.id,
                      relativePath: "",
                      nodeKind: "root",
                    })}
                    title={row.root.displayPath}
                  >
                    <span className={`session-file-tree-icon${expandedDirectories[directoryKey(row.root.id, "")] ? " is-expanded" : ""}`}>▸</span>
                    <span className="session-file-tree-name">{row.root.label}</span>
                  </button>
                ) : (() => {
                  const entryKey = directoryKey(row.rootId, row.entry.relativePath);
                  const isDirectory = row.entry.kind === "directory";
                  const isSelected = selectedFile?.rootId === row.rootId && selectedFile.relativePath === row.entry.relativePath;
                  return (
                    <button
                      className={`session-file-tree-row${isSelected ? " is-selected" : ""}`}
                      type="button"
                      style={{ paddingLeft: `${10 + row.depth * 14}px` }}
                      onClick={(event) => {
                        if (isDirectory) {
                          toggleDirectory(row.rootId, row.entry.relativePath);
                        } else if (row.entry.kind === "file") {
                          onOpenFile(
                            { sessionId: sessionId!, rootId: row.rootId, relativePath: row.entry.relativePath },
                            event.ctrlKey || event.metaKey,
                          );
                        }
                      }}
                      onContextMenu={(event) => {
                        if (row.entry.kind !== "directory" && row.entry.kind !== "file") {
                          return;
                        }
                        showPathContextMenu(event, {
                          rootId: row.rootId,
                          relativePath: row.entry.relativePath,
                          nodeKind: row.entry.kind,
                        });
                      }}
                      title={row.entry.relativePath}
                    >
                      <span className={`session-file-tree-icon${isDirectory && expandedDirectories[entryKey] ? " is-expanded" : ""}`}>
                        {entryIcon(row.entry)}
                      </span>
                      <span className="session-file-tree-name">{row.entry.name}</span>
                    </button>
                  );
                })()}
              </div>
            );
          })}
        </div>
      </div>
      <div
        id={`${tabPanelId}-changes-panel`}
        className="session-file-explorer-body has-changes"
        role="tabpanel"
        aria-labelledby={`${tabPanelId}-changes-tab`}
        hidden={activeTab !== "changes"}
      >
        {mountedTabs.changes || activeTab === "changes"
          ? (
              <Fragment key={`${tabOwnerKey}:changes`}>
                {renderChangesContent?.(roots) ?? <p className="session-file-tree-empty">No changes.</p>}
              </Fragment>
            )
          : null}
      </div>
      <div
        id={`${tabPanelId}-history-panel`}
        className="session-file-explorer-body has-history"
        role="tabpanel"
        aria-labelledby={`${tabPanelId}-history-tab`}
        hidden={activeTab !== "history"}
      >
        {mountedTabs.history || activeTab === "history"
          ? (
              <Fragment key={`${tabOwnerKey}:history`}>
                {historyContent ?? <p className="session-file-tree-empty">No history.</p>}
              </Fragment>
            )
          : null}
      </div>
    </aside>
  );
}

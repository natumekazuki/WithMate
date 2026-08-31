import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
  | "isSessionFileObjectCopyAvailable"
  | "showSessionFileObjectCopyContextMenu"
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
  renderChangesContent,
  historyContent,
}: SessionFileExplorerPaneProps) {
  const fileObjectCopyAvailable = api?.isSessionFileObjectCopyAvailable?.() ?? false;
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
            className={activeTab === "files" ? "is-active" : ""}
            type="button"
            role="tab"
            aria-selected={activeTab === "files"}
            onClick={() => onActiveTabChange("files")}
          >
            Files
          </button>
          <button
            className={activeTab === "changes" ? "is-active" : ""}
            type="button"
            role="tab"
            aria-selected={activeTab === "changes"}
            onClick={() => onActiveTabChange("changes")}
          >
            Changes
          </button>
          <button
            className={activeTab === "history" ? "is-active" : ""}
            type="button"
            role="tab"
            aria-selected={activeTab === "history"}
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
        className={`session-file-explorer-body${activeTab === "changes" ? " has-changes" : activeTab === "history" ? " has-history" : ""}`}
      >
        {activeTab === "changes" ? (
          renderChangesContent?.(roots) ?? <p className="session-file-tree-empty">No changes.</p>
        ) : activeTab === "history" ? (
          historyContent ?? <p className="session-file-tree-empty">No history.</p>
        ) : (
          <>
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
                            if (!api || !fileObjectCopyAvailable || row.entry.kind !== "file") {
                              return;
                            }
                            event.preventDefault();
                            void api.showSessionFileObjectCopyContextMenu({
                              resource: {
                                sessionId: sessionId!,
                                rootId: row.rootId,
                                relativePath: row.entry.relativePath,
                              },
                              point: {
                                x: Math.max(0, Math.round(event.clientX)),
                                y: Math.max(0, Math.round(event.clientY)),
                              },
                            }).then((result) => {
                              if (result.status !== "dismissed") {
                                setFeedbackMessage(result.message);
                              }
                            }).catch(() => {
                              setFeedbackMessage("File copy menu could not be opened.");
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
          </>
        )}
      </div>
    </aside>
  );
}

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
  SessionFilePin,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { FilePinIcon } from "./FilePinIcon.js";
import { useSessionFilePins, type FilePinsApi } from "./use-session-file-pins.js";

type FileExplorerApi = FilePinsApi & Pick<
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
  | { kind: "pin"; pin: SessionFilePin; depth: number }
  | { kind: "status"; id: string; depth: number };

type DirectoryLoadRequest = {
  revision: number;
  requestId: number;
  promise: Promise<void>;
};

type RootsLoadState = "loading" | "ready" | "unavailable" | "error";

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

function pinEntryKey(rootId: string, relativePath: string, rootPath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  return directoryKey(rootId, /^[a-z]:[\\/]|^\\\\/i.test(rootPath) ? normalized.toLocaleLowerCase("en-US") : normalized);
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
  const [rootsLoadState, setRootsLoadState] = useState<RootsLoadState>(() => (
    api && sessionId && enabled ? "loading" : "unavailable"
  ));
  const [errorMessage, setErrorMessage] = useState("");
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const pinFilterRef = useRef<HTMLButtonElement | null>(null);
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [revealTarget, setRevealTarget] = useState<string | null>(null);
  const filePins = useSessionFilePins({ api, sessionId, enabled, rootsRevision });
  const pinsByEntry = useMemo(() => new Map(filePins.pins.flatMap((pin) => pin.rootId
    ? [[pinEntryKey(pin.rootId, pin.relativePath, pin.rootPath), pin] as const]
    : [])), [filePins.pins]);
  const rootPaths = useMemo(() => new Map(roots.map((root) => [root.id, root.displayPath])), [roots]);
  const findPin = (rootId: string, relativePath: string) => pinsByEntry.get(pinEntryKey(rootId, relativePath, rootPaths.get(rootId) ?? ""));
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
          setErrorMessage(error instanceof Error ? error.message : "Directory could not be loaded.");
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
      setRootsLoadState("unavailable");
      return;
    }
    setRootsLoadState("loading");
    try {
      const nextRoots = await api.listSessionFileRoots(sessionId);
      if (loadRevisionRef.current !== revision) {
        return;
      }
      setRoots(nextRoots);
      setRootsLoadState("ready");
    } catch (error) {
      if (loadRevisionRef.current === revision) {
        setRootsLoadState("error");
        setErrorMessage(error instanceof Error ? error.message : "File roots could not be loaded.");
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

  const revealPinnedDirectory = async (pin: SessionFilePin) => {
    if (!pin.rootId || pin.unavailableReason) return;
    const revision = loadRevisionRef.current;
    const segments = pin.relativePath.split("/");
    setPinnedOnly(false);
    for (let index = 0; index <= segments.length; index += 1) {
      if (loadRevisionRef.current !== revision) return;
      const relativePath = segments.slice(0, index).join("/");
      const key = directoryKey(pin.rootId, relativePath);
      const nextExpanded = { ...expandedDirectoriesRef.current, [key]: true };
      expandedDirectoriesRef.current = nextExpanded;
      setExpandedDirectories(nextExpanded);
      if (!entriesByDirectoryRef.current[key]) await loadDirectory(pin.rootId, relativePath, revision);
      if (!entriesByDirectoryRef.current[key]) return;
    }
    if (loadRevisionRef.current === revision) setRevealTarget(directoryKey(pin.rootId, pin.relativePath));
  };

  const removePin = async (pin: SessionFilePin, visibleIndex: number) => {
    if (!await filePins.changePin(pin, true) || !pinnedOnly) return;
    requestAnimationFrame(() => {
      const buttons = treeScrollRef.current?.querySelectorAll<HTMLButtonElement>("[data-file-pin-toggle]");
      (buttons?.[Math.min(visibleIndex, buttons.length - 1)] ?? pinFilterRef.current)?.focus();
    });
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
    if (pinnedOnly) {
      return filePins.pins.map((pin): FileTreeRow => ({ kind: "pin", pin, depth: 0 }));
    }
    const appendDirectory = (rootId: string, relativePath: string, depth: number) => {
      const key = directoryKey(rootId, relativePath);
      if (!expandedDirectories[key]) {
        return;
      }
      if (loadingDirectories[key] && !entriesByDirectory[key]) {
        rows.push({ kind: "status", id: `${key}\u0000loading`, depth });
        return;
      }
      const entries = entriesByDirectory[key] ?? [];
      const isPinned = (entry: SessionDirectoryEntry) => pinsByEntry.has(pinEntryKey(rootId, entry.relativePath, rootPaths.get(rootId) ?? ""));
      const orderedEntries = [...entries.filter(isPinned), ...entries.filter((entry) => !isPinned(entry))];
      for (const entry of orderedEntries) {
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
  }, [entriesByDirectory, expandedDirectories, loadingDirectories, roots, pinnedOnly, filePins.pins, pinsByEntry, rootPaths]);
  const treeVirtualizer = useVirtualizer({
    count: treeRows.length,
    getScrollElement: () => treeScrollRef.current,
    estimateSize: (index) => treeRows[index]?.kind === "pin" ? (treeRows[index].pin.unavailableReason ? 78 : 58) : 31,
    overscan: 18,
    useFlushSync: false,
  });

  useLayoutEffect(() => { treeVirtualizer.measure(); }, [pinnedOnly, treeVirtualizer, filePins.pins]);
  useEffect(() => {
    if (!revealTarget || pinnedOnly) return;
    const index = treeRows.findIndex((row) => row.kind === "entry" && directoryKey(row.rootId, row.entry.relativePath) === revealTarget);
    if (index >= 0) {
      treeVirtualizer.scrollToIndex(index, { align: "start" });
      const frame = requestAnimationFrame(() => {
        treeScrollRef.current?.querySelector<HTMLButtonElement>(`[data-file-row-index="${index}"]`)?.focus();
        setRevealTarget(null);
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [pinnedOnly, revealTarget, treeRows, treeVirtualizer]);

  return (
    <aside className="session-file-explorer" aria-label="File explorer">
      <div className="session-file-explorer-header">
        <div className="session-file-explorer-tabs" role="tablist" aria-label="File explorer view">
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
        <div className="session-file-explorer-actions">
        {activeTab === "files" ? (
          <button
            ref={pinFilterRef}
            className={`session-file-pin-filter${pinnedOnly ? " is-active" : ""}`}
            type="button"
            aria-label="Pinned only"
            title="Pinned Only"
            aria-pressed={pinnedOnly}
            onClick={() => { setPinnedOnly((current) => !current); treeScrollRef.current?.scrollTo({ top: 0 }); }}
          >
            <FilePinIcon active={pinnedOnly} />
          </button>
        ) : null}
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
            void filePins.refresh();
          }}
          aria-label={activeTab === "changes" ? "Refresh changes" : activeTab === "history" ? "Refresh history" : "Refresh files"}
          title={activeTab === "changes" ? "Refresh Changes" : activeTab === "history" ? "Refresh History" : "Refresh Files"}
          disabled={activeTab === "files" && (rootsLoadState === "loading" || filePins.pending)}
          aria-busy={activeTab === "files" && rootsLoadState === "loading"}
        >
          ↻
        </button>
        </div>
      </div>

      <div
        ref={treeScrollRef}
        id={`${tabPanelId}-files-panel`}
        className="session-file-explorer-body"
        role="tabpanel"
        aria-labelledby={`${tabPanelId}-files-tab`}
        aria-busy={rootsLoadState === "loading" || (!!api && !!sessionId && enabled && filePins.status === "loading")}
        hidden={activeTab !== "files"}
      >
        {errorMessage ? <p className="session-file-tree-error" role="alert">{errorMessage}</p> : null}
        {filePins.error ? (
          <div className="session-file-tree-error session-file-pins-error" role="alert">
            {filePins.error} <button type="button" onClick={() => void filePins.refresh()}>Retry Pins</button>
          </div>
        ) : null}
        {enabled && api && sessionId && filePins.status === "loading" ? (
          <p className="session-file-tree-status"><LoadingIndicator inline label="Loading pins" /></p>
        ) : null}
        {feedbackMessage ? (
          <p className="session-file-tree-feedback" role="status" aria-live="polite">{feedbackMessage}</p>
        ) : null}
        {rootsLoadState === "loading" ? (
          <p className="session-file-tree-status">
            <LoadingIndicator inline label="Loading files" />
          </p>
        ) : null}
        <div className="session-file-tree-virtual" style={{ height: treeVirtualizer.getTotalSize() }}>
          {treeVirtualizer.getVirtualItems().map((virtualRow) => {
            const row = treeRows[virtualRow.index];
            if (!row) {
              return null;
            }
            const rowKey = row.kind === "root"
              ? `root:${row.root.id}`
              : row.kind === "pin"
                ? `pin:${JSON.stringify([row.pin.rootKind, row.pin.rootPath, row.pin.relativePath])}`
              : row.kind === "entry"
                ? `entry:${directoryKey(row.rootId, row.entry.relativePath)}`
                : row.id;
            return (
              <div
                className="session-file-tree-virtual-row"
                key={rowKey}
                data-index={virtualRow.index}
                ref={row.kind === "pin" ? treeVirtualizer.measureElement : undefined}
                style={{ height: row.kind === "pin" ? undefined : virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
              >
                {row.kind === "status" ? (
                  <div
                    className="session-file-tree-status"
                    style={{ paddingLeft: `${10 + row.depth * 14}px` }}
                  >
                    <LoadingIndicator inline label="Loading directory" />
                  </div>
                ) : row.kind === "pin" ? (
                  <>
                    <button
                      type="button"
                      className="session-file-tree-row session-file-pinned-row"
                      title={`${row.pin.rootPath}/${row.pin.relativePath}${row.pin.unavailableReason ? `\n${row.pin.unavailableReason}` : ""}`}
                      aria-label={`${row.pin.rootLabel}: ${row.pin.relativePath}${row.pin.unavailableReason ? `. ${row.pin.unavailableReason}` : ""}`}
                      disabled={!row.pin.rootId || !!row.pin.unavailableReason}
                      onClick={(event) => {
                        if (row.pin.kind === "directory") void revealPinnedDirectory(row.pin);
                        else if (sessionId && row.pin.rootId) onOpenFile({ sessionId, rootId: row.pin.rootId, relativePath: row.pin.relativePath }, event.ctrlKey || event.metaKey);
                      }}
                      onContextMenu={(event) => {
                        if (row.pin.rootId && !row.pin.unavailableReason) showPathContextMenu(event, { rootId: row.pin.rootId, relativePath: row.pin.relativePath, nodeKind: row.pin.kind });
                      }}
                    >
                      <span className="session-file-tree-icon" aria-hidden="true">{row.pin.kind === "directory" ? "▸" : "·"}</span>
                      <span className="session-file-pin-details">
                        <span className="session-file-pin-heading"><span className="session-file-tree-name">{row.pin.relativePath.split("/").at(-1)}</span><span className="session-file-pin-root">{row.pin.rootLabel}</span></span>
                        <span className="session-file-pin-path">{row.pin.relativePath.includes("/") ? row.pin.relativePath.slice(0, row.pin.relativePath.lastIndexOf("/")) : row.pin.rootPath}</span>
                        {row.pin.unavailableReason ? <span className="session-file-pin-unavailable">{row.pin.unavailableReason}</span> : null}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="session-file-pin-toggle is-pinned"
                      data-file-pin-toggle
                      aria-label={`Unpin ${row.pin.relativePath}`}
                      title={`Unpin ${row.pin.rootPath}/${row.pin.relativePath}${row.pin.unavailableReason ? `\n${row.pin.unavailableReason}` : ""}`}
                      aria-pressed="true"
                      disabled={!filePins.canChange}
                      onClick={() => void removePin(row.pin, virtualRow.index)}
                    ><FilePinIcon active /></button>
                  </>
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
                    <span className={`session-file-tree-icon${expandedDirectories[directoryKey(row.root.id, "")] ? " is-expanded" : ""}`} aria-hidden="true">▸</span>
                    <span className="session-file-tree-name">{row.root.label}</span>
                  </button>
                ) : (() => {
                  const entryKey = directoryKey(row.rootId, row.entry.relativePath);
                  const isDirectory = row.entry.kind === "directory";
                  const isSelected = selectedFile?.rootId === row.rootId && selectedFile.relativePath === row.entry.relativePath;
                  return (
                    <>
                    <button
                      data-file-row-index={virtualRow.index}
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
                      <span className={`session-file-tree-icon${isDirectory && expandedDirectories[entryKey] ? " is-expanded" : ""}`} aria-hidden="true">
                        {entryIcon(row.entry)}
                      </span>
                      <span className="session-file-tree-name">{row.entry.name}</span>
                    </button>
                    {row.entry.kind === "file" || isDirectory ? (
                      <button
                        type="button"
                        className={`session-file-pin-toggle${findPin(row.rootId, row.entry.relativePath) ? " is-pinned" : ""}`}
                        aria-label={`${findPin(row.rootId, row.entry.relativePath) ? "Unpin" : "Pin"} ${row.entry.relativePath}`}
                        title={findPin(row.rootId, row.entry.relativePath) ? "Unpin" : "Pin"}
                        aria-pressed={!!findPin(row.rootId, row.entry.relativePath)}
                        disabled={!filePins.canChange}
                        onClick={() => {
                          const pin = findPin(row.rootId, row.entry.relativePath);
                          if (pin) void filePins.changePin(pin, true);
                          else if (sessionId) void filePins.changePin({ sessionId, rootId: row.rootId, relativePath: row.entry.relativePath }, false);
                        }}
                      ><FilePinIcon active={!!findPin(row.rootId, row.entry.relativePath)} /></button>
                    ) : null}
                    </>
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
                {renderChangesContent?.(roots) ?? null}
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
                {historyContent ?? null}
              </Fragment>
            )
          : null}
      </div>
    </aside>
  );
}

import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WithMateWindowApi } from "../withmate-window-api.js";
import type {
  FileRootFileDiffRequest,
  FileRootChangesResult,
  FileRootGitChangeEntry,
  FileRootGitChangeScope,
  SessionFileResourceRequest,
  SessionFileRoot,
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
  onOpenFile: (request: SessionFileResourceRequest) => void;
  onOpenDiff: (request: FileRootFileDiffRequest) => Promise<string | null>;
};

type GitRootChanges = {
  root: SessionFileRoot;
  entries: FileRootGitChangeEntry[];
  message: string;
};

function changeKindLabel(kind: FileRootGitChangeEntry["kinds"][FileRootGitChangeScope]): string {
  switch (kind) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "U";
    default:
      return "M";
  }
}

type FileRootChangeRow =
  | { key: string; type: "root"; root: SessionFileRoot }
  | { key: string; type: "header"; label: string; count: number }
  | { key: string; type: "empty"; label: string }
  | { key: string; type: "error"; label: string }
  | {
      key: string;
      type: "entry";
      rootId: string;
      entry: FileRootGitChangeEntry;
      scope: FileRootGitChangeScope;
    };

export function FileRootChangesPane({
  api,
  sessionId,
  enabled,
  rootsRevision,
  onOpenFile,
  onOpenDiff,
}: FileRootChangesPaneProps) {
  const requestRevisionRef = useRef(0);
  const diffRevisionRef = useRef(0);
  const [rootChanges, setRootChanges] = useState<GitRootChanges[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingKey, setLoadingKey] = useState("");
  const [message, setMessage] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(async () => {
    const revision = requestRevisionRef.current + 1;
    requestRevisionRef.current = revision;
    if (!api || !sessionId || !enabled) {
      setRootChanges([]);
      setLoading(false);
      setMessage("");
      return;
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
        setRootChanges([]);
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
    const handleWindowFocus = () => void reload();
    window.addEventListener("focus", handleWindowFocus);
    return () => {
      requestRevisionRef.current += 1;
      diffRevisionRef.current += 1;
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [reload, rootsRevision]);

  const openEntry = async (
    rootId: string,
    entry: FileRootGitChangeEntry,
    scope: FileRootGitChangeScope,
  ) => {
    if (!api || !sessionId) {
      return;
    }
    if (entry.kinds[scope] === "untracked") {
      onOpenFile({ sessionId, rootId, relativePath: entry.relativePath });
      return;
    }
    const request = { sessionId, rootId, relativePath: entry.relativePath, scope };
    const key = `${rootId}:${scope}:${entry.relativePath}`;
    const revision = diffRevisionRef.current + 1;
    diffRevisionRef.current = revision;
    setLoadingKey(key);
    setMessage("");
    try {
      const resultMessage = await onOpenDiff(request);
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

  const rows = useMemo(() => {
    const nextRows: FileRootChangeRow[] = [];
    for (const rootChange of rootChanges) {
      nextRows.push({ key: `root:${rootChange.root.id}`, type: "root", root: rootChange.root });
      if (rootChange.message) {
        nextRows.push({ key: `error:${rootChange.root.id}`, type: "error", label: rootChange.message });
        continue;
      }
      for (const [scope, label] of [["working-tree", "Working Tree"], ["staged", "Staged"]] as const) {
        const scopedEntries = rootChange.entries.filter((entry) => entry.scopes.includes(scope));
        nextRows.push({
          key: `header:${rootChange.root.id}:${scope}`,
          type: "header",
          label,
          count: scopedEntries.length,
        });
        if (scopedEntries.length === 0) {
          nextRows.push({ key: `empty:${rootChange.root.id}:${scope}`, type: "empty", label: "No changes." });
        } else {
          scopedEntries.forEach((entry) => {
            nextRows.push({
              key: `${rootChange.root.id}:${scope}:${entry.relativePath}`,
              type: "entry",
              rootId: rootChange.root.id,
              entry,
              scope,
            });
          });
        }
      }
    }
    if (!loading && nextRows.length === 0) {
      nextRows.push({ key: "no-git-roots", type: "empty", label: "No Git repositories." });
    }
    return nextRows;
  }, [loading, rootChanges]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => rows[index]?.key ?? index,
    estimateSize: (index) => rows[index]?.type === "root" ? 38 : rows[index]?.type === "header" ? 31 : 30,
    overscan: 16,
    initialRect: { width: 280, height: 480 },
    useFlushSync: false,
  });

  return (
    <div className="workspace-changes-pane">
      <div className="workspace-changes-toolbar">
        <span>{loading ? "Refreshing…" : "Live root status"}</span>
        <button type="button" onClick={() => void reload()} disabled={loading}>Refresh</button>
      </div>
      {message ? <p className="workspace-changes-message" role="alert">{message}</p> : null}
      <div className="workspace-changes-list" ref={scrollRef} role="list" aria-label="File root changes">
        <div className="workspace-changes-list-inner" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) {
              return null;
            }
            return (
              <div
                key={row.key}
                className={`workspace-change-virtual-row ${row.type}`}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {row.type === "root" ? (
                  <div className="workspace-changes-root-header" title={row.root.displayPath}>
                    <strong>{row.root.label}</strong>
                    <span>{row.root.displayPath}</span>
                  </div>
                ) : row.type === "header" ? (
                  <div className="workspace-changes-group-header"><strong>{row.label}</strong><span>{row.count}</span></div>
                ) : row.type === "empty" ? (
                  <p>{row.label}</p>
                ) : row.type === "error" ? (
                  <p className="workspace-changes-root-error">{row.label}</p>
                ) : (() => {
                  const key = `${row.rootId}:${row.scope}:${row.entry.relativePath}`;
                  const kind = row.entry.kinds[row.scope] ?? "modified";
                  return (
                    <button
                      className="workspace-change-row"
                      type="button"
                      disabled={!!loadingKey}
                      onClick={() => void openEntry(row.rootId, row.entry, row.scope)}
                      title={row.entry.previousRelativePath
                        ? `${row.entry.previousRelativePath} → ${row.entry.relativePath}`
                        : row.entry.relativePath}
                    >
                      <span className={`workspace-change-kind ${kind}`}>{changeKindLabel(kind)}</span>
                      <span className="workspace-change-path">{row.entry.relativePath}</span>
                      {loadingKey === key ? <span className="workspace-change-loading">…</span> : null}
                    </button>
                  );
                })()}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

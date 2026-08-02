import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WithMateWindowApi } from "../withmate-window-api.js";
import type {
  WorkspaceChangeEntry,
  WorkspaceChangeScope,
} from "./file-explorer-contract.js";

type WorkspaceChangesApi = Pick<WithMateWindowApi, "listWorkspaceChanges">;

export type WorkspaceChangesPaneProps = {
  api: WorkspaceChangesApi | null;
  sessionId: string | null;
  enabled: boolean;
  onOpenFile: (relativePath: string) => void;
  onOpenDiff: (relativePath: string, scope: WorkspaceChangeScope) => Promise<string | null>;
  onEntriesChange?: (entries: WorkspaceChangeEntry[]) => void;
};

function changeKindLabel(kind: WorkspaceChangeEntry["kinds"][WorkspaceChangeScope]): string {
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

type WorkspaceChangeRow =
  | { key: string; type: "header"; label: string; count: number }
  | { key: string; type: "empty"; label: string }
  | { key: string; type: "entry"; entry: WorkspaceChangeEntry; scope: WorkspaceChangeScope };

export function WorkspaceChangesPane({
  api,
  sessionId,
  enabled,
  onOpenFile,
  onOpenDiff,
  onEntriesChange,
}: WorkspaceChangesPaneProps) {
  const requestRevisionRef = useRef(0);
  const diffRevisionRef = useRef(0);
  const [entries, setEntries] = useState<WorkspaceChangeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingKey, setLoadingKey] = useState("");
  const [message, setMessage] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(async () => {
    const revision = requestRevisionRef.current + 1;
    requestRevisionRef.current = revision;
    if (!api || !sessionId || !enabled) {
      setEntries([]);
      onEntriesChange?.([]);
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const result = await api.listWorkspaceChanges(sessionId);
      if (requestRevisionRef.current !== revision) {
        return;
      }
      if (result.status === "ok") {
        setEntries(result.entries);
        onEntriesChange?.(result.entries);
      } else {
        setEntries([]);
        onEntriesChange?.([]);
        setMessage(result.message);
      }
    } catch (error) {
      if (requestRevisionRef.current === revision) {
        setEntries([]);
        onEntriesChange?.([]);
        setMessage(error instanceof Error ? error.message : "Git status failed.");
      }
    } finally {
      if (requestRevisionRef.current === revision) {
        setLoading(false);
      }
    }
  }, [api, enabled, onEntriesChange, sessionId]);

  useEffect(() => {
    void reload();
    const handleWindowFocus = () => void reload();
    window.addEventListener("focus", handleWindowFocus);
    return () => {
      requestRevisionRef.current += 1;
      diffRevisionRef.current += 1;
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [reload]);

  const openEntry = async (entry: WorkspaceChangeEntry, scope: WorkspaceChangeScope) => {
    if (!api || !sessionId) {
      return;
    }
    if (entry.kinds[scope] === "untracked") {
      onOpenFile(entry.relativePath);
      return;
    }
    const key = `${scope}:${entry.relativePath}`;
    const revision = diffRevisionRef.current + 1;
    diffRevisionRef.current = revision;
    setLoadingKey(key);
    setMessage("");
    try {
      const resultMessage = await onOpenDiff(entry.relativePath, scope);
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
    const nextRows: WorkspaceChangeRow[] = [];
    for (const [scope, label] of [["working-tree", "Working Tree"], ["staged", "Staged"]] as const) {
      const scopedEntries = entries.filter((entry) => entry.scopes.includes(scope));
      nextRows.push({ key: `header:${scope}`, type: "header", label, count: scopedEntries.length });
      if (scopedEntries.length === 0) {
        nextRows.push({ key: `empty:${scope}`, type: "empty", label: "No changes." });
      } else {
        scopedEntries.forEach((entry) => {
          nextRows.push({ key: `${scope}:${entry.relativePath}`, type: "entry", entry, scope });
        });
      }
    }
    return nextRows;
  }, [entries]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => rows[index]?.key ?? index,
    estimateSize: (index) => rows[index]?.type === "header" ? 31 : 30,
    overscan: 16,
    initialRect: { width: 280, height: 480 },
    useFlushSync: false,
  });

  return (
    <div className="workspace-changes-pane">
      <div className="workspace-changes-toolbar">
        <span>{loading ? "Refreshing…" : "Live workspace status"}</span>
        <button type="button" onClick={() => void reload()} disabled={loading}>Refresh</button>
      </div>
      {message ? <p className="workspace-changes-message" role="alert">{message}</p> : null}
      <div className="workspace-changes-list" ref={scrollRef} role="list" aria-label="Workspace changes">
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
                {row.type === "header" ? (
                  <div className="workspace-changes-group-header"><strong>{row.label}</strong><span>{row.count}</span></div>
                ) : row.type === "empty" ? (
                  <p>{row.label}</p>
                ) : (() => {
                  const key = `${row.scope}:${row.entry.relativePath}`;
                  const kind = row.entry.kinds[row.scope] ?? "modified";
                  return (
                    <button
                      className="workspace-change-row"
                      type="button"
                      disabled={!!loadingKey}
                      onClick={() => void openEntry(row.entry, row.scope)}
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

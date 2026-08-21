import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useId, useMemo, useRef, type CSSProperties } from "react";

import {
  buildChangedFileTree,
  changedFileDisplayName,
  type ChangedFileTreeNode,
} from "./changed-file-tree.js";
import type {
  FileRootGitChangeEntry,
  FileRootGitChangeScope,
  SessionFileRoot,
} from "./file-explorer-contract.js";

const ROOT_HEADER_ESTIMATED_HEIGHT = 48;
const ROOT_GROUP_MIN_HEIGHT = 168;
const ROOT_GROUP_MAX_HEIGHT = 408;

export type GitRootChanges = {
  root: SessionFileRoot;
  entries: FileRootGitChangeEntry[];
  message: string;
};

type FileRootChangeRow =
  | { key: string; type: "header"; label: string; count: number }
  | { key: string; type: "empty"; label: string }
  | { key: string; type: "error"; label: string }
  | {
      key: string;
      type: "directory";
      rootId: string;
      scope: FileRootGitChangeScope;
      relativePath: string;
      name: string;
      depth: number;
      expanded: boolean;
    }
  | {
      key: string;
      type: "entry";
      rootId: string;
      entry: FileRootGitChangeEntry;
      scope: FileRootGitChangeScope;
      depth: number;
    };

function changeKindLabel(kind: FileRootGitChangeEntry["kinds"][FileRootGitChangeScope]): string {
  switch (kind) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "untracked":
      return "U";
    default:
      return "M";
  }
}

function directoryStateKey(rootId: string, scope: FileRootGitChangeScope, relativePath: string): string {
  return `${rootId}\u0000${scope}\u0000${relativePath}`;
}

function estimatedRowHeight(row: FileRootChangeRow): number {
  return row.type === "header" ? 31 : 30;
}

type FileRootChangesGroupProps = {
  rootChange: GitRootChanges;
  groupCount: number;
  collapsedDirectories: Record<string, boolean>;
  loadingKey: string;
  scopes?: readonly (readonly [FileRootGitChangeScope, string])[];
  selectedEntryKey?: string | null;
  onToggleDirectory: (rootId: string, scope: FileRootGitChangeScope, relativePath: string) => void;
  onOpenEntry: (
    rootId: string,
    entry: FileRootGitChangeEntry,
    scope: FileRootGitChangeScope,
    openInWindow: boolean,
  ) => Promise<void>;
};

export function FileRootChangesGroup({
  rootChange,
  groupCount,
  collapsedDirectories,
  loadingKey,
  onToggleDirectory,
  onOpenEntry,
  scopes = [["working-tree", "Working Tree"], ["staged", "Staged"]],
  selectedEntryKey = null,
}: FileRootChangesGroupProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const headingId = useId();
  const rows = useMemo(() => {
    const nextRows: FileRootChangeRow[] = [];
    const appendTreeNodes = (
      nodes: ChangedFileTreeNode[],
      scope: FileRootGitChangeScope,
      depth: number,
    ) => {
      for (const node of nodes) {
        if (node.type === "directory") {
          const stateKey = directoryStateKey(rootChange.root.id, scope, node.relativePath);
          const expanded = !collapsedDirectories[stateKey];
          nextRows.push({
            key: `directory:${rootChange.root.id}:${scope}:${node.relativePath}`,
            type: "directory",
            rootId: rootChange.root.id,
            scope,
            relativePath: node.relativePath,
            name: node.name,
            depth,
            expanded,
          });
          if (expanded) {
            appendTreeNodes(node.children, scope, depth + 1);
          }
        } else {
          nextRows.push({
            key: `${rootChange.root.id}:${scope}:${node.relativePath}`,
            type: "entry",
            rootId: rootChange.root.id,
            entry: node.entry,
            scope,
            depth,
          });
        }
      }
    };

    if (rootChange.message) {
      nextRows.push({ key: `error:${rootChange.root.id}`, type: "error", label: rootChange.message });
      return nextRows;
    }
    for (const [scope, label] of scopes) {
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
        appendTreeNodes(buildChangedFileTree(scopedEntries, scope), scope, 0);
      }
    }
    return nextRows;
  }, [collapsedDirectories, rootChange, scopes]);
  const naturalHeight = ROOT_HEADER_ESTIMATED_HEIGHT
    + rows.reduce((total, row) => total + estimatedRowHeight(row), 0);
  const minimumHeight = Math.min(naturalHeight, ROOT_GROUP_MIN_HEIGHT);
  const maximumHeight = naturalHeight <= ROOT_GROUP_MAX_HEIGHT
    ? naturalHeight
    : groupCount === 1
      ? undefined
      : ROOT_GROUP_MAX_HEIGHT;
  const groupStyle: CSSProperties = {
    flexBasis: `${minimumHeight}px`,
    minHeight: `${minimumHeight}px`,
    ...(maximumHeight === undefined ? {} : { maxHeight: `${maximumHeight}px` }),
  };
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => rows[index]?.key ?? index,
    estimateSize: (index) => estimatedRowHeight(rows[index]!),
    overscan: 16,
    initialRect: { width: 280, height: Math.min(360, Math.max(90, naturalHeight - ROOT_HEADER_ESTIMATED_HEIGHT)) },
    useFlushSync: false,
  });
  const totalSize = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();
  const renderedVirtualItems = virtualItems.length > 0
    ? virtualItems
    : rows.map((row, index) => ({
        index,
        key: row.key,
        start: rows.slice(0, index).reduce((total, previousRow) => total + estimatedRowHeight(previousRow), 0),
        size: estimatedRowHeight(row),
      }));

  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) {
      return;
    }
    const maximumScrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    if (scrollElement.scrollTop > maximumScrollTop) {
      scrollElement.scrollTop = maximumScrollTop;
    }
  }, [totalSize]);

  return (
    <section
      className="workspace-changes-root-group"
      style={groupStyle}
      role="listitem"
      aria-labelledby={headingId}
      data-root-id={rootChange.root.id}
    >
      <div className="workspace-changes-root-header" title={rootChange.root.displayPath}>
        <div className="workspace-changes-root-title-row">
          <strong id={headingId}>{rootChange.root.label}</strong>
          {rootChange.message ? null : (
            <span className="workspace-changes-root-count" aria-label={`${rootChange.entries.length} changed files`}>
              {rootChange.entries.length}
            </span>
          )}
        </div>
        <span className="workspace-changes-root-path">{rootChange.root.displayPath}</span>
      </div>
      <div
        className="workspace-changes-list"
        ref={scrollRef}
        role="list"
        aria-label={`${rootChange.root.label} changes`}
        tabIndex={0}
      >
        <div className="workspace-changes-list-inner" style={{ height: totalSize || naturalHeight }}>
          {renderedVirtualItems.map((virtualRow) => {
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
                ) : row.type === "error" ? (
                  <p className="workspace-changes-root-error">{row.label}</p>
                ) : row.type === "directory" ? (
                  <button
                    className="workspace-change-directory-row"
                    type="button"
                    style={{ paddingLeft: `${6 + row.depth * 14}px` }}
                    aria-expanded={row.expanded}
                    title={row.relativePath}
                    onClick={() => onToggleDirectory(row.rootId, row.scope, row.relativePath)}
                  >
                    <span className={`workspace-change-directory-icon${row.expanded ? " is-expanded" : ""}`}>▸</span>
                    <span className="workspace-change-directory-name">{row.name}</span>
                  </button>
                ) : (() => {
                  const key = `${row.rootId}:${row.scope}:${row.entry.relativePath}`;
                  const kind = row.entry.kinds[row.scope] ?? "modified";
                  return (
                    <button
                      className={`workspace-change-row${selectedEntryKey === key ? " is-selected" : ""}`}
                      type="button"
                      style={{ paddingLeft: `${6 + row.depth * 14}px` }}
                      disabled={!!loadingKey}
                      onClick={(event) => void onOpenEntry(
                        row.rootId,
                        row.entry,
                        row.scope,
                        event.ctrlKey || event.metaKey,
                      )}
                      title={row.entry.previousRelativePath
                        ? `${row.entry.previousRelativePath} → ${row.entry.relativePath}`
                        : row.entry.relativePath}
                    >
                      <span className={`workspace-change-kind ${kind}`}>{changeKindLabel(kind)}</span>
                      <span className="workspace-change-path">{changedFileDisplayName(row.entry)}</span>
                      {loadingKey === key ? <span className="workspace-change-loading">…</span> : null}
                    </button>
                  );
                })()}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

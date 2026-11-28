import {
  defaultRangeExtractor,
  measureElement,
  useVirtualizer,
} from "@tanstack/react-virtual";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import {
  buildChangedFileTree,
  changedFileDisplayName,
  type ChangedFileTreeNode,
} from "./changed-file-tree.js";
import type {
  FileRootGitChangeEntry,
  FileRootGitChangeScope,
  SessionFileRoot,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";

const ROOT_HEADER_ESTIMATED_HEIGHT = 48;
const ROOT_GROUP_MIN_HEIGHT = 168;
const ROOT_GROUP_MAX_HEIGHT = 408;
const DEFAULT_SCOPES = [
  ["working-tree", "Working Tree"],
  ["staged", "Staged"],
] as const satisfies readonly (readonly [FileRootGitChangeScope, string])[];

/** 一つのファイルルートの取得状態と変更一覧。再取得中も既存のスナップショットを保持できる。 */
export type GitRootChanges = {
  root: SessionFileRoot;
  status: "idle" | "pending" | "success" | "empty" | "failed";
  entries: FileRootGitChangeEntry[];
  message: string;
  hasSnapshot?: boolean;
};

/** 仮想一覧に並べる見出し、エラー、ディレクトリ、変更ファイルの行。 */
type FileRootChangeRow =
  | { key: string; type: "header"; label: string; count: number }
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

/** 変更種別を行頭バッジの一文字に変換する。専用ラベルがない種別はMを使う。 */
function changeKindLabel(
  kind: FileRootGitChangeEntry["kinds"][FileRootGitChangeScope],
): string {
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

/** 同名ディレクトリの折りたたみ状態をルートと変更範囲ごとに分離する。 */
function directoryStateKey(
  rootId: string,
  scope: FileRootGitChangeScope,
  relativePath: string,
): string {
  return `${rootId}\u0000${scope}\u0000${relativePath}`;
}

/** 実測前の仮想行の高さを、範囲見出しとその他の行で分けて返す。 */
function estimatedRowHeight(row: FileRootChangeRow): number {
  return row.type === "header" ? 31 : 30;
}

/** ルート単位の一覧に渡す表示状態と、展開・ファイル選択を親へ通知する操作。 */
type FileRootChangesGroupProps = {
  rootChange: GitRootChanges;
  groupCount: number;
  sizing?: "bounded" | "content";
  scrollContainer?: HTMLDivElement | null;
  collapsedDirectories: Record<string, boolean>;
  loadingKey: string;
  scopes?: readonly (readonly [FileRootGitChangeScope, string])[];
  selectedEntryKey?: string | null;
  preserveScrollAnchor?: boolean;
  onToggleDirectory: (
    rootId: string,
    scope: FileRootGitChangeScope,
    relativePath: string,
  ) => void;
  onOpenEntry: (
    rootId: string,
    entry: FileRootGitChangeEntry,
    scope: FileRootGitChangeScope,
    openInWindow: boolean,
  ) => Promise<void>;
};

/** 一つのルートの変更を範囲別に仮想表示し、指定時は一覧の再取得前後で閲覧位置を維持する。 */
export function FileRootChangesGroup({
  rootChange,
  groupCount,
  sizing = "bounded",
  scrollContainer,
  collapsedDirectories,
  loadingKey,
  onToggleDirectory,
  onOpenEntry,
  scopes = DEFAULT_SCOPES,
  selectedEntryKey = null,
  preserveScrollAnchor = false,
}: FileRootChangesGroupProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const headingId = useId();
  /** 取得済みの変更を、開いているディレクトリだけをたどる表示順の行へ変換する。 */
  const rows = useMemo(() => {
    const nextRows: FileRootChangeRow[] = [];
    /** 変更ツリーを深さ優先で追加し、閉じたディレクトリの子は描画行に含めない。 */
    const appendTreeNodes = (
      nodes: ChangedFileTreeNode[],
      scope: FileRootGitChangeScope,
      depth: number,
    ) => {
      for (const node of nodes) {
        if (node.type === "directory") {
          const stateKey = directoryStateKey(
            rootChange.root.id,
            scope,
            node.relativePath,
          );
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

    if (rootChange.status === "idle") {
      return nextRows;
    }
    if (rootChange.status === "pending" && rootChange.entries.length === 0) {
      return nextRows;
    }
    if (rootChange.message) {
      nextRows.push({
        key: `error:${rootChange.root.id}`,
        type: "error",
        label: rootChange.message,
      });
      if (rootChange.entries.length === 0) {
        return nextRows;
      }
    }
    for (const [scope, label] of scopes) {
      const scopedEntries = rootChange.entries.filter((entry) =>
        entry.scopes.includes(scope),
      );
      if (scopedEntries.length === 0) {
        continue;
      }
      nextRows.push({
        key: `header:${rootChange.root.id}:${scope}`,
        type: "header",
        label,
        count: scopedEntries.length,
      });
      if (scopedEntries.length > 0) {
        appendTreeNodes(buildChangedFileTree(scopedEntries, scope), scope, 0);
      }
    }
    return nextRows;
  }, [collapsedDirectories, rootChange, scopes]);
  const naturalHeight = useMemo(
    () =>
      ROOT_HEADER_ESTIMATED_HEIGHT +
      rows.reduce((total, row) => total + estimatedRowHeight(row), 0),
    [rows],
  );
  const minimumHeight = Math.min(naturalHeight, ROOT_GROUP_MIN_HEIGHT);
  const maximumHeight =
    naturalHeight <= ROOT_GROUP_MAX_HEIGHT
      ? naturalHeight
      : groupCount === 1
        ? undefined
        : ROOT_GROUP_MAX_HEIGHT;
  const groupStyle: CSSProperties | undefined =
    sizing === "content"
      ? undefined
      : {
          flexBasis: `${minimumHeight}px`,
          minHeight: `${minimumHeight}px`,
          ...(maximumHeight === undefined
            ? {}
            : { maxHeight: `${maximumHeight}px` }),
        };
  /** 外部のスクロール要素を指定しなかった場合だけ、グループ内の一覧を使う。 */
  const getScrollElement = () =>
    scrollContainer === undefined ? scrollRef.current : scrollContainer;
  useLayoutEffect(() => {
    const container = scrollContainer;
    const list = scrollRef.current;
    if (!container?.clientHeight || !list) {
      return;
    }
    setScrollMargin(
      list.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop -
        container.clientTop,
    );
  });
  const previousLayoutRef = useRef<{
    rootId: string;
    displayPath: string;
    entries: FileRootGitChangeEntry[];
    message: string;
    collapsedDirectories: Record<string, boolean>;
    scopes: typeof scopes;
    scrollElement: HTMLDivElement | null;
    items: Array<{ key: string | number | bigint; start: number; end: number }>;
  } | null>(null);
  const readingContextRef = useRef<{ anchor: string; offset: number } | null>(
    null,
  );
  const restoredScrollTopRef = useRef<number | null>(null);
  const focusedKey =
    preserveScrollAnchor && scrollRef.current?.contains(document.activeElement)
      ? (document.activeElement?.closest<HTMLElement>("[data-change-row-key]")
          ?.dataset.changeRowKey ?? null)
      : null;
  const scrollElement = getScrollElement();
  const previous = previousLayoutRef.current;
  const sameReadingContext =
    preserveScrollAnchor &&
    scrollElement &&
    previous?.scrollElement === scrollElement &&
    previous.rootId === rootChange.root.id &&
    previous.displayPath === rootChange.root.displayPath &&
    previous.collapsedDirectories === collapsedDirectories &&
    previous.scopes === scopes;
  if (!sameReadingContext) {
    readingContextRef.current = null;
  } else if (
    !readingContextRef.current &&
    (previous.entries !== rootChange.entries ||
      previous.message !== rootChange.message)
  ) {
    const anchor = previous.items.find(
      (item) => item.end > scrollElement.scrollTop,
    );
    if (anchor && rows.some((row) => row.key === anchor.key)) {
      readingContextRef.current = {
        anchor: String(anchor.key),
        offset: scrollElement.scrollTop - anchor.start,
      };
      restoredScrollTopRef.current = scrollElement.scrollTop;
    }
  }
  /** 利用者の新しい操作でスクロール位置の復元を打ち切る。 */
  const cancelReadingRestore = () => {
    readingContextRef.current = null;
  };
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement,
    scrollMargin,
    /** 通常は行の安定キーを使い、未解決の位置のみ仮想一覧のインデックスを使う。 */
    getItemKey: (index) => rows[index]?.key ?? index,
    /** 仮想一覧の計測前に、該当行の種類から高さを見積もる。 */
    estimateSize: (index) => estimatedRowHeight(rows[index]!),
    /** 通常の描画範囲に加え、復元の基準行とフォーカス中の行をマウントしたままにする。 */
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      const context = readingContextRef.current;
      // 更新中のanchorと現在の操作対象だけは仮想範囲外でもmountを維持する。
      for (const key of [context?.anchor, focusedKey]) {
        const index = rows.findIndex((row) => row.key === key);
        if (index >= 0 && !indexes.includes(index)) indexes.push(index);
      }
      return indexes.sort((left, right) => left - right);
    },
    /** スクロール領域の高さが取れない間はキャッシュまたは見積もりを使い、表示後に実測する。 */
    measureElement: (element, entry, instance) => {
      if (!getScrollElement()?.clientHeight) {
        const index = instance.indexFromElement(element);
        return (
          instance.measurementsCache[index]?.size ??
          estimatedRowHeight(rows[index]!)
        );
      }
      return measureElement(element, entry, instance);
    },
    overscan: 16,
    initialRect: {
      width: 280,
      height: Math.min(
        360,
        Math.max(90, naturalHeight - ROOT_HEADER_ESTIMATED_HEIGHT),
      ),
    },
    useFlushSync: false,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange =
    readingContextRef.current ? () => false : undefined;
  const totalSize = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();

  useLayoutEffect(() => {
    const scrollElement = getScrollElement();
    const context = readingContextRef.current;
    if (context && scrollElement) {
      const anchor = virtualizer
        .getVirtualItems()
        .find((item) => item.key === context.anchor);
      const renderedAnchor = virtualItems.find(
        (item) => item.key === context.anchor,
      );
      if (anchor) {
        scrollElement.scrollTop = Math.max(0, anchor.start + context.offset);
        restoredScrollTopRef.current = scrollElement.scrollTop;
        // refでの計測とscroll eventを反映したrenderまで同じanchorを保持する。
        if (
          renderedAnchor?.start === anchor.start &&
          Math.abs((virtualizer.scrollOffset ?? 0) - scrollElement.scrollTop) <
            1
        ) {
          readingContextRef.current = null;
        }
      } else {
        readingContextRef.current = null;
      }
    }
    previousLayoutRef.current = {
      rootId: rootChange.root.id,
      displayPath: rootChange.root.displayPath,
      entries: rootChange.entries,
      message: rootChange.message,
      collapsedDirectories,
      scopes,
      scrollElement,
      items: virtualItems.map(({ key, start, end }) => ({ key, start, end })),
    };
  });

  useEffect(() => {
    const scrollElement = getScrollElement();
    if (!scrollElement || scrollElement.clientHeight === 0) {
      return;
    }
    const maximumScrollTop = Math.max(
      0,
      scrollElement.scrollHeight - scrollElement.clientHeight,
    );
    if (scrollElement.scrollTop > maximumScrollTop) {
      scrollElement.scrollTop = maximumScrollTop;
    }
  }, [totalSize]);

  const hasSnapshot =
    rootChange.status === "success" ||
    rootChange.status === "empty" ||
    rootChange.hasSnapshot;
  return (
    <section
      className={`workspace-changes-root-group${sizing === "content" ? " is-content-sized" : ""}`}
      style={groupStyle}
      role="listitem"
      aria-labelledby={headingId}
      aria-busy={
        rootChange.status === "pending" ||
        loadingKey.startsWith(`${rootChange.root.id}:`)
      }
      data-root-id={rootChange.root.id}
    >
      <div
        className="workspace-changes-root-header"
        title={rootChange.root.displayPath}
      >
        <div className="workspace-changes-root-title-row">
          <strong id={headingId}>{rootChange.root.label}</strong>
          {hasSnapshot || rootChange.status === "pending" ? (
            <span className="workspace-changes-root-summary">
              {rootChange.status === "pending" ? (
                <LoadingIndicator
                  inline
                  label={`Refreshing changes for ${rootChange.root.label}`}
                />
              ) : null}
              {hasSnapshot ? (
                <span
                  className="workspace-changes-root-count"
                  aria-label={`${rootChange.entries.length} changed files`}
                >
                  {rootChange.entries.length}
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
        <span className="workspace-changes-root-path">
          {rootChange.root.displayPath}
        </span>
      </div>
      <div
        className="workspace-changes-list"
        ref={scrollRef}
        role="list"
        aria-label={`${rootChange.root.label} changes`}
        tabIndex={0}
        onWheelCapture={cancelReadingRestore}
        onPointerDownCapture={cancelReadingRestore}
        onKeyDownCapture={cancelReadingRestore}
        onScroll={(event) => {
          if (
            readingContextRef.current &&
            event.currentTarget.scrollTop !== restoredScrollTopRef.current
          ) {
            cancelReadingRestore();
          }
        }}
      >
        <div
          className="workspace-changes-list-inner"
          style={{ height: totalSize || naturalHeight }}
        >
          {virtualItems.map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) {
              return null;
            }
            return (
              <div
                key={row.key}
                className={`workspace-change-virtual-row ${row.type}`}
                data-index={virtualRow.index}
                data-change-row-key={row.key}
                ref={virtualizer.measureElement}
                style={{
                  transform: `translateY(${virtualRow.start - scrollMargin}px)`,
                }}
              >
                {row.type === "header" ? (
                  <div className="workspace-changes-group-header">
                    <strong>{row.label}</strong>
                    <span>{row.count}</span>
                  </div>
                ) : row.type === "error" ? (
                  <p className="workspace-changes-root-error" role="alert">
                    {row.label}
                  </p>
                ) : row.type === "directory" ? (
                  <button
                    className="workspace-change-directory-row"
                    type="button"
                    style={{ paddingLeft: `${6 + row.depth * 14}px` }}
                    aria-expanded={row.expanded}
                    title={row.relativePath}
                    onClick={() =>
                      onToggleDirectory(row.rootId, row.scope, row.relativePath)
                    }
                  >
                    <span
                      className={`workspace-change-directory-icon${row.expanded ? " is-expanded" : ""}`}
                      aria-hidden="true"
                    >
                      ▸
                    </span>
                    <span className="workspace-change-directory-name">
                      {row.name}
                    </span>
                  </button>
                ) : (
                  (() => {
                    const key = `${row.rootId}:${row.scope}:${row.entry.relativePath}`;
                    const kind = row.entry.kinds[row.scope] ?? "modified";
                    return (
                      <button
                        className={`workspace-change-row${selectedEntryKey === key ? " is-selected" : ""}`}
                        type="button"
                        style={{ paddingLeft: `${6 + row.depth * 14}px` }}
                        disabled={!!loadingKey}
                        onClick={(event) =>
                          void onOpenEntry(
                            row.rootId,
                            row.entry,
                            row.scope,
                            event.ctrlKey || event.metaKey,
                          )
                        }
                        title={
                          row.entry.previousRelativePath
                            ? `${row.entry.previousRelativePath} → ${row.entry.relativePath}`
                            : row.entry.relativePath
                        }
                      >
                        <span className={`workspace-change-kind ${kind}`}>
                          {changeKindLabel(kind)}
                        </span>
                        <span className="workspace-change-path">
                          {changedFileDisplayName(row.entry)}
                        </span>
                        {loadingKey === key ? (
                          <span
                            className="workspace-change-loading"
                            role="status"
                            aria-label={
                              kind === "untracked"
                                ? "Opening file"
                                : "Opening diff"
                            }
                          >
                            <span
                              className="workspace-changes-root-spinner"
                              aria-hidden="true"
                            />
                          </span>
                        ) : null}
                      </button>
                    );
                  })()
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

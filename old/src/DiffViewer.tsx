import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";

import type { ChangedFile } from "./app-state.js";

type DiffViewerProps = {
  file: ChangedFile;
};

type DiffViewMode = "split" | "inline";

function syncScrollPosition(source: HTMLDivElement, targets: HTMLDivElement[], axis: "left" | "top") {
  for (const target of targets) {
    if (axis === "left") {
      if (target.scrollLeft !== source.scrollLeft) {
        target.scrollLeft = source.scrollLeft;
      }
      continue;
    }

    if (target.scrollTop !== source.scrollTop) {
      target.scrollTop = source.scrollTop;
    }
  }
}

function scrollElementToTop(element: HTMLDivElement | null): void {
  element?.scrollTo({ top: 0, left: 0 });
}

export function DiffViewer({ file }: DiffViewerProps) {
  const [viewMode, setViewMode] = useState<DiffViewMode>("split");
  const [activeChangeIndex, setActiveChangeIndex] = useState(0);
  const beforeHeadRef = useRef<HTMLDivElement | null>(null);
  const afterHeadRef = useRef<HTMLDivElement | null>(null);
  const beforeBodyRef = useRef<HTMLDivElement | null>(null);
  const afterBodyRef = useRef<HTMLDivElement | null>(null);
  const inlineBodyRef = useRef<HTMLDivElement | null>(null);
  const syncingRef = useRef(false);

  const changeRowIndices = useMemo(
    () => file.diffRows
      .map((row, index) => row.kind === "context" ? -1 : index)
      .filter((index) => index >= 0),
    [file.diffRows],
  );
  const activeRowIndex = changeRowIndices[activeChangeIndex] ?? -1;

  useEffect(() => {
    setActiveChangeIndex((current) => {
      if (changeRowIndices.length === 0) {
        return 0;
      }
      return Math.min(current, changeRowIndices.length - 1);
    });
  }, [changeRowIndices.length]);

  const handleScrollablePaneKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const scrollTopStep = 40;
    const scrollLeftStep = 48;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        element.scrollBy({ top: scrollTopStep });
        return;
      case "ArrowUp":
        event.preventDefault();
        element.scrollBy({ top: -scrollTopStep });
        return;
      case "PageDown":
        event.preventDefault();
        element.scrollBy({ top: element.clientHeight - 32 });
        return;
      case "PageUp":
        event.preventDefault();
        element.scrollBy({ top: -(element.clientHeight - 32) });
        return;
      case "Home":
        event.preventDefault();
        element.scrollTo({ top: 0, left: 0 });
        return;
      case "End":
        event.preventDefault();
        element.scrollTo({ top: element.scrollHeight, left: element.scrollLeft });
        return;
      case "ArrowLeft":
        event.preventDefault();
        element.scrollBy({ left: -scrollLeftStep });
        return;
      case "ArrowRight":
        event.preventDefault();
        element.scrollBy({ left: scrollLeftStep });
        return;
      default:
        return;
    }
  };

  useEffect(() => {
    setActiveChangeIndex(0);
    scrollElementToTop(beforeHeadRef.current);
    scrollElementToTop(afterHeadRef.current);
    scrollElementToTop(beforeBodyRef.current);
    scrollElementToTop(afterBodyRef.current);
    scrollElementToTop(inlineBodyRef.current);
  }, [file.path]);

  useEffect(() => {
    const beforeBody = beforeBodyRef.current;
    const afterBody = afterBodyRef.current;
    const beforeHead = beforeHeadRef.current;
    const afterHead = afterHeadRef.current;

    if (!beforeBody || !afterBody || !beforeHead || !afterHead || viewMode !== "split") {
      return;
    }

    const withSyncGuard = (callback: () => void) => {
      if (syncingRef.current) {
        return;
      }

      syncingRef.current = true;
      callback();
      queueMicrotask(() => {
        syncingRef.current = false;
      });
    };

    const handleBeforeScroll = () => {
      withSyncGuard(() => {
        syncScrollPosition(beforeBody, [afterBody], "top");
        syncScrollPosition(beforeBody, [beforeHead, afterBody, afterHead], "left");
      });
    };

    const handleAfterScroll = () => {
      withSyncGuard(() => {
        syncScrollPosition(afterBody, [beforeBody], "top");
        syncScrollPosition(afterBody, [afterHead, beforeBody, beforeHead], "left");
      });
    };

    const handleBeforeHeadScroll = () => {
      withSyncGuard(() => {
        syncScrollPosition(beforeHead, [beforeBody, afterHead, afterBody], "left");
      });
    };

    const handleAfterHeadScroll = () => {
      withSyncGuard(() => {
        syncScrollPosition(afterHead, [afterBody, beforeHead, beforeBody], "left");
      });
    };

    beforeBody.addEventListener("scroll", handleBeforeScroll, { passive: true });
    afterBody.addEventListener("scroll", handleAfterScroll, { passive: true });
    beforeHead.addEventListener("scroll", handleBeforeHeadScroll, { passive: true });
    afterHead.addEventListener("scroll", handleAfterHeadScroll, { passive: true });

    beforeHead.scrollLeft = beforeBody.scrollLeft;
    afterHead.scrollLeft = beforeBody.scrollLeft;
    afterBody.scrollLeft = beforeBody.scrollLeft;
    afterBody.scrollTop = beforeBody.scrollTop;

    return () => {
      beforeBody.removeEventListener("scroll", handleBeforeScroll);
      afterBody.removeEventListener("scroll", handleAfterScroll);
      beforeHead.removeEventListener("scroll", handleBeforeHeadScroll);
      afterHead.removeEventListener("scroll", handleAfterHeadScroll);
    };
  }, [file, viewMode]);

  useEffect(() => {
    if (activeRowIndex < 0) {
      return;
    }

    const selector = `[data-diff-row-index="${activeRowIndex}"]`;
    const scrollTarget =
      viewMode === "inline"
        ? inlineBodyRef.current?.querySelector<HTMLElement>(selector)
        : beforeBodyRef.current?.querySelector<HTMLElement>(selector)
          ?? afterBodyRef.current?.querySelector<HTMLElement>(selector);
    scrollTarget?.scrollIntoView({ block: "center" });
  }, [activeRowIndex, file.path, viewMode]);

  const moveActiveChange = (direction: -1 | 1) => {
    if (changeRowIndices.length === 0) {
      return;
    }
    setActiveChangeIndex((current) => (current + direction + changeRowIndices.length) % changeRowIndices.length);
  };

  const renderSplitPane = (
    side: "before" | "after",
    headRef: RefObject<HTMLDivElement | null>,
    bodyRef: RefObject<HTMLDivElement | null>,
  ) => (
    <div className={`diff-pane ${side}-pane`}>
      <div
        className="diff-pane-head"
        ref={headRef}
        tabIndex={0}
        aria-label={`${side === "before" ? "Before" : "After"} 見出し`}
        onKeyDown={handleScrollablePaneKeyDown}
      >
        <div className="diff-pane-head-inner">
          <span className="diff-head-spacer" />
          <span className="diff-pane-head-label">{side === "before" ? "Before" : "After"}</span>
        </div>
      </div>
      <div
        className="diff-pane-body"
        ref={bodyRef}
        tabIndex={0}
        aria-label={`${side === "before" ? "Before" : "After"} 差分`}
        onKeyDown={handleScrollablePaneKeyDown}
      >
        <div className="diff-pane-body-inner">
          {file.diffRows.map((row, index) => (
            <div
              key={`${side}-${file.path}-${index}`}
              className={`diff-pane-row ${row.kind}${index === activeRowIndex ? " active-change" : ""}`}
              data-diff-row-index={index}
            >
              <span className="diff-line-number">{side === "before" ? row.leftNumber ?? "" : row.rightNumber ?? ""}</span>
              <code className={`diff-pane-cell ${side}`}>{side === "before" ? row.leftText ?? "" : row.rightText ?? ""}</code>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  const renderInlineRows = () => file.diffRows.flatMap((row, index) => {
    const activeClass = index === activeRowIndex ? " active-change" : "";
    if (row.kind === "add") {
      return [(
        <div key={`inline-add-${file.path}-${index}`} className={`diff-inline-row add${activeClass}`} data-diff-row-index={index}>
          <span className="diff-line-number">{row.rightNumber ?? ""}</span>
          <span className="diff-inline-marker">+</span>
          <code className="diff-pane-cell after">{row.rightText ?? ""}</code>
        </div>
      )];
    }
    if (row.kind === "delete") {
      return [(
        <div key={`inline-delete-${file.path}-${index}`} className={`diff-inline-row delete${activeClass}`} data-diff-row-index={index}>
          <span className="diff-line-number">{row.leftNumber ?? ""}</span>
          <span className="diff-inline-marker">-</span>
          <code className="diff-pane-cell before">{row.leftText ?? ""}</code>
        </div>
      )];
    }
    if (row.kind === "modify") {
      return [
        <div key={`inline-modify-before-${file.path}-${index}`} className={`diff-inline-row delete${activeClass}`} data-diff-row-index={index}>
          <span className="diff-line-number">{row.leftNumber ?? ""}</span>
          <span className="diff-inline-marker">-</span>
          <code className="diff-pane-cell before">{row.leftText ?? ""}</code>
        </div>,
        <div key={`inline-modify-after-${file.path}-${index}`} className={`diff-inline-row add${activeClass}`} data-diff-row-index={index}>
          <span className="diff-line-number">{row.rightNumber ?? ""}</span>
          <span className="diff-inline-marker">+</span>
          <code className="diff-pane-cell after">{row.rightText ?? ""}</code>
        </div>,
      ];
    }
    return [(
      <div key={`inline-context-${file.path}-${index}`} className="diff-inline-row context" data-diff-row-index={index}>
        <span className="diff-line-number">{row.rightNumber ?? row.leftNumber ?? ""}</span>
        <span className="diff-inline-marker" />
        <code className="diff-pane-cell">{row.rightText ?? row.leftText ?? ""}</code>
      </div>
    )];
  });

  return (
    <div className={`diff-viewer ${viewMode}`}>
      <div className="diff-toolbar">
        <div className="diff-toolbar-group" role="group" aria-label="Diff view mode">
          <button
            className={viewMode === "split" ? "active" : ""}
            type="button"
            onClick={() => setViewMode("split")}
          >
            Side by Side
          </button>
          <button
            className={viewMode === "inline" ? "active" : ""}
            type="button"
            onClick={() => setViewMode("inline")}
          >
            Inline
          </button>
        </div>
        <div className="diff-toolbar-group" role="group" aria-label="Change navigation">
          <button type="button" disabled={changeRowIndices.length === 0} onClick={() => moveActiveChange(-1)}>
            Previous
          </button>
          <span>{changeRowIndices.length === 0 ? "0/0" : `${activeChangeIndex + 1}/${changeRowIndices.length}`}</span>
          <button type="button" disabled={changeRowIndices.length === 0} onClick={() => moveActiveChange(1)}>
            Next
          </button>
        </div>
      </div>
      {viewMode === "split" ? (
        <div className="diff-split-view">
          {renderSplitPane("before", beforeHeadRef, beforeBodyRef)}
          {renderSplitPane("after", afterHeadRef, afterBodyRef)}
        </div>
      ) : (
        <div className="diff-inline-view">
          <div
            className="diff-pane-body"
            ref={inlineBodyRef}
            tabIndex={0}
            aria-label="Inline 差分"
            onKeyDown={handleScrollablePaneKeyDown}
          >
            <div className="diff-pane-body-inner">{renderInlineRows()}</div>
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, type KeyboardEvent } from "react";

import { fileKindLabel } from "./ui-utils.js";
import type { ChangedFile } from "./app-state.js";

type DiffViewerProps = {
  file: ChangedFile;
};

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

export function DiffViewer({ file }: DiffViewerProps) {
  const beforeHeadRef = useRef<HTMLDivElement | null>(null);
  const afterHeadRef = useRef<HTMLDivElement | null>(null);
  const beforeBodyRef = useRef<HTMLDivElement | null>(null);
  const afterBodyRef = useRef<HTMLDivElement | null>(null);
  const syncingRef = useRef(false);

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
    const beforeBody = beforeBodyRef.current;
    const afterBody = afterBodyRef.current;
    const beforeHead = beforeHeadRef.current;
    const afterHead = afterHeadRef.current;

    if (!beforeBody || !afterBody || !beforeHead || !afterHead) {
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
  }, [file]);

  return (
    <div className="diff-split-view">
      <div className="diff-pane before-pane">
        <div
          className="diff-pane-head"
          ref={beforeHeadRef}
          tabIndex={0}
          aria-label="Before 見出し"
          onKeyDown={handleScrollablePaneKeyDown}
        >
          <div className="diff-pane-head-inner">
            <span className="diff-head-spacer" />
            <span className="diff-pane-head-label">Before</span>
          </div>
        </div>
        <div
          className="diff-pane-body"
          ref={beforeBodyRef}
          tabIndex={0}
          aria-label="Before 差分"
          onKeyDown={handleScrollablePaneKeyDown}
        >
          <div className="diff-pane-body-inner">
            {file.diffRows.map((row, index) => (
              <div key={`before-${file.path}-${index}`} className={`diff-pane-row ${row.kind}`}>
                <span className="diff-line-number">{row.leftNumber ?? ""}</span>
                <code className="diff-pane-cell before">{row.leftText ?? ""}</code>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="diff-pane after-pane">
        <div
          className="diff-pane-head"
          ref={afterHeadRef}
          tabIndex={0}
          aria-label="After 見出し"
          onKeyDown={handleScrollablePaneKeyDown}
        >
          <div className="diff-pane-head-inner">
            <span className="diff-head-spacer" />
            <span className="diff-pane-head-label">After</span>
          </div>
        </div>
        <div
          className="diff-pane-body"
          ref={afterBodyRef}
          tabIndex={0}
          aria-label="After 差分"
          onKeyDown={handleScrollablePaneKeyDown}
        >
          <div className="diff-pane-body-inner">
            {file.diffRows.map((row, index) => (
              <div key={`after-${file.path}-${index}`} className={`diff-pane-row ${row.kind}`}>
                <span className="diff-line-number">{row.rightNumber ?? ""}</span>
                <code className="diff-pane-cell after">{row.rightText ?? ""}</code>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function DiffViewerSubbar({ file }: DiffViewerProps) {
  return (
    <div className="diff-subbar">
      <span className={`file-kind ${file.kind}`}>{fileKindLabel(file.kind)}</span>
    </div>
  );
}


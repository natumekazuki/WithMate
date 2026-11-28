import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";

import type { ChangedFile } from "../../src-shared/session/runtime-state.js";

/** 変更前後を描画するため、差分行を含む変更ファイルを受け取る。 */
type DiffViewerProps = {
  file: ChangedFile;
};

/** 変更前後を左右に並べるか、一列にまとめるかの表示モード。 */
type DiffViewMode = "split" | "inline";

/** 指定した軸のスクロール位置だけを、値が異なる追従先に反映する。 */
function syncScrollPosition(
  source: HTMLDivElement,
  targets: HTMLDivElement[],
  axis: "left" | "top",
) {
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

/** マウント済みのペインを縦横とも先頭に戻す。表示されていないペインは何もしない。 */
function scrollElementToTop(element: HTMLDivElement | null): void {
  element?.scrollTo({ top: 0, left: 0 });
}

/** 変更ファイルの差分を左右分割またはインラインで表示し、文脈行を除く変更位置を順にたどれるようにする。 */
export function DiffViewer({ file }: DiffViewerProps) {
  const [viewMode, setViewMode] = useState<DiffViewMode>("split");
  const [activeChangeIndex, setActiveChangeIndex] = useState(0);
  const splitViewRef = useRef<HTMLDivElement | null>(null);
  const beforeHeadRef = useRef<HTMLDivElement | null>(null);
  const afterHeadRef = useRef<HTMLDivElement | null>(null);
  const beforeBodyRef = useRef<HTMLDivElement | null>(null);
  const afterBodyRef = useRef<HTMLDivElement | null>(null);
  const inlineBodyRef = useRef<HTMLDivElement | null>(null);
  const syncingRef = useRef(false);

  const changeRowIndices = useMemo(
    () =>
      file.diffRows
        .map((row, index) => (row.kind === "context" ? -1 : index))
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

  /** フォーカス中のペインを矢印・ページ移動・先頭末尾のキーでスクロールする。 */
  const handleScrollablePaneKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
  ) => {
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
        element.scrollTo({
          top: element.scrollHeight,
          left: element.scrollLeft,
        });
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

  useLayoutEffect(() => {
    const splitView = splitViewRef.current;
    const beforeBody = beforeBodyRef.current;
    const afterBody = afterBodyRef.current;
    const beforeHead = beforeHeadRef.current;
    const afterHead = afterHeadRef.current;
    if (!splitView || !beforeBody || !afterBody || !beforeHead || !afterHead) {
      return;
    }

    /** 左右の本文で大きい方のはみ出し量を共通の横幅に反映し、各ペインの横位置を揃え直す。 */
    const updateScrollRange = () => {
      const scrollLeft = beforeBody.scrollLeft;
      // すべてのペインを同じ量だけ拡張する前に、元のはみ出し量を測る。
      splitView.style.removeProperty("--diff-overflow-width");
      const overflowWidth = Math.max(
        beforeBody.scrollWidth - beforeBody.clientWidth,
        afterBody.scrollWidth - afterBody.clientWidth,
      );
      splitView.style.setProperty(
        "--diff-overflow-width",
        `${overflowWidth}px`,
      );
      for (const pane of [beforeBody, afterBody, beforeHead, afterHead]) {
        pane.scrollLeft = scrollLeft;
      }
    };

    updateScrollRange();
    const observer = new ResizeObserver(updateScrollRange);
    for (const body of [beforeBody, afterBody]) {
      observer.observe(body);
      observer.observe(body.firstElementChild!);
    }
    return () => observer.disconnect();
  }, [file, viewMode]);

  useEffect(() => {
    const beforeBody = beforeBodyRef.current;
    const afterBody = afterBodyRef.current;
    const beforeHead = beforeHeadRef.current;
    const afterHead = afterHeadRef.current;

    if (
      !beforeBody ||
      !afterBody ||
      !beforeHead ||
      !afterHead ||
      viewMode !== "split"
    ) {
      return;
    }

    /** スクロール同期中の再入を防ぎ、マイクロタスクで次の同期を受け付ける状態に戻す。 */
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

    /** 変更前本文の縦位置を変更後本文へ、横位置を残りの三つのペインへ同期する。 */
    const handleBeforeScroll = () => {
      withSyncGuard(() => {
        syncScrollPosition(beforeBody, [afterBody], "top");
        syncScrollPosition(
          beforeBody,
          [beforeHead, afterBody, afterHead],
          "left",
        );
      });
    };

    /** 変更後本文の縦位置を変更前本文へ戻し、見出しも含めて横位置を同期する。 */
    const handleAfterScroll = () => {
      withSyncGuard(() => {
        syncScrollPosition(afterBody, [beforeBody], "top");
        syncScrollPosition(
          afterBody,
          [afterHead, beforeBody, beforeHead],
          "left",
        );
      });
    };

    /** 変更前見出しを起点に、両本文と変更後見出しの横位置を揃える。 */
    const handleBeforeHeadScroll = () => {
      withSyncGuard(() => {
        syncScrollPosition(
          beforeHead,
          [beforeBody, afterHead, afterBody],
          "left",
        );
      });
    };

    /** 変更後見出しを起点に、両本文と変更前見出しの横位置を揃える。 */
    const handleAfterHeadScroll = () => {
      withSyncGuard(() => {
        syncScrollPosition(
          afterHead,
          [afterBody, beforeHead, beforeBody],
          "left",
        );
      });
    };

    beforeBody.addEventListener("scroll", handleBeforeScroll, {
      passive: true,
    });
    afterBody.addEventListener("scroll", handleAfterScroll, { passive: true });
    beforeHead.addEventListener("scroll", handleBeforeHeadScroll, {
      passive: true,
    });
    afterHead.addEventListener("scroll", handleAfterHeadScroll, {
      passive: true,
    });

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
        : (beforeBodyRef.current?.querySelector<HTMLElement>(selector) ??
          afterBodyRef.current?.querySelector<HTMLElement>(selector));
    scrollTarget?.scrollIntoView({ block: "center" });
  }, [activeRowIndex, file.path, viewMode]);

  /** 変更行の選択を前後に進め、先頭・末尾を越える場合は反対側へ回り込む。 */
  const moveActiveChange = (direction: -1 | 1) => {
    if (changeRowIndices.length === 0) {
      return;
    }
    setActiveChangeIndex(
      (current) =>
        (current + direction + changeRowIndices.length) %
        changeRowIndices.length,
    );
  };

  /** 指定側の行番号と本文だけを描画し、行がない側も空欄を残して左右の差分行を対応させる。 */
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
        aria-label={`${side === "before" ? "Before" : "After"} heading`}
        onKeyDown={handleScrollablePaneKeyDown}
      >
        <div className="diff-pane-head-inner">
          <span className="diff-head-spacer" />
          <span className="diff-pane-head-label">
            {side === "before" ? "Before" : "After"}
          </span>
        </div>
      </div>
      <div
        className="diff-pane-body"
        ref={bodyRef}
        tabIndex={0}
        aria-label={`${side === "before" ? "Before" : "After"} diff`}
        onKeyDown={handleScrollablePaneKeyDown}
      >
        <div className="diff-pane-body-inner">
          {file.diffRows.map((row, index) => (
            <div
              key={`${side}-${file.path}-${index}`}
              className={`diff-pane-row ${row.kind}${index === activeRowIndex ? " active-change" : ""}`}
              data-diff-row-index={index}
            >
              <span className="diff-line-number">
                {side === "before"
                  ? (row.leftNumber ?? "")
                  : (row.rightNumber ?? "")}
              </span>
              <code className={`diff-pane-cell ${side}`}>
                {side === "before"
                  ? (row.leftText ?? "")
                  : (row.rightText ?? "")}
              </code>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  /** 変更前後を一列にまとめ、置換行は削除・追加の二行に分けて表示する。 */
  const renderInlineRows = () =>
    file.diffRows.flatMap((row, index) => {
      const activeClass = index === activeRowIndex ? " active-change" : "";
      if (row.kind === "add") {
        return [
          <div
            key={`inline-add-${file.path}-${index}`}
            className={`diff-inline-row add${activeClass}`}
            data-diff-row-index={index}
          >
            <span className="diff-line-number">{row.rightNumber ?? ""}</span>
            <span className="diff-inline-marker">+</span>
            <code className="diff-pane-cell after">{row.rightText ?? ""}</code>
          </div>,
        ];
      }
      if (row.kind === "delete") {
        return [
          <div
            key={`inline-delete-${file.path}-${index}`}
            className={`diff-inline-row delete${activeClass}`}
            data-diff-row-index={index}
          >
            <span className="diff-line-number">{row.leftNumber ?? ""}</span>
            <span className="diff-inline-marker">-</span>
            <code className="diff-pane-cell before">{row.leftText ?? ""}</code>
          </div>,
        ];
      }
      if (row.kind === "modify") {
        return [
          <div
            key={`inline-modify-before-${file.path}-${index}`}
            className={`diff-inline-row delete${activeClass}`}
            data-diff-row-index={index}
          >
            <span className="diff-line-number">{row.leftNumber ?? ""}</span>
            <span className="diff-inline-marker">-</span>
            <code className="diff-pane-cell before">{row.leftText ?? ""}</code>
          </div>,
          <div
            key={`inline-modify-after-${file.path}-${index}`}
            className={`diff-inline-row add${activeClass}`}
            data-diff-row-index={index}
          >
            <span className="diff-line-number">{row.rightNumber ?? ""}</span>
            <span className="diff-inline-marker">+</span>
            <code className="diff-pane-cell after">{row.rightText ?? ""}</code>
          </div>,
        ];
      }
      return [
        <div
          key={`inline-context-${file.path}-${index}`}
          className="diff-inline-row context"
          data-diff-row-index={index}
        >
          <span className="diff-line-number">
            {row.rightNumber ?? row.leftNumber ?? ""}
          </span>
          <span className="diff-inline-marker" />
          <code className="diff-pane-cell">
            {row.rightText ?? row.leftText ?? ""}
          </code>
        </div>,
      ];
    });

  return (
    <div className={`diff-viewer ${viewMode}`}>
      <div className="diff-toolbar">
        <div
          className="diff-toolbar-group"
          role="group"
          aria-label="Diff view mode"
        >
          <button
            className={viewMode === "split" ? "active" : ""}
            type="button"
            aria-pressed={viewMode === "split"}
            onClick={() => setViewMode("split")}
          >
            Side By Side
          </button>
          <button
            className={viewMode === "inline" ? "active" : ""}
            type="button"
            aria-pressed={viewMode === "inline"}
            onClick={() => setViewMode("inline")}
          >
            Inline
          </button>
        </div>
        <div
          className="diff-toolbar-group"
          role="group"
          aria-label="Change navigation"
        >
          <button
            type="button"
            disabled={changeRowIndices.length === 0}
            onClick={() => moveActiveChange(-1)}
          >
            Previous
          </button>
          <span>
            {changeRowIndices.length === 0
              ? "0/0"
              : `${activeChangeIndex + 1}/${changeRowIndices.length}`}
          </span>
          <button
            type="button"
            disabled={changeRowIndices.length === 0}
            onClick={() => moveActiveChange(1)}
          >
            Next
          </button>
        </div>
      </div>
      {viewMode === "split" ? (
        <div className="diff-split-view" ref={splitViewRef}>
          {renderSplitPane("before", beforeHeadRef, beforeBodyRef)}
          {renderSplitPane("after", afterHeadRef, afterBodyRef)}
        </div>
      ) : (
        <div className="diff-inline-view">
          <div
            className="diff-pane-body"
            ref={inlineBodyRef}
            tabIndex={0}
            aria-label="Inline diff"
            onKeyDown={handleScrollablePaneKeyDown}
          >
            <div className="diff-pane-body-inner">{renderInlineRows()}</div>
          </div>
        </div>
      )}
    </div>
  );
}

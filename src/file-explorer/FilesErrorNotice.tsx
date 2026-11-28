import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

/** ファイルまたはピンの取得失敗を通知し、再試行と開閉可能な詳細を提示する。 */
export function FilesErrorNotice({
  target,
  label,
  message,
  onRetry,
  recoveryHint,
  boundaryRef,
}: {
  target: "Files" | "Pins";
  label: string;
  message: string;
  onRetry: () => void;
  recoveryHint?: string;
  boundaryRef: RefObject<HTMLDivElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [position, setPosition] = useState<CSSProperties>({
    visibility: "hidden",
  });
  const isPositioned = position.visibility !== "hidden";
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    /** パネルの境界と表示領域を基準に詳細の位置・高さを決め、操作欄の配色を引き継ぐ。 */
    const updatePosition = () => {
      const actions = actionsRef.current;
      const panel = panelRef.current;
      const boundary = boundaryRef.current;
      if (!actions || !panel || !boundary) return;
      const margin = 16;
      const gap = 8;
      const anchorRect = boundary.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const below = anchorRect.bottom + gap;
      const belowSpace = Math.max(0, window.innerHeight - margin - below);
      const aboveSpace = Math.max(0, anchorRect.top - gap - margin);
      const contentHeight =
        panel.scrollHeight + panel.offsetHeight - panel.clientHeight;
      const useBelow =
        belowSpace >= Math.min(contentHeight, 320) || belowSpace >= aboveSpace;
      const maxHeight = Math.min(320, useBelow ? belowSpace : aboveSpace);
      const styles = window.getComputedStyle(actions);
      const theme = Object.fromEntries(
        [
          "--ink",
          "--muted",
          "--line",
          "--surface-strong",
          "--shadow",
          "--character-sub",
          "--character-sub-soft",
          "--scrollbar-track",
          "--scrollbar-thumb",
          "--scrollbar-thumb-hover",
        ].map((property) => [property, styles.getPropertyValue(property)]),
      );
      setPosition({
        ...theme,
        left: Math.max(
          margin,
          Math.min(
            anchorRect.left,
            window.innerWidth - panelRect.width - margin,
          ),
        ),
        top: Math.max(
          margin,
          useBelow
            ? below
            : anchorRect.top - gap - Math.min(contentHeight, maxHeight),
        ),
        maxHeight,
      });
    };
    updatePosition();
    const observer = new window.ResizeObserver(updatePosition);
    if (boundaryRef.current) observer.observe(boundaryRef.current);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, message, boundaryRef]);

  useEffect(() => {
    if (open && isPositioned) panelRef.current?.focus();
  }, [open, isPositioned]);

  useEffect(() => {
    if (!open) return;
    /** 詳細や操作欄の外を押した場合は、押した先のフォーカスを妨げずに閉じる。 */
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        !panelRef.current?.contains(target) &&
        !actionsRef.current?.contains(target)
      )
        close(false);
    };
    /** 詳細を表示中の Escape で閉じ、開閉ボタンへフォーカスを戻す。 */
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  return (
    <div className="session-file-tree-error session-files-error" role="alert">
      <span className="visually-hidden">{label}</span>
      <div className="session-files-error-actions" ref={actionsRef}>
        <button
          ref={triggerRef}
          className="session-file-explorer-refresh session-files-error-toggle"
          type="button"
          aria-label={`${target} Error Details`}
          title={`${target} Error Details`}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-haspopup="dialog"
          onClick={() => setOpen((current) => !current)}
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            aria-hidden="true"
            focusable="false"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v6m0 4h.01" />
          </svg>
        </button>
        <button
          className="session-file-explorer-refresh"
          type="button"
          onClick={() => {
            close(false);
            onRetry();
          }}
        >
          Retry {target}
        </button>
      </div>
      {recoveryHint ? (
        <p className="session-files-error-hint">{recoveryHint}</p>
      ) : null}
      {open
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              className="session-files-error-popover"
              role="dialog"
              aria-label={`${target} Error Details`}
              tabIndex={-1}
              style={position}
              onKeyDown={(event) => {
                if (
                  event.key === "Tab" &&
                  (event.shiftKey || event.target !== event.currentTarget)
                ) {
                  close(true);
                  if (event.shiftKey) event.preventDefault();
                }
              }}
            >
              <button
                className="session-file-explorer-refresh session-files-error-close"
                type="button"
                aria-label="Close Error Details"
                title="Close Error Details"
                onClick={() => close(true)}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="m6 6 12 12M18 6 6 18" />
                </svg>
              </button>
              <p>{message}</p>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

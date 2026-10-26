import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export type MemoryReviewFailure = { message: string; notice?: string };

export function MemoryReviewError({ label, message, notice, children, recoveryRef }: MemoryReviewFailure & {
  label: string;
  children?: ReactNode;
  recoveryRef?: RefObject<HTMLElement | null>;
}) {
  const id = useId();
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const anchor = actionsRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const margin = 16;
      const gap = 8;
      const anchorRect = anchor.getBoundingClientRect();
      const recoveryRect = recoveryRef?.current?.getBoundingClientRect();
      const protectedTop = Math.min(anchorRect.top, recoveryRect?.top ?? anchorRect.top);
      const protectedBottom = Math.max(anchorRect.bottom, recoveryRect?.bottom ?? anchorRect.bottom);
      const below = protectedBottom + gap;
      const belowSpace = Math.max(0, window.innerHeight - margin - below);
      const aboveSpace = Math.max(0, protectedTop - gap - margin);
      const contentHeight = panel.scrollHeight + panel.offsetHeight - panel.clientHeight;
      const useBelow = belowSpace >= Math.min(contentHeight, 320) || belowSpace >= aboveSpace;
      const maxHeight = Math.min(320, useBelow ? belowSpace : aboveSpace);
      const styles = window.getComputedStyle(anchor);
      const theme = Object.fromEntries(
        ["--ink", "--line"].map((property) => [property, styles.getPropertyValue(property)]),
      );
      setPosition({
        ...theme,
        left: Math.max(margin, Math.min(anchorRect.left, window.innerWidth - panel.getBoundingClientRect().width - margin)),
        top: Math.max(margin, useBelow ? below : protectedTop - gap - Math.min(contentHeight, maxHeight)),
        maxHeight,
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, message, recoveryRef]);

  useEffect(() => {
    if (open && position.visibility !== "hidden") panelRef.current?.focus();
  }, [open, position.visibility]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !panelRef.current?.contains(target) && !actionsRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <div className="memory-review-error">
      <span className="visually-hidden" role="alert">{label}</span>
      <div ref={actionsRef} className="memory-review-error-actions">
        <button
          ref={triggerRef}
          type="button"
          className="launch-toggle memory-review-error-toggle"
          aria-label={`${open ? "Hide" : "Show"} ${label}`}
          title={open ? "Hide Error Details" : "Show Error Details"}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-controls={open ? id : undefined}
          onClick={() => setOpen((value) => !value)}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v6m0 4h.01" />
          </svg>
        </button>
        {notice ? <p>{notice}</p> : null}
        {children ? <div className="memory-review-error-recovery" onClick={() => close(false)}>{children}</div> : null}
      </div>
      {open ? createPortal(
        <div
          ref={panelRef}
          id={id}
          className="memory-review-error-popover"
          role="dialog"
          aria-label={label}
          tabIndex={-1}
          style={position}
          onKeyDown={(event) => {
            if (event.key === "Tab" && (event.shiftKey || event.target !== event.currentTarget)) {
              close(true);
              if (event.shiftKey) event.preventDefault();
            }
          }}
        >
          <button className="launch-toggle memory-review-error-close" type="button" aria-label="Close Error Details" title="Close Error Details" onClick={() => close(true)}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true" focusable="false">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
          <p>{message}</p>
        </div>,
        actionsRef.current?.closest('[role="dialog"]') ?? document.body,
      ) : null}
    </div>
  );
}

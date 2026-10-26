import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { ComposerIcon } from "./composer-icon.js";

export function ComposerErrorDetails({ label, message }: { label: string; message: string }) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const positioned = position.visibility !== "hidden";
  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (!open) {
      setPosition({ visibility: "hidden" });
      return;
    }
    const updatePosition = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      // Keep the entire recovery row, including wrapped buttons, unobscured.
      const anchor = (trigger.closest(".composer-save-feedback") ?? trigger).getBoundingClientRect();
      const margin = 16;
      const gap = 8;
      const above = Math.max(0, anchor.top - gap - margin);
      const below = Math.max(0, window.innerHeight - anchor.bottom - gap - margin);
      const useAbove = above >= below;
      const maxHeight = Math.min(320, useAbove ? above : below);
      const height = Math.min(panel.scrollHeight + panel.offsetHeight - panel.clientHeight, maxHeight);
      const styles = window.getComputedStyle(trigger);
      setPosition({
        ...Object.fromEntries(["--ink", "--line", "--surface-strong"].map((name) => [name, styles.getPropertyValue(name)])),
        left: Math.max(margin, Math.min(anchor.left, window.innerWidth - panel.getBoundingClientRect().width - margin)),
        top: useAbove ? anchor.top - gap - height : anchor.bottom + gap,
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
  }, [open, message]);

  useEffect(() => {
    if (open && positioned) panelRef.current?.focus({ preventScroll: true });
  }, [open, positioned]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return <>
    <button
      ref={triggerRef}
      type="button"
      className="drawer-toggle compact secondary composer-error-details-trigger"
      aria-label={label}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-controls={open ? id : undefined}
      onClick={() => setOpen(!open)}
    >
      <ComposerIcon name="error" />
      <span>Details</span>
    </button>
    {open ? createPortal(
      <div
        ref={panelRef}
        id={id}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        className="composer-error-details-popover"
        style={position}
        onKeyDown={(event) => {
          if (event.key === "Tab" && (event.shiftKey || event.target !== event.currentTarget)) {
            close(true);
            if (event.shiftKey) event.preventDefault();
          }
        }}
      >
        <button className="composer-error-details-close" type="button" aria-label="Close Error Details" onClick={() => close(true)}>
          <ComposerIcon name="close" />
        </button>
        <p>{message}</p>
      </div>,
      document.body,
    ) : null}
  </>;
}

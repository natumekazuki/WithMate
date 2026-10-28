import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { CloseButton } from "./close-button.js";

export function ErrorDetailsButton({ message, label }: { message: string; label: string }) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const anchor = triggerRef.current!;
      const panel = panelRef.current!;
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(420, window.innerWidth - 24);
      const above = Math.max(0, rect.top - 20);
      const below = Math.max(0, window.innerHeight - rect.bottom - 20);
      const placeAbove = above >= Math.min(panel.scrollHeight, 320) || above >= below;
      const style = window.getComputedStyle(anchor);
      setPosition({
        ...Object.fromEntries(["--ink", "--muted", "--line", "--surface-strong", "--shadow"]
          .map((property) => [property, style.getPropertyValue(property)])),
        width,
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        ...(placeAbove ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }),
        maxHeight: Math.min(320, placeAbove ? above : below),
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (open && position.visibility !== "hidden") panelRef.current?.focus();
  }, [open, position.visibility]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) close(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  return <>
    <button ref={triggerRef} className="error-details-trigger" type="button"
      aria-label={label} title={label}
      aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog"
      onClick={() => open ? close(true) : setOpen(true)}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M12 3 2 21h20L12 3Z" /><path d="M12 9v5m0 3v1" />
      </svg>
    </button>
    {open && createPortal(<div id={id} ref={panelRef} className="error-details-popover" role="dialog"
      aria-label={label} tabIndex={-1} style={position}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        } else if (event.key === "Tab" && (event.shiftKey || event.target !== event.currentTarget)) {
          if (event.shiftKey) event.preventDefault();
          close(true);
        }
      }}>
      <CloseButton ariaLabel="Close Error Details" onClose={() => close(true)} />
      <p>{message}</p>
    </div>, document.body)}
  </>;
}

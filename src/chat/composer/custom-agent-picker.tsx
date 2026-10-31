import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { focusRovingItemByKey } from "../../ui/a11y.js";
import { LoadingIndicator } from "../../ui/loading-indicator.js";
import { ComposerIcon } from "./composer-icon.js";

export type SessionCustomAgentItem = {
  key: string;
  value: string | null;
  primaryLabel: string;
  secondaryLabel: string;
  title: string;
  isSelected: boolean;
};

export function CustomAgentPicker({ items, isOpen, loading, disabled, label, title, onToggle, onClose, onSelect }: {
  items: SessionCustomAgentItem[];
  isOpen: boolean;
  loading: boolean;
  disabled: boolean;
  label: string;
  title: string;
  onToggle: () => void;
  onClose: () => void;
  onSelect: (value: string | null) => void;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const open = isOpen && !disabled;
  const positioned = position.visibility !== "hidden";
  const close = (returnFocus: boolean) => {
    onClose();
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (!open) {
      setPosition({ visibility: "hidden" });
      return;
    }
    const update = () => {
      const trigger = triggerRef.current!;
      const rect = trigger.getBoundingClientRect();
      const viewport = window.visualViewport;
      const leftEdge = (viewport?.offsetLeft ?? 0) + 12;
      const topEdge = (viewport?.offsetTop ?? 0) + 12;
      const rightEdge = leftEdge + (viewport?.width ?? window.innerWidth) - 24;
      const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - 24;
      const above = Math.max(0, rect.top - topEdge - 8);
      const below = Math.max(0, bottomEdge - rect.bottom - 8);
      const placeAbove = above >= below;
      const style = window.getComputedStyle(trigger);
      const width = Math.min(400, rightEdge - leftEdge);
      setPosition({
        ...Object.fromEntries(["--ink", "--muted", "--surface-strong", "--surface-deep", "--line", "--character-main", "--shadow"]
          .map((property) => [property, style.getPropertyValue(property)])),
        width,
        left: Math.max(leftEdge, Math.min(rect.left, rightEdge - width)),
        ...(placeAbove ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }),
        maxHeight: Math.min(360, placeAbove ? above : below),
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !positioned) return;
    const list = listRef.current;
    // Preserve navigation when the owner refreshes the same candidate list.
    if (list?.contains(document.activeElement)) return;
    const option = list?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?? list?.querySelector<HTMLElement>('[role="option"]');
    (option ?? panelRef.current)?.focus({ preventScroll: true });
    option?.scrollIntoView({ block: "nearest" });
  }, [open, positioned, loading, items.length]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) onClose();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [open, onClose]);

  return <div className="composer-agent-toolbar">
    <button ref={triggerRef} className={`drawer-toggle compact secondary composer-skill-button composer-icon-button${open ? " is-open" : ""}`}
      type="button" disabled={disabled} aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? id : undefined}
      aria-label={`Custom Agent: ${label}`} title={`Custom Agent: ${title}`} onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!open) onToggle();
          else (listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
            ?? listRef.current?.querySelector<HTMLElement>('[role="option"]'))?.focus();
        }
      }}>
      <ComposerIcon name="agent" />
      <span className="visually-hidden">{label}</span>
    </button>
    {open ? createPortal(<div ref={panelRef} className="composer-agent-popover" style={position} tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        } else if (event.key === "Tab") {
          // Resume native tab order at the trigger instead of the body portal.
          close(true);
        }
      }}>
      <div className="composer-agent-heading">
        <span>Custom Agent</span>
        <button type="button" aria-label="Close Agent Picker" title="Close Agent Picker" onClick={() => close(true)}><ComposerIcon name="close" /></button>
      </div>
      <div id={id} ref={listRef} role="listbox" aria-label="Custom Agent Options" aria-orientation="vertical"
        aria-busy={loading || undefined} className="composer-agent-list"
        onKeyDown={(event) => {
          focusRovingItemByKey(event, { orientation: "vertical", selector: '[role="option"]' });
        }}>
        {loading ? <LoadingIndicator label="Loading Custom Agents" /> : items.map((item, index) => <button
          key={item.key} type="button" role="option" aria-selected={item.isSelected}
          tabIndex={item.isSelected || (!items.some((entry) => entry.isSelected) && index === 0) ? 0 : -1}
          className="composer-agent-option" title={item.title} onClick={() => {
            // Selection persists asynchronously. Keep focus at its surviving origin.
            triggerRef.current?.focus({ preventScroll: true });
            onSelect(item.value);
          }}>
          <span className="composer-agent-check" aria-hidden="true">{item.isSelected ? "✓" : ""}</span>
          <span className="composer-agent-copy"><span>{item.primaryLabel}</span><small>{item.secondaryLabel}</small></span>
        </button>)}
      </div>
    </div>, document.body) : null}
  </div>;
}

import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type CSSProperties } from "react";
import { CloseButton } from "../ui/close-button.js";

// The existing action button remains the recovery path; details never replace it.
export function SettingsActionButton({
  failure,
  actionLabel,
  ...buttonProps
}: ButtonHTMLAttributes<HTMLButtonElement> & { failure?: string; actionLabel: string }) {
  const id = useId();
  const groupRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});

  useEffect(() => {
    if (!failure) setExpanded(false);
  }, [failure]);

  const updatePosition = () => {
    const group = groupRef.current;
    const panel = panelRef.current;
    if (!group || !panel) return;
    const rect = group.getBoundingClientRect();
    const margin = 12;
    const gap = 8;
    const region = group.closest(".settings-panel-window-scroll")?.getBoundingClientRect();
    const top = Math.max(margin, region?.top ?? margin);
    const bottom = Math.min(window.innerHeight - margin, region?.bottom ?? window.innerHeight - margin);
    if (rect.bottom <= top || rect.top >= bottom) {
      panel.hidePopover();
      return;
    }
    const width = Math.min(360, window.innerWidth - margin * 2);
    const above = Math.max(0, rect.top - gap - top);
    const below = Math.max(0, bottom - rect.bottom - gap);
    const placeAbove = above >= below;
    setPosition({
      width,
      left: Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin)),
      maxHeight: Math.min(320, placeAbove ? above : below),
      ...(placeAbove
        ? { bottom: window.innerHeight - rect.top + gap, top: "auto" }
        : { top: rect.bottom + gap, bottom: "auto" }),
    });
  };

  useEffect(() => {
    if (!expanded) return;
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [expanded]);

  return (
    <span className="settings-action-control" ref={groupRef}>
      <button {...buttonProps} />
      <span className="settings-action-error-slot">
        {failure ? <>
          <span className="sr-only" role="status">{actionLabel} failed.</span>
          <button
            className="settings-action-error-trigger"
            type="button"
            ref={triggerRef}
            popoverTarget={id}
            aria-label={`${actionLabel} failed. Show error details`}
            title={`${actionLabel} Failed — Error Details`}
            aria-expanded={expanded}
            aria-controls={id}
            onClick={updatePosition}
          >
            <span aria-hidden="true">!</span>
          </button>
          <div
            className="settings-action-error-popover"
            id={id}
            ref={panelRef}
            popover="auto"
            role="dialog"
            aria-label={`${actionLabel} error details`}
            tabIndex={-1}
            style={position}
            onToggle={(event) => {
              const open = event.currentTarget.matches(":popover-open");
              setExpanded(open);
              if (open) event.currentTarget.focus();
            }}
          >
            <CloseButton ariaLabel="Close error details" onClose={() => {
              panelRef.current?.hidePopover();
              triggerRef.current?.focus();
            }} />
            <p>{failure}</p>
          </div>
        </> : null}
      </span>
    </span>
  );
}

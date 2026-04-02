import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled]):not([type=\"hidden\"])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(", ");

export type RovingOrientation = "horizontal" | "vertical" | "both";

export function getNextRovingIndex(
  currentIndex: number,
  itemCount: number,
  key: string,
  orientation: RovingOrientation,
): number | null {
  if (itemCount <= 0) {
    return null;
  }

  if (key === "Home") {
    return 0;
  }

  if (key === "End") {
    return itemCount - 1;
  }

  const normalizedCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
  const allowHorizontal = orientation === "horizontal" || orientation === "both";
  const allowVertical = orientation === "vertical" || orientation === "both";

  if (allowHorizontal && key === "ArrowRight") {
    return (normalizedCurrentIndex + 1) % itemCount;
  }

  if (allowHorizontal && key === "ArrowLeft") {
    return (normalizedCurrentIndex - 1 + itemCount) % itemCount;
  }

  if (allowVertical && key === "ArrowDown") {
    return (normalizedCurrentIndex + 1) % itemCount;
  }

  if (allowVertical && key === "ArrowUp") {
    return (normalizedCurrentIndex - 1 + itemCount) % itemCount;
  }

  return null;
}

function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) {
    return [];
  }

  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

function getCurrentRovingIndex(items: HTMLElement[]): number {
  const activeElement = typeof document === "undefined" ? null : document.activeElement;
  const focusedIndex = items.findIndex((item) => item === activeElement);
  if (focusedIndex >= 0) {
    return focusedIndex;
  }

  const selectedIndex = items.findIndex((item) =>
    item.getAttribute("aria-selected") === "true" || item.getAttribute("aria-checked") === "true"
  );
  return selectedIndex >= 0 ? selectedIndex : 0;
}

export function focusRovingItemByKey(
  event: ReactKeyboardEvent<HTMLElement>,
  options: {
    orientation: RovingOrientation;
    selector?: string;
    activateOnFocus?: boolean;
  },
): HTMLElement | null {
  const selector = options.selector ?? "[role=\"option\"], [role=\"radio\"], button:not([disabled])";
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(selector));
  const nextIndex = getNextRovingIndex(
    getCurrentRovingIndex(items),
    items.length,
    event.key,
    options.orientation,
  );

  if (nextIndex === null) {
    return null;
  }

  const nextItem = items[nextIndex] ?? null;
  if (!nextItem) {
    return null;
  }

  event.preventDefault();
  nextItem.focus();
  if (options.activateOnFocus) {
    nextItem.click();
  }
  return nextItem;
}

function trapDialogTabKey(root: HTMLElement | null, event: ReactKeyboardEvent<HTMLElement>): boolean {
  if (event.key !== "Tab") {
    return false;
  }

  const focusable = getFocusableElements(root);
  if (focusable.length === 0) {
    event.preventDefault();
    return true;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const activeElement = typeof document === "undefined" ? null : document.activeElement;

  if (event.shiftKey && activeElement === first) {
    event.preventDefault();
    last?.focus();
    return true;
  }

  if (!event.shiftKey && activeElement === last) {
    event.preventDefault();
    first?.focus();
    return true;
  }

  return false;
}

export function useDialogA11y<T extends HTMLElement>(options: {
  open: boolean;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  const { open, onClose, initialFocusRef } = options;
  const dialogRef = useRef<T | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const previousFocused = typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    const focusTarget = () => {
      const initialFocus = initialFocusRef?.current;
      if (initialFocus) {
        initialFocus.focus();
        return;
      }

      const [firstFocusable] = getFocusableElements(dialogRef.current);
      firstFocusable?.focus();
    };

    const timeoutId = window.setTimeout(focusTarget, 0);
    return () => {
      window.clearTimeout(timeoutId);
      previousFocused?.focus();
    };
  }, [open, initialFocusRef]);

  const handleDialogKeyDown = (event: ReactKeyboardEvent<T>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }

    trapDialogTabKey(dialogRef.current, event as ReactKeyboardEvent<HTMLElement>);
  };

  return { dialogRef, handleDialogKeyDown };
}

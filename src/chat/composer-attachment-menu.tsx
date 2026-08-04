import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { focusRovingItemByKey } from "../a11y.js";

type ComposerAttachmentMenuProps = {
  disabled: boolean;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  onPickFile: () => void;
  onPickFolder: () => void;
  onPickImage: () => void;
  onAddToSessionFiles: () => void;
  onPickSessionFiles: () => void;
  onPickSessionFolder: () => void;
  onPickSessionImage: () => void;
};

type ComposerAttachmentMenuItem = {
  label: string;
  ariaLabel: string;
  title: string;
  onSelect: () => void;
};

const MENU_VIEWPORT_MARGIN = 16;
const MENU_GAP = 8;

type ComposerAttachmentMenuPosition = {
  left: number;
  top: number;
  theme: Record<string, string>;
};

const MENU_THEME_PROPERTIES = ["--ink", "--muted", "--character-main-soft"] as const;

export function ComposerAttachmentMenu({
  disabled,
  isOpen,
  onOpenChange,
  onPickFile,
  onPickFolder,
  onPickImage,
  onAddToSessionFiles,
  onPickSessionFiles,
  onPickSessionFolder,
  onPickSessionImage,
}: ComposerAttachmentMenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = useState<ComposerAttachmentMenuPosition | null>(null);

  const attachItems: ComposerAttachmentMenuItem[] = [
    {
      label: "File",
      ariaLabel: "元のファイルを参照として添付",
      title: "Pick a file and insert its original path as a reference",
      onSelect: onPickFile,
    },
    {
      label: "Folder",
      ariaLabel: "元のフォルダーを参照として添付",
      title: "Pick a folder and insert its original path as a reference",
      onSelect: onPickFolder,
    },
    {
      label: "Image",
      ariaLabel: "元の画像を参照として添付",
      title: "Pick an image and insert its original path as a reference",
      onSelect: onPickImage,
    },
  ];
  const sessionItems: ComposerAttachmentMenuItem[] = [
    {
      label: "Copy",
      ariaLabel: "ファイルをSession Filesへコピーして添付",
      title: "Copy files into Session Files and insert references",
      onSelect: onAddToSessionFiles,
    },
    {
      label: "File",
      ariaLabel: "Session Files内のファイルを添付",
      title: "Pick files from Session Files and insert references",
      onSelect: onPickSessionFiles,
    },
    {
      label: "Folder",
      ariaLabel: "Session Files内のフォルダーを添付",
      title: "Pick a folder from Session Files and insert a reference",
      onSelect: onPickSessionFolder,
    },
    {
      label: "Image",
      ariaLabel: "Session Files内の画像を添付",
      title: "Pick an image from Session Files and insert a reference",
      onSelect: onPickSessionImage,
    },
  ];

  useEffect(() => {
    if (isOpen) {
      menuRef.current?.querySelector<HTMLElement>("[role=\"menuitem\"]")?.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      if (
        event.target
        && !rootRef.current?.contains(event.target as Node)
        && !menuRef.current?.contains(event.target as Node)
      ) {
        onOpenChange(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
  }, [isOpen, onOpenChange]);

  useLayoutEffect(() => {
    if (!isOpen) {
      setMenuPosition(null);
      return;
    }

    const updateMenuPosition = () => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      const root = rootRef.current;
      if (!trigger || !menu || !root) {
        return;
      }

      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const maximumLeft = Math.max(
        MENU_VIEWPORT_MARGIN,
        window.innerWidth - menuRect.width - MENU_VIEWPORT_MARGIN,
      );
      const left = Math.min(Math.max(triggerRect.left, MENU_VIEWPORT_MARGIN), maximumLeft);
      const top = Math.max(MENU_VIEWPORT_MARGIN, triggerRect.top - menuRect.height - MENU_GAP);
      const rootStyles = window.getComputedStyle(root);
      const theme = Object.fromEntries(
        MENU_THEME_PROPERTIES.flatMap((property) => {
          const value = rootStyles.getPropertyValue(property).trim();
          return value ? [[property, value]] : [];
        }),
      );

      setMenuPosition({ left, top, theme });
    };

    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [isOpen]);

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onOpenChange(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === "Tab") {
      onOpenChange(false);
      return;
    }
    focusRovingItemByKey(event, { orientation: "both" });
  };

  const renderSection = (
    sectionKey: string,
    label: string,
    items: ComposerAttachmentMenuItem[],
    firstItemIndex: number,
  ) => (
    <div className="composer-attachment-menu-section" role="group" aria-labelledby={`${sectionKey}-label`}>
      <span id={`${sectionKey}-label`} className="composer-attachment-menu-section-label">{label}</span>
      <div className="composer-attachment-menu-grid">
        {items.map((item, index) => (
          <button
            key={`${sectionKey}-${item.label}`}
            type="button"
            role="menuitem"
            tabIndex={firstItemIndex + index === 0 ? 0 : -1}
            className="composer-attachment-menu-item"
            aria-label={item.ariaLabel}
            title={item.title}
            onClick={() => {
              onOpenChange(false);
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );

  const menuStyle: CSSProperties = menuPosition
    ? { ...menuPosition.theme, left: menuPosition.left, top: menuPosition.top } as CSSProperties
    : { left: 0, top: 0, visibility: "hidden" };

  const menu = isOpen ? createPortal(
    <div
      ref={menuRef}
      id="composer-attachment-menu"
      className="composer-attachment-menu"
      role="menu"
      aria-label="添付を追加"
      style={menuStyle}
      onKeyDown={handleMenuKeyDown}
    >
      <span className="composer-attachment-menu-title">Add attachment</span>
      {renderSection("composer-attach-source", "Attach", attachItems, 0)}
      {renderSection("composer-session-files", "Session files", sessionItems, attachItems.length)}
    </div>,
    document.body,
  ) : null;

  return (
    <div ref={rootRef} className="composer-attachment-menu-shell">
      <button
        ref={triggerRef}
        className={`drawer-toggle compact secondary composer-attachment-trigger${isOpen ? " is-open" : ""}`}
        type="button"
        disabled={disabled}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-controls={isOpen ? "composer-attachment-menu" : undefined}
        onClick={() => onOpenChange(!isOpen)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            onOpenChange(true);
          }
        }}
      >
        <span className="composer-attachment-trigger-plus" aria-hidden="true">＋</span>
        Attach
      </button>
      {menu}
    </div>
  );
}

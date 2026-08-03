import { useEffect, useRef, type KeyboardEvent } from "react";

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
      rootRef.current?.querySelector<HTMLElement>("[role=\"menuitem\"]")?.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      if (event.target && !rootRef.current?.contains(event.target as Node)) {
        onOpenChange(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
  }, [isOpen, onOpenChange]);

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
      {isOpen ? (
        <div
          id="composer-attachment-menu"
          className="composer-attachment-menu"
          role="menu"
          aria-label="添付を追加"
          onKeyDown={handleMenuKeyDown}
        >
          <span className="composer-attachment-menu-title">Add attachment</span>
          {renderSection("composer-attach-source", "Attach", attachItems, 0)}
          {renderSection("composer-session-files", "Session files", sessionItems, attachItems.length)}
        </div>
      ) : null}
    </div>
  );
}

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

export type SessionSwitcherOption = {
  id: string;
  label: string;
  icon?: ReactNode;
  preview?: string;
  searchText?: string;
};

export type SessionSwitcherProps = {
  ariaLabel: string;
  options: readonly SessionSwitcherOption[];
  selectedId: string;
  onSelect: (id: string) => void;
  onMove: (direction: -1 | 1) => void;
  searchable?: boolean;
  className?: string;
};

function focusOption(list: HTMLElement | null, index: number) {
  list?.querySelectorAll<HTMLButtonElement>('[role="option"]')[index]?.focus();
}

/** Compact arrow/trigger switcher shared by context panes and Auxiliary panes. */
export function SessionSwitcher({
  ariaLabel,
  options,
  selectedId,
  onSelect,
  onMove,
  searchable = false,
  className = "",
}: SessionSwitcherProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const listId = useId();
  const selectedOption = options.find((option) => option.id === selectedId) ?? options[0];
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  const filteredOptions = normalizedQuery
    ? options.filter((option) => (option.searchText ?? `${option.label}\n${option.preview ?? ""}`)
      .toLocaleLowerCase().includes(normalizedQuery))
    : options;
  const canMove = options.length > 1;

  const close = useCallback((restoreFocus = true) => {
    setIsOpen(false);
    setSearchQuery("");
    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    if (!searchable) {
      requestAnimationFrame(() => focusOption(listRef.current, 0));
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!listRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) {
        close(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [close, isOpen, searchable]);

  const handleListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    const optionElements = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
    const currentIndex = optionElements.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (optionElements.length === 0) return;
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      focusOption(listRef.current, (currentIndex + direction + optionElements.length) % optionElements.length);
      return;
    }
    if (event.key === "Enter" && currentIndex >= 0) {
      event.preventDefault();
      optionElements[currentIndex]?.click();
    }
  };

  const currentLabel = selectedOption?.label ?? "選択なし";
  return (
    <div className={`session-switcher${className ? ` ${className}` : ""}`} aria-label={ariaLabel}>
      <button
        type="button"
        className="session-switcher-button"
        onClick={() => onMove(-1)}
        disabled={!canMove}
        aria-label="前へ"
      >‹</button>
      <button
        ref={triggerRef}
        type="button"
        className="session-switcher-current"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listId}
        onClick={() => setIsOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) {
            return;
          }
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            onMove(event.key === "ArrowLeft" ? -1 : 1);
          }
        }}
      >
        {selectedOption?.icon ? <span className="session-switcher-icon" aria-hidden="true">{selectedOption.icon}</span> : null}
        <span className="session-switcher-label">{currentLabel}</span>
        {selectedOption?.preview ? <span className="session-switcher-preview">{selectedOption.preview}</span> : null}
      </button>
      <button
        type="button"
        className="session-switcher-button"
        onClick={() => onMove(1)}
        disabled={!canMove}
        aria-label="次へ"
      >›</button>
      {isOpen ? (
        <div ref={listRef} id={listId} className="session-switcher-popover" role="listbox" aria-label={`${ariaLabel}一覧`} onKeyDown={handleListKeyDown}>
          {searchable ? (
            <input
              autoFocus
              type="search"
              className="session-switcher-search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onInput={(event) => setSearchQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) {
                  return;
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  event.stopPropagation();
                  focusOption(listRef.current, 0);
                }
              }}
              placeholder="会話を検索"
              aria-label="一覧を検索"
            />
          ) : null}
          <div className="session-switcher-options">
            {filteredOptions.length > 0 ? filteredOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={option.id === selectedId}
                className="session-switcher-option"
                onClick={() => {
                  onSelect(option.id);
                  close();
                }}
              >
                {option.icon ? <span className="session-switcher-icon" aria-hidden="true">{option.icon}</span> : null}
                <span className="session-switcher-option-copy">
                  <span className="session-switcher-option-label">{option.label}</span>
                  {option.preview ? <span className="session-switcher-option-preview">{option.preview}</span> : null}
                </span>
              </button>
            )) : <span className="session-switcher-empty">一致する候補はありません。</span>}
          </div>
        </div>
      ) : null}
    </div>
  );
}

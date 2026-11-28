import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

/** 切り替え候補の識別子と、表示・検索・処理中や未読の状態に使う情報。 */
export type SessionSwitcherOption = {
  id: string;
  label: string;
  icon?: ReactNode;
  preview?: string;
  searchText?: string;
  isProcessing?: boolean;
  hasUnreadResult?: boolean;
};

/** 現在の候補と、一覧からの選択または前後への移動を呼び出し側と接続する。 */
export type SessionSwitcherProps = {
  ariaLabel: string;
  options: readonly SessionSwitcherOption[];
  selectedId: string;
  onSelect: (id: string) => void;
  onMove: (direction: -1 | 1) => void;
  searchable?: boolean;
  className?: string;
  currentAction?: ReactNode;
  emptyLabel?: string;
};

/** 描画済みの候補のうち、一覧内の指定位置にあるボタンへフォーカスを移す。 */
function focusOption(list: HTMLElement | null, index: number) {
  list?.querySelectorAll<HTMLButtonElement>('[role="option"]')[index]?.focus();
}

/** アイコンがある候補に限り、処理中なら装飾用のリングを重ねる。 */
function SwitcherVisuals({
  icon,
  isProcessing,
}: Pick<SessionSwitcherOption, "icon" | "isProcessing">) {
  if (!icon) return null;
  return (
    <span className="session-switcher-icon" aria-hidden="true">
      {icon}
      {isProcessing ? (
        <span className="session-switcher-processing-ring" />
      ) : null}
    </span>
  );
}

/** 処理中と未読の状態を読み上げ用にまとめ、どちらもなければ説明を省く。 */
function switcherStatus(
  option: SessionSwitcherOption | undefined,
): string | undefined {
  if (option?.isProcessing)
    return option.hasUnreadResult ? "Processing; Unread Result" : "Processing";
  return option?.hasUnreadResult ? "Unread Result" : undefined;
}

/** コンテキストペインと Auxiliary ペインが共有する、矢印と開閉ボタンを備えた小型の切り替え UI。 */
export function SessionSwitcher({
  ariaLabel,
  options,
  selectedId,
  onSelect,
  onMove,
  searchable = false,
  className = "",
  currentAction,
  emptyLabel,
}: SessionSwitcherProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const listId = useId();
  const selectedOption =
    options.find((option) => option.id === selectedId) ?? options[0];
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  const filteredOptions = normalizedQuery
    ? options.filter((option) =>
        (option.searchText ?? `${option.label}\n${option.preview ?? ""}`)
          .toLocaleLowerCase()
          .includes(normalizedQuery),
      )
    : options;
  const canMove = options.length > 1;
  const canOpen = options.length > 0;

  const close = useCallback((restoreFocus = true) => {
    setIsOpen(false);
    setSearchQuery("");
    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    if (!canOpen && isOpen) {
      setIsOpen(false);
      setSearchQuery("");
    }
  }, [canOpen, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    if (!searchable) {
      requestAnimationFrame(() => focusOption(listRef.current, 0));
    }
    /** 一覧とトリガーの外を操作したときは、移動先のフォーカスを奪わず閉じる。 */
    const handlePointerDown = (event: PointerEvent) => {
      if (
        !listRef.current?.contains(event.target as Node) &&
        !triggerRef.current?.contains(event.target as Node)
      ) {
        close(false);
      }
    };
    /** IME 変換中の Escape は奪わず、通常の Escape で一覧を閉じる。 */
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

  /** 表示中の候補間を上下に循環し、Enter でフォーカス中の候補を選ぶ。 */
  const handleListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    const optionElements = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="option"]',
      ) ?? []),
    ];
    const currentIndex = optionElements.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (optionElements.length === 0) return;
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      focusOption(
        listRef.current,
        (currentIndex + direction + optionElements.length) %
          optionElements.length,
      );
      return;
    }
    if (event.key === "Enter" && currentIndex >= 0) {
      event.preventDefault();
      optionElements[currentIndex]?.click();
    }
  };

  const currentLabel = selectedOption?.label ?? emptyLabel ?? "";
  const currentLabelText = currentLabel.trim();
  const currentPreviewText = selectedOption?.preview?.trim() ?? "";
  const currentAccessibleLabel =
    currentLabelText || currentPreviewText || ariaLabel;
  const currentButton = (
    <button
      ref={triggerRef}
      type="button"
      className="session-switcher-current"
      disabled={!canOpen}
      aria-haspopup="listbox"
      aria-expanded={canOpen && isOpen}
      aria-controls={canOpen ? listId : undefined}
      aria-label={
        currentLabelText || currentPreviewText
          ? undefined
          : currentAccessibleLabel
      }
      aria-description={switcherStatus(selectedOption)}
      onClick={() => {
        if (canOpen) {
          setIsOpen((current) => !current);
        }
      }}
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
      <SwitcherVisuals
        icon={selectedOption?.icon}
        isProcessing={selectedOption?.isProcessing}
      />
      <span
        className={`session-switcher-label${selectedOption?.hasUnreadResult && currentLabelText ? " has-unread-result" : ""}`}
      >
        {currentLabel}
      </span>
      {selectedOption?.preview ? (
        <span
          className={`session-switcher-preview${selectedOption.hasUnreadResult && !currentLabelText ? " has-unread-result" : ""}`}
        >
          {selectedOption.preview}
        </span>
      ) : null}
    </button>
  );
  return (
    <div
      className={`session-switcher${className ? ` ${className}` : ""}`}
      aria-label={ariaLabel}
    >
      <button
        type="button"
        className="session-switcher-button"
        onClick={() => onMove(-1)}
        disabled={!canMove}
        aria-label="Previous"
      >
        ‹
      </button>
      {currentAction ? (
        <div className="session-switcher-current-group">
          {currentButton}
          <div className="session-switcher-current-action">{currentAction}</div>
        </div>
      ) : (
        currentButton
      )}
      <button
        type="button"
        className="session-switcher-button"
        onClick={() => onMove(1)}
        disabled={!canMove}
        aria-label="Next"
      >
        ›
      </button>
      {canOpen && isOpen ? (
        <div
          ref={listRef}
          id={listId}
          className="session-switcher-popover"
          role="listbox"
          aria-label={`${ariaLabel} list`}
          onKeyDown={handleListKeyDown}
        >
          {searchable ? (
            <input
              autoFocus
              type="search"
              className="session-switcher-search"
              value={searchQuery}
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
              aria-label="Search list"
            />
          ) : null}
          <div className="session-switcher-options">
            {filteredOptions.length > 0
              ? filteredOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="option"
                    aria-selected={option.id === selectedId}
                    className="session-switcher-option"
                    aria-label={
                      option.label.trim() || option.preview?.trim()
                        ? undefined
                        : ariaLabel
                    }
                    aria-description={switcherStatus(option)}
                    title={option.isProcessing ? "Processing" : undefined}
                    onClick={() => {
                      onSelect(option.id);
                      close();
                    }}
                  >
                    <SwitcherVisuals
                      icon={option.icon}
                      isProcessing={option.isProcessing}
                    />
                    <span className="session-switcher-option-copy">
                      <span
                        className={`session-switcher-option-label${option.hasUnreadResult && option.label.trim() ? " has-unread-result" : ""}`}
                      >
                        {option.label}
                      </span>
                      {option.preview ? (
                        <span
                          className={`session-switcher-option-preview${option.hasUnreadResult && !option.label.trim() ? " has-unread-result" : ""}`}
                        >
                          {option.preview}
                        </span>
                      ) : null}
                    </span>
                  </button>
                ))
              : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

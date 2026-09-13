import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type PointerEventHandler,
  type ReactNode,
  type SetStateAction,
} from "react";

import { clampAuxiliaryWidthRatio } from "./use-auxiliary-workspace.js";

import type { MessageViewMode } from "../MessageRichText.js";
import type { AdditionalDirectoryItem } from "../session-composer-paths.js";
import { CloseButton } from "../close-button.js";

import {
  SESSION_ACTION_DOCK_ID,
  SESSION_HEADER_DOCK_ID,
  SESSION_RIGHT_PANE_ID,
  SESSION_LEFT_PANE_ID,
  SessionActionDockCompactRow,
  SessionChatScreen,
  SessionContextPane,
  SessionPaneErrorBoundary,
  SessionComposerExpanded,
  SessionHeader,
  SessionHeaderHandle,
  SessionMessageColumn,
  type SessionActionDockCompactRowProps,
  type SessionComposerExpandedProps,
  type SessionHeaderProps,
  type SessionMessageColumnProps,
  type SessionContextPaneProps,
  type SessionSelectOption,
  type SessionSkillItem,
} from "../session-components.js";
import { SessionSwitcher, type SessionSwitcherOption } from "./session-switcher.js";
import {
  ConversationMessageColumn,
  type ConversationColumnSession,
  type ConversationMessageColumnApi,
  type ConversationColumnCache,
  type ConversationColumnControls,
} from "./conversation-message-column.js";
import { createMessageCollapseHeaderAction } from "./chat-header-actions.js";
import { focusRovingItemByKey } from "../a11y.js";
import {
  SHORTCUT_COMMAND_IDS,
  useShortcutCommandHandler,
  useShortcutScope,
} from "../shortcut-registry.js";

type ChatScreenProps = ComponentProps<typeof SessionChatScreen>;

export type ChatAdditionalDirectoryListProps = {
  isOpen: boolean;
  items: AdditionalDirectoryItem[];
  isInteractionDisabled: boolean;
  onRemove: (path: string) => void;
};

export type ChatErrorNotice = {
  id: string;
  message: string;
  details?: readonly string[];
  relatedControl?: "composer";
  dismissLabel?: string;
  onDismiss?: () => void;
  actionLabel?: string;
  onAction?: () => void;
  isActionDisabled?: boolean;
};

export type ChatWindowProps = Omit<
  ChatScreenProps,
  "header" | "messageColumn" | "actionDock" | "isHeaderVisible" | "supportingSurface" | "errorSurface"
  | "auxiliaryMessageColumn" | "auxiliarySplitter" | "isAuxiliaryVisible" | "auxiliaryWidthRatio" | "concurrentTarget"
> & {
  isHeaderExpanded: boolean;
  headerProps: SessionHeaderProps;
  messageColumnProps: SessionMessageColumnProps;
  errorNotices?: readonly ChatErrorNotice[];
  recoveryActions?: ChatScreenProps["recoveryActions"];
  isActionDockExpanded: boolean;
  composerProps: SessionComposerExpandedProps;
  additionalDirectoryListProps?: ChatAdditionalDirectoryListProps;
  skillPickerProps?: ChatSkillPickerPanelProps;
  compactActionDockProps: SessionActionDockCompactRowProps;
  rightPaneProps?: SessionContextPaneProps;
  mainContent?: ChatScreenProps["mainContent"];
  concurrentChats?: ConcurrentChatWindowProps;
};

export type ConcurrentChatWindowProps = {
  main: SessionMessageColumnProps;
  auxiliary: SessionMessageColumnProps | null;
  mainSession?: ConversationColumnSession | null;
  auxiliarySession?: ConversationColumnSession | null;
  api?: ConversationMessageColumnApi;
  mainLiveRun?: import("../runtime-state.js").LiveSessionRunState | null;
  auxiliaryLiveRun?: import("../runtime-state.js").LiveSessionRunState | null;
  selectedAuxiliaryId: string | null;
  auxiliaryItems: readonly SessionSwitcherOption[];
  target: "main" | "auxiliary";
  widthRatio: number;
  scrollToLatestOnSend?: boolean;
  onSelectAuxiliary: (id: string) => void;
  onTargetChange: (target: "main" | "auxiliary") => void;
  onWidthRatioChange: (ratio: number) => void;
  loading?: boolean;
  error?: string | null;
};

export function ConcurrentChatSplitter({
  widthRatio,
  onWidthRatioChange,
}: Pick<ConcurrentChatWindowProps, "widthRatio" | "onWidthRatioChange">) {
  const dragRef = useRef<{ width: number; minRatio: number; maxRatio: number; startingRatio: number } | null>(null);
  const getRatioBounds = (splitter: HTMLButtonElement) => {
    const parent = splitter.parentElement;
    if (!parent) return null;
    const width = parent.getBoundingClientRect().width - splitter.getBoundingClientRect().width;
    if (width <= 0) return null;
    const main = parent.querySelector<HTMLElement>(".session-concurrent-chat-main");
    const auxiliary = parent.querySelector<HTMLElement>(".session-concurrent-chat-auxiliary");
    const readMinimum = (element: HTMLElement | null) => {
      const value = element ? Number.parseFloat(window.getComputedStyle(element).getPropertyValue("--session-region-min-width")) : Number.NaN;
      return Number.isFinite(value) ? Math.max(0, value) : 0;
    };
    const minRatio = readMinimum(auxiliary) / width;
    const maxRatio = 1 - readMinimum(main) / width;
    if (minRatio > maxRatio) return null;
    return { width, minRatio, maxRatio };
  };
  const handlePointerDown: PointerEventHandler<HTMLButtonElement> = (event) => {
    dragRef.current = null;
    if (widthRatio <= 0 || widthRatio >= 1) return;
    const bounds = getRatioBounds(event.currentTarget);
    if (!bounds) return;
    dragRef.current = { ...bounds, startingRatio: Math.min(bounds.maxRatio, Math.max(bounds.minRatio, widthRatio)) };
  };

  return (
    <ChatDockSplitter
      edge={widthRatio >= 1 ? "left" : "right"}
      className="concurrent-chat-splitter"
      isPanelExpanded={widthRatio > 0 && widthRatio < 1}
      onPointerDown={handlePointerDown}
      onDrag={(_event, delta) => {
        const bounds = dragRef.current;
        if (!bounds) return;
        const next = bounds.startingRatio - delta.x / bounds.width;
        onWidthRatioChange(next < bounds.minRatio / 2 ? 0
          : next > (1 + bounds.maxRatio) / 2 ? 1
            : Math.min(bounds.maxRatio, Math.max(bounds.minRatio, next)));
      }}
      onTogglePanel={() => onWidthRatioChange(widthRatio > 0 && widthRatio < 1 ? 0 : 0.5)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        if (widthRatio <= 0 || widthRatio >= 1) return;
        event.preventDefault();
        const bounds = getRatioBounds(event.currentTarget);
        if (!bounds) return;
        const current = Math.min(bounds.maxRatio, Math.max(bounds.minRatio, widthRatio));
        const next = current + (event.key === "ArrowLeft" ? 0.02 : -0.02);
        onWidthRatioChange(next < bounds.minRatio ? 0 : next > bounds.maxRatio ? 1 : next);
      }}
      ariaLabel={widthRatio >= 1 ? "Mainを開く" : widthRatio > 0 ? "Auxiliaryを折りたたむ" : "Auxiliaryを開く"}
      ariaControls={widthRatio >= 1 ? "session-main-chat-pane" : "session-auxiliary-chat-pane"}
      title="クリックで開閉、ドラッグまたは矢印キーでサイズ調整。端まで寄せると片側を全幅表示"
    />
  );
}

function ConcurrentChatTargetDock({ chats }: { chats: ConcurrentChatWindowProps }) {
  return (
    <div className="concurrent-chat-target-dock" role="group" aria-label="操作対象チャット">
      <button type="button" className={chats.target === "main" ? "is-active" : ""} onClick={() => chats.onTargetChange("main")}>Main</button>
      <button type="button" className={chats.target === "auxiliary" ? "is-active" : ""} onClick={() => chats.onTargetChange("auxiliary")}>Auxiliary</button>
    </div>
  );
}

export type ChatSkillPickerPanelProps = {
  isOpen: boolean;
  isLoading: boolean;
  errorMessage?: string | null;
  items: SessionSkillItem[];
  onSelectSkill: (skillId: string) => void;
  onDismiss: () => void;
};
export type ChatSelectOption = SessionSelectOption;
export type ChatHeaderHandleProps = ComponentProps<typeof SessionHeaderHandle>;

export type ChatWindowStatusScreenProps = {
  message: string;
  className?: string;
};

export type ChatRightPaneShellProps = {
  ariaLabel: string;
  className?: string;
};

export type ChatDockSplitterProps = {
  edge: "top" | "right" | "bottom" | "left";
  className?: string;
  isActive?: boolean;
  isPanelExpanded?: boolean;
  canCollapse?: boolean;
  onActivate?: () => void;
  onPointerDown?: PointerEventHandler<HTMLButtonElement>;
  onDrag?: (event: React.PointerEvent<HTMLButtonElement>, delta: { x: number; y: number }) => void;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  onTogglePanel?: MouseEventHandler<HTMLButtonElement>;
  ariaLabel?: string;
  ariaControls?: string;
  title?: string;
};

type Callback = (...args: any[]) => any;

function useStableOptionalCallback<T extends Callback>(callback: T | undefined): T | undefined {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const hasCallback = callback !== undefined;

  return useMemo(
    () => hasCallback
      ? ((...args: Parameters<T>) => callbackRef.current?.(...args)) as T
      : undefined,
    [hasCallback],
  );
}

const MemoizedSessionMessageColumn = memo(SessionMessageColumn);

export function filterChatSkillItems(items: SessionSkillItem[], searchQuery: string): SessionSkillItem[] {
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return items;
  }

  return items.filter((item) => (
    item.searchText ?? `${item.primaryLabel}\n${item.secondaryLabel}`
  ).toLocaleLowerCase().includes(normalizedQuery));
}

export function ChatSkillPickerPanel({
  isOpen,
  isLoading,
  errorMessage,
  items,
  onSelectSkill,
  onDismiss,
}: ChatSkillPickerPanelProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setSearchQuery("");
    searchInputRef.current?.focus();
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  const filteredItems = filterChatSkillItems(items, searchQuery);
  const hasItems = !isLoading && !errorMessage && filteredItems.length > 0;
  return (
    <div className="chat-skill-picker-layer">
      <div
        id="composer-skill-picker-list"
        ref={panelRef}
        className="chat-skill-picker-panel"
        role="dialog"
        aria-label="Skill 候補"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onDismiss();
            return;
          }
          if (event.key === "Enter" && document.activeElement?.getAttribute("role") === "option") {
            event.preventDefault();
            (document.activeElement as HTMLElement).click();
            return;
          }
          if (hasItems && document.activeElement?.getAttribute("role") === "option") {
            focusRovingItemByKey(event, { orientation: "vertical", selector: "[role=\"option\"]" });
          }
        }}
      >
        <div className="chat-skill-picker-header">
          <span>Skill</span>
          <input
            ref={searchInputRef}
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown" || !hasItems) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              panelRef.current?.querySelector<HTMLElement>("[role=\"option\"]")?.focus();
            }}
            className="chat-skill-picker-search"
            aria-label="Skillを検索"
            placeholder="Skillを検索"
            autoComplete="off"
          />
          <CloseButton ariaLabel="Close skill picker" onClose={onDismiss} />
        </div>
        <div
          className="chat-skill-picker-content"
          role={hasItems ? "listbox" : "status"}
          aria-label={hasItems ? "Skill 候補" : undefined}
          aria-orientation={hasItems ? "vertical" : undefined}
          aria-busy={isLoading || undefined}
        >
          {isLoading ? (
            <div className="chat-skill-picker-state">
              <span className="chat-skill-picker-spinner" aria-hidden="true" />
              <span className="visually-hidden">Skill候補を読み込んでいます。</span>
            </div>
          ) : errorMessage ? (
            <p className="chat-skill-picker-state error">{errorMessage}</p>
          ) : filteredItems.length > 0 ? (
            filteredItems.map((item, index) => (
              <button
                key={item.key}
                type="button"
                role="option"
                aria-selected="false"
                tabIndex={index === 0 ? 0 : -1}
                className="composer-path-match"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelectSkill(item.skillId)}
                title={item.title}
              >
                <span className="composer-path-match-primary">{item.primaryLabel}</span>
                <span className="composer-path-match-secondary">{item.secondaryLabel}</span>
              </button>
            ))
          ) : items.length > 0 ? (
            <p className="chat-skill-picker-state">検索条件に一致する Skill はありません。</p>
          ) : (
            <p className="chat-skill-picker-state">
              使える Skill がありません。SettingsのSkill RootまたはworkspaceのSKILL.mdを確認してください。
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function StableSessionMessageColumn(props: SessionMessageColumnProps) {
  const onMessageListScroll = useStableOptionalCallback(props.onMessageListScroll);
  const onToggleArtifact = useStableOptionalCallback(props.onToggleArtifact);
  const onLoadArtifactDetail = useStableOptionalCallback(props.onLoadArtifactDetail);
  const onOpenDiff = useStableOptionalCallback(props.onOpenDiff);
  const onResolveLiveApproval = useStableOptionalCallback(props.onResolveLiveApproval);
  const onResolveLiveElicitation = useStableOptionalCallback(props.onResolveLiveElicitation);
  const onOpenPath = useStableOptionalCallback(props.onOpenPath);
  const onCopyMessageText = useStableOptionalCallback(props.onCopyMessageText);
  const onQuoteMessageText = useStableOptionalCallback(props.onQuoteMessageText);
  const onActivateGlossaryEntry = useStableOptionalCallback(props.onActivateGlossaryEntry);

  return (
    <MemoizedSessionMessageColumn
      {...props}
      onMessageListScroll={onMessageListScroll!}
      onToggleArtifact={onToggleArtifact!}
      onLoadArtifactDetail={onLoadArtifactDetail}
      onOpenDiff={onOpenDiff!}
      onResolveLiveApproval={onResolveLiveApproval!}
      onResolveLiveElicitation={onResolveLiveElicitation!}
      onOpenPath={onOpenPath}
      getChangedFilesEmptyText={props.getChangedFilesEmptyText}
      onCopyMessageText={onCopyMessageText}
      onQuoteMessageText={onQuoteMessageText}
      onActivateGlossaryEntry={onActivateGlossaryEntry}
    />
  );
}

export function ChatAdditionalDirectoryList({
  isOpen,
  items,
  isInteractionDisabled,
  onRemove,
}: ChatAdditionalDirectoryListProps) {
  if (!isOpen || items.length === 0) {
    return null;
  }

  return (
    <section className="chat-additional-directory-surface" aria-label="許可中の追加Directory">
      <div className="chat-additional-directory-heading">
        <span>追加Directory</span>
        <span className="chat-additional-directory-count">{items.length}</span>
      </div>
      <div className="chat-additional-directory-list">
        {items.map((item) => (
          <div key={item.key} className="chat-additional-directory-row" title={item.title}>
            <span className="chat-additional-directory-copy">
              <span className="chat-additional-directory-primary">{item.primaryLabel}</span>
              <span className="chat-additional-directory-secondary">{item.secondaryLabel}</span>
            </span>
            {item.canRemove ? (
              <button
                type="button"
                className="chat-additional-directory-remove"
                onClick={() => onRemove(item.path)}
                disabled={isInteractionDisabled}
                aria-label={`${item.primaryLabel} を削除`}
              >
                ×
              </button>
            ) : (
              <span className="chat-additional-directory-readonly">許可中</span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// Keep every conversation surface on one chat layout. Projection builders own
// the feature-specific props and content.
export function ChatWindow({
  isHeaderExpanded,
  headerProps,
  messageColumnProps,
  errorNotices = [],
  recoveryActions,
  isActionDockExpanded,
  composerProps,
  additionalDirectoryListProps,
  skillPickerProps,
  compactActionDockProps,
  concurrentChats,
  ...screenProps
}: ChatWindowProps) {
  const [messageViewMode, setMessageViewMode] = useState<MessageViewMode>("preview");
  const conversationStateCacheRef = useRef(new Map<string, ConversationColumnCache>());
  const mainColumnControlsRef = useRef<ConversationColumnControls | null>(null);
  const auxiliaryColumnControlsRef = useRef<ConversationColumnControls | null>(null);
  const [, setColumnControlsRevision] = useState(0);
  const handleMainColumnControls = useCallback((controls: ConversationColumnControls) => {
    mainColumnControlsRef.current = controls;
    setColumnControlsRevision((revision) => revision + 1);
  }, []);
  const handleAuxiliaryColumnControls = useCallback((controls: ConversationColumnControls) => {
    auxiliaryColumnControlsRef.current = controls;
    setColumnControlsRevision((revision) => revision + 1);
  }, []);
  const errorSurfaceId = useId();
  const skillButtonRef = useRef<HTMLButtonElement | null>(null);
  const wasSkillPickerOpenRef = useRef(false);
  const showMessageViewModeControls = messageColumnProps.onQuoteMessageText !== undefined;
  const handleMessageViewModeChange = useCallback((mode: SetStateAction<MessageViewMode>) => {
    window.getSelection()?.removeAllRanges();
    setMessageViewMode(mode);
  }, []);
  useShortcutCommandHandler(
    SHORTCUT_COMMAND_IDS.messageToggleViewMode,
    () => {
      handleMessageViewModeChange((currentMode) => currentMode === "preview" ? "source" : "preview");
      return true;
    },
    showMessageViewModeControls,
  );
  useShortcutScope("session", Boolean(concurrentChats));
  useShortcutCommandHandler(
    SHORTCUT_COMMAND_IDS.conversationToggleTarget,
    () => {
      if (!concurrentChats || concurrentChats.auxiliaryItems.length === 0) {
        return false;
      }
      concurrentChats.onTargetChange(concurrentChats.target === "main" ? "auxiliary" : "main");
      return true;
    },
    Boolean(concurrentChats),
  );

  useEffect(() => {
    const isOpen = skillPickerProps?.isOpen ?? false;
    if (wasSkillPickerOpenRef.current && !isOpen) {
      skillButtonRef.current?.focus();
    }
    wasSkillPickerOpenRef.current = isOpen;
  }, [skillPickerProps?.isOpen]);

  const visibleErrorNotices = errorNotices.filter((notice) => notice.message.trim());
  const renderedErrorNotices = visibleErrorNotices.map((notice, index) => ({
    ...notice,
    domId: `${errorSurfaceId}-notice-${index}`,
  }));
  const composerErrorDescriptionIds = renderedErrorNotices
    .filter((notice) => notice.relatedControl === "composer")
    .map((notice) => notice.domId)
    .join(" ");
  const resolvedMessageColumnProps = concurrentChats?.main ?? messageColumnProps;
  const rawTargetColumnControls = concurrentChats?.target === "auxiliary"
    ? auxiliaryColumnControlsRef.current
    : mainColumnControlsRef.current;
  const targetSessionId = concurrentChats?.target === "auxiliary"
    ? concurrentChats.auxiliarySession?.id ?? concurrentChats.auxiliary?.sessionId
    : concurrentChats?.mainSession?.id ?? concurrentChats?.main?.sessionId;
  const targetColumnControls = rawTargetColumnControls?.sessionId === targetSessionId
    ? rawTargetColumnControls
    : null;
  const targetComposerSend = concurrentChats && targetColumnControls
    ? () => {
      if (!composerProps.isRunning && !composerProps.isSendDisabled) {
        targetColumnControls.handleMessageListSend(concurrentChats.scrollToLatestOnSend ?? true);
      }
      composerProps.onSendOrCancel();
    }
    : composerProps.onSendOrCancel;
  const resolvedHeaderProps = concurrentChats
    ? {
      ...headerProps,
      actions: (
        <>
          {createMessageCollapseHeaderAction({
            allMessagesCollapsed: targetColumnControls?.allMessagesCollapsed ?? false,
            disabled: !targetColumnControls?.messageCollapseTargetKeys.length,
            onToggle: () => targetColumnControls?.onToggleAllMessageCollapse(),
          })}
          {headerProps.actions}
        </>
      ),
    }
    : headerProps;

  const resolvedRightPaneProps = concurrentChats && screenProps.rightPaneProps
    ? {
      ...screenProps.rightPaneProps,
      messageNavigatorEntries: targetColumnControls?.messageNavigatorEntries ?? screenProps.rightPaneProps.messageNavigatorEntries,
      onJumpToMessage: targetColumnControls?.onJumpToMessage ?? screenProps.rightPaneProps.onJumpToMessage,
    }
    : screenProps.rightPaneProps;

  return (
    <SessionChatScreen
      {...screenProps}
      rightPane={resolvedRightPaneProps ? (
        <SessionPaneErrorBoundary>
          <SessionContextPane {...resolvedRightPaneProps} />
        </SessionPaneErrorBoundary>
      ) : screenProps.rightPane}
      header={<SessionHeader {...resolvedHeaderProps} />}
      isHeaderVisible={isHeaderExpanded}
      isActionDockExpanded={isActionDockExpanded}
      errorSurface={renderedErrorNotices.length > 0 ? (
        <div className="chat-error-surface" role="region" aria-label="チャットエラー">
          {renderedErrorNotices.map((notice) => (
            <div key={notice.id} id={notice.domId} className="chat-error-notice" role="alert">
              <div className="chat-error-copy">
                <p>{notice.message}</p>
                {notice.details && notice.details.length > 0 ? (
                  <ul>
                    {notice.details.map((detail, index) => <li key={`${notice.id}-detail-${index}`}>{detail}</li>)}
                  </ul>
                ) : null}
              </div>
              {notice.actionLabel && notice.onAction ? (
                <button
                  className="drawer-toggle compact secondary"
                  type="button"
                  onClick={notice.onAction}
                  disabled={notice.isActionDisabled}
                >
                  {notice.actionLabel}
                </button>
              ) : null}
              {notice.onDismiss ? (
                <button
                  className="chat-error-dismiss"
                  type="button"
                  onClick={notice.onDismiss}
                  aria-label={notice.dismissLabel ?? "エラー表示を閉じる"}
                >
                  ×
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      recoveryActions={recoveryActions}
      supportingSurface={additionalDirectoryListProps ? (
        <ChatAdditionalDirectoryList {...additionalDirectoryListProps} />
      ) : null}
      workSurfaceOverlay={skillPickerProps ? <ChatSkillPickerPanel {...skillPickerProps} /> : null}
      messageColumn={(
        <div id="session-main-chat-pane" className="concurrent-chat-column-content">
          {concurrentChats ? (
            <ConversationMessageColumn
              session={concurrentChats.mainSession ?? { id: resolvedMessageColumnProps.sessionId }}
              baseProps={{
                ...resolvedMessageColumnProps,
                isContentActive: (resolvedMessageColumnProps.isContentActive ?? true)
                  && concurrentChats.target === "main",
                messageViewMode,
              }}
              enabled
              api={concurrentChats.api}
              liveRun={concurrentChats.mainLiveRun}
              stateCache={conversationStateCacheRef.current}
              onColumnControls={handleMainColumnControls}
            />
          ) : (
            <StableSessionMessageColumn
              {...resolvedMessageColumnProps}
              messageViewMode={messageViewMode}
            />
          )}
          {concurrentChats && concurrentChats.target !== "main" ? (
            <div className="concurrent-chat-target-overlay" aria-hidden="true" />
          ) : null}
        </div>
      )}
      auxiliaryMessageColumn={concurrentChats ? (
        <>
          {concurrentChats.auxiliaryItems.length > 0 ? (
            <SessionSwitcher
              ariaLabel="Auxiliary会話切り替え"
              className="concurrent-chat-session-switcher"
              options={concurrentChats.auxiliaryItems}
              selectedId={concurrentChats.selectedAuxiliaryId ?? ""}
              searchable
              onMove={(direction) => {
                const items = concurrentChats.auxiliaryItems;
                const current = items.findIndex((item) => item.id === concurrentChats.selectedAuxiliaryId);
                if (current < 0 || items.length < 2) return;
                concurrentChats.onSelectAuxiliary(items[(current + direction + items.length) % items.length].id);
              }}
              onSelect={concurrentChats.onSelectAuxiliary}
            />
          ) : null}
          <div id="session-auxiliary-chat-pane" className="concurrent-chat-column-content">
            {concurrentChats.auxiliaryItems.length === 0 ? null : concurrentChats.loading ? (
              <div className="concurrent-chat-state" role="status" aria-label="Auxiliaryを読み込み中">
                <span className="concurrent-chat-loading-spinner" aria-hidden="true" />
              </div>
            ) : concurrentChats.error ? (
              <div className="concurrent-chat-state" role="alert">{concurrentChats.error}</div>
            ) : concurrentChats.auxiliary ? (
              <>
                <ConversationMessageColumn
                  session={concurrentChats.auxiliarySession ?? { id: concurrentChats.auxiliary.sessionId }}
                  baseProps={{
                    ...concurrentChats.auxiliary,
                    isContentActive: (concurrentChats.auxiliary.isContentActive ?? true)
                      && concurrentChats.target === "auxiliary",
                    messageViewMode,
                  }}
                  enabled={concurrentChats.widthRatio > 0 || concurrentChats.target === "auxiliary"}
                  api={concurrentChats.api}
                  liveRun={concurrentChats.auxiliaryLiveRun}
                  stateCache={conversationStateCacheRef.current}
                  onColumnControls={handleAuxiliaryColumnControls}
                />
              </>
            ) : (
              <div className="concurrent-chat-state" role="status">Auxiliaryを選択してください。</div>
            )}
          </div>
          {concurrentChats.target !== "auxiliary" ? (
            <div className="concurrent-chat-target-overlay" aria-hidden="true" />
          ) : null}
        </>
      ) : null}
      auxiliarySplitter={concurrentChats ? (
        <ConcurrentChatSplitter
          widthRatio={concurrentChats.widthRatio}
          onWidthRatioChange={concurrentChats.onWidthRatioChange}
        />
      ) : null}
      isAuxiliaryVisible={Boolean(concurrentChats)}
      auxiliaryWidthRatio={concurrentChats
        ? concurrentChats.widthRatio
        : undefined}
      concurrentTarget={concurrentChats?.target}
      actionDock={(
          <div className={`session-action-dock${isActionDockExpanded ? "" : " compact"}`}>
          <div
            className={`session-action-dock-content session-action-dock-expanded-content${
              isActionDockExpanded ? " is-active" : ""
            }`}
            aria-hidden={!isActionDockExpanded}
            inert={!isActionDockExpanded}
          >
            <SessionComposerExpanded
              {...composerProps}
              externalErrorDescriptionIds={composerErrorDescriptionIds || undefined}
              showJumpToBottom={concurrentChats ? false : targetColumnControls ? !targetColumnControls.isMessageListFollowing : composerProps.showJumpToBottom}
              onJumpToBottom={targetColumnControls?.followLatest ?? composerProps.onJumpToBottom}
              onSendOrCancel={targetComposerSend}
              skillButtonRef={skillButtonRef}
              showMessageViewModeControls={showMessageViewModeControls}
              messageViewMode={messageViewMode}
              onMessageViewModeChange={handleMessageViewModeChange}
              targetDock={concurrentChats ? <ConcurrentChatTargetDock chats={concurrentChats} /> : null}
            />
          </div>
          <div
            className={`session-action-dock-content session-action-dock-compact-content${
              isActionDockExpanded ? "" : " is-active"
            }`}
            aria-hidden={isActionDockExpanded}
            inert={isActionDockExpanded}
          >
            <SessionActionDockCompactRow
              {...compactActionDockProps}
              onJumpToBottom={targetColumnControls?.followLatest ?? compactActionDockProps.onJumpToBottom}
              showJumpToBottom={concurrentChats ? false : targetColumnControls ? !targetColumnControls.isMessageListFollowing : compactActionDockProps.showJumpToBottom}
              showMessageViewModeControls={showMessageViewModeControls}
              messageViewMode={messageViewMode}
              onMessageViewModeChange={handleMessageViewModeChange}
              targetDock={concurrentChats ? <ConcurrentChatTargetDock chats={concurrentChats} /> : null}
            />
          </div>
        </div>
      )}
    />
  );
}

export function ChatHeaderHandle(props: ChatHeaderHandleProps) {
  return <SessionHeaderHandle {...props} />;
}

export function ChatWindowStatusScreen({ message, className = "" }: ChatWindowStatusScreenProps) {
  return (
    <main className={`page-shell session-page${className ? ` ${className}` : ""}`}>
      <section className="session-work-surface chat-panel" aria-live="polite">
        <p className="session-message-empty">{message}</p>
      </section>
    </main>
  );
}

export function ChatDockSplitter({
  edge,
  className = "",
  isActive = false,
  isPanelExpanded = true,
  canCollapse = true,
  onActivate,
  onPointerDown,
  onDrag,
  onKeyDown,
  onTogglePanel,
  ariaLabel,
  ariaControls,
  title,
}: ChatDockSplitterProps) {
  const pointerStartRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const draggedRef = useRef(false);
  const effectiveTogglePanel = isPanelExpanded && !canCollapse ? undefined : onTogglePanel;
  if (!onPointerDown && !onDrag && !onTogglePanel && !onActivate) {
    return (
      <div
        className={`session-dock-splitter edge-${edge} is-static${className ? ` ${className}` : ""}`}
        aria-hidden="true"
      />
    );
  }

  const panelLabel = edge === "top"
    ? "ヘッダー"
    : edge === "bottom"
      ? "ActionDock"
      : edge === "left"
        ? "左ペイン"
        : "右ペイン";
  const resolvedAriaLabel = ariaLabel
    ?? (
      effectiveTogglePanel
        ? (isPanelExpanded ? `${panelLabel}を折りたたむ` : `${panelLabel}を展開`)
        : `${panelLabel}のサイズを調整`
    );
  const resolvedTitle = title
    ?? (
      effectiveTogglePanel
        ? (
          isPanelExpanded
            ? (
              onPointerDown
                ? `クリックで${panelLabel}を折りたたみ、ドラッグでサイズを調整`
                : `クリックで${panelLabel}を折りたたみ`
            )
            : `クリックで${panelLabel}を展開`
        )
        : `${panelLabel}のサイズをドラッグで調整`
    );
  const controlledId = edge === "top"
    ? SESSION_HEADER_DOCK_ID
    : edge === "bottom"
      ? SESSION_ACTION_DOCK_ID
      : edge === "left"
        ? SESSION_LEFT_PANE_ID
        : SESSION_RIGHT_PANE_ID;
  const chevronDirection = edge === "top"
    ? (isPanelExpanded ? "up" : "down")
    : edge === "bottom"
      ? (isPanelExpanded ? "down" : "up")
      : edge === "left"
        ? (isPanelExpanded ? "left" : "right")
        : (isPanelExpanded ? "right" : "left");
  const handlePointerDown: PointerEventHandler<HTMLButtonElement> = (event) => {
    if (event.button !== 0) {
      return;
    }
    pointerStartRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    draggedRef.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    onActivate?.();
    onPointerDown?.(event);
  };
  const handlePointerMove: PointerEventHandler<HTMLButtonElement> = (event) => {
    const start = pointerStartRef.current;
    if (!start || start.pointerId !== event.pointerId) {
      return;
    }
    const distance = Math.max(Math.abs(event.clientX - start.x), Math.abs(event.clientY - start.y));
    if (distance > 4) {
      draggedRef.current = true;
    }
    if (draggedRef.current) onDrag?.(event, { x: event.clientX - start.x, y: event.clientY - start.y });
  };
  const handlePointerEnd = () => {
    pointerStartRef.current = null;
  };
  const handlePointerCancel = () => {
    pointerStartRef.current = null;
    draggedRef.current = false;
  };
  const handleClick: MouseEventHandler<HTMLButtonElement> = (event) => {
    onActivate?.();
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    effectiveTogglePanel?.(event);
  };

  return (
    <button
      className={`session-dock-splitter edge-${edge}${className ? ` ${className}` : ""}${!onPointerDown ? " is-toggle-only" : ""}${isActive ? " is-active" : ""}${
        isPanelExpanded ? "" : " is-collapsed"
      }`}
      type="button"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerCancel}
      onClick={handleClick}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) onActivate?.();
      }}
      aria-label={resolvedAriaLabel}
      aria-controls={effectiveTogglePanel ? (ariaControls ?? controlledId) : undefined}
      aria-expanded={effectiveTogglePanel ? isPanelExpanded : undefined}
      title={resolvedTitle}
    >
      {effectiveTogglePanel ? (
        <span
          className={`session-dock-splitter-chevron direction-${chevronDirection}`}
          aria-hidden="true"
        >
          <svg viewBox="0 0 12 12" focusable="false">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
        </span>
      ) : null}
    </button>
  );
}

export function ChatRightPaneShell({
  ariaLabel,
  className = "",
}: ChatRightPaneShellProps) {
  return (
    <aside
      className={`session-context-pane session-context-pane-header-expanded${
        className ? ` ${className}` : ""
      }`}
      aria-label={ariaLabel}
    />
  );
}

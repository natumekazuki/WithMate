import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type MouseEventHandler,
  type PointerEventHandler,
  type ReactNode,
  type SetStateAction,
} from "react";

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
  SessionComposerExpanded,
  SessionHeader,
  SessionHeaderHandle,
  SessionMessageColumn,
  type SessionActionDockCompactRowProps,
  type SessionComposerExpandedProps,
  type SessionHeaderProps,
  type SessionMessageColumnProps,
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
  mainContent?: ChatScreenProps["mainContent"];
  concurrentChats?: ConcurrentChatWindowProps;
  auxiliaryMessageColumn?: ChatScreenProps["auxiliaryMessageColumn"];
  auxiliarySplitter?: ChatScreenProps["auxiliarySplitter"];
  isAuxiliaryVisible?: ChatScreenProps["isAuxiliaryVisible"];
  auxiliaryWidthRatio?: ChatScreenProps["auxiliaryWidthRatio"];
  concurrentTarget?: ChatScreenProps["concurrentTarget"];
};

export type ConcurrentChatWindowProps = {
  main: SessionMessageColumnProps;
  auxiliary: SessionMessageColumnProps | null;
  mainSession?: ConversationColumnSession | null;
  auxiliarySession?: ConversationColumnSession | null;
  api?: ConversationMessageColumnApi;
  selectedAuxiliaryId: string | null;
  auxiliaryItems: readonly SessionSwitcherOption[];
  target: "main" | "auxiliary";
  isExpanded: boolean;
  widthRatio: number;
  scrollToLatestOnSend?: boolean;
  onSelectAuxiliary: (id: string) => void;
  onTargetChange: (target: "main" | "auxiliary") => void;
  onCollapse: () => void;
  onExpand: () => void;
  onWidthRatioChange: (ratio: number) => void;
  auxiliarySplitter?: ReactNode;
  loading?: boolean;
  error?: string | null;
};

const COLLAPSED_AUXILIARY_WIDTH_RATIO = 0.05;

export function ConcurrentChatSplitter({
  isExpanded,
  widthRatio,
  onCollapse,
  onExpand,
  onWidthRatioChange,
}: Pick<ConcurrentChatWindowProps, "isExpanded" | "widthRatio" | "onCollapse" | "onExpand" | "onWidthRatioChange">) {
  const draggedRef = useRef(false);
  const startRef = useRef<{ x: number; width: number; widthRatio: number; isExpanded: boolean } | null>(null);
  const handlePointerDown: PointerEventHandler<HTMLButtonElement> = (event) => {
    if (event.button !== 0) return;
    const parent = event.currentTarget.parentElement;
    if (!parent) return;
    startRef.current = {
      x: event.clientX,
      width: parent.getBoundingClientRect().width,
      widthRatio: isExpanded ? widthRatio : COLLAPSED_AUXILIARY_WIDTH_RATIO,
      isExpanded,
    };
    draggedRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    const handleMove = (moveEvent: PointerEvent) => {
      const start = startRef.current;
      if (!start || start.width <= 0) return;
      const delta = moveEvent.clientX - start.x;
      if (Math.abs(delta) > 4) draggedRef.current = true;
      if (!start.isExpanded && draggedRef.current) {
        onExpand();
        start.isExpanded = true;
      }
      onWidthRatioChange(Math.min(0.8, Math.max(0.05, start.widthRatio - delta / start.width)));
    };
    const handleUp = () => {
      startRef.current = null;
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  };
  return (
    <button
      type="button"
      className={`session-dock-splitter edge-right concurrent-chat-splitter${isExpanded ? "" : " is-collapsed"}`}
      aria-label={isExpanded ? "Auxiliaryを折りたたむ" : "Auxiliaryの幅を調整"}
      aria-controls="session-auxiliary-chat-pane"
      aria-expanded={isExpanded}
      onPointerDown={handlePointerDown}
      onClick={() => {
        if (!draggedRef.current) onCollapse();
        draggedRef.current = false;
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onCollapse();
        }
      }}
    >
      <span
        className={`session-dock-splitter-chevron direction-${isExpanded ? "right" : "left"}`}
        aria-hidden="true"
      >
        <svg viewBox="0 0 12 12" focusable="false">
          <path d="M4 2.5 8 6 4 9.5" />
        </svg>
      </span>
    </button>
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
  isActive?: boolean;
  isPanelExpanded?: boolean;
  canCollapse?: boolean;
  onActivate?: () => void;
  onPointerDown?: PointerEventHandler<HTMLButtonElement>;
  onTogglePanel?: MouseEventHandler<HTMLButtonElement>;
  ariaLabel?: string;
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
  auxiliaryMessageColumn,
  auxiliarySplitter,
  isAuxiliaryVisible,
  auxiliaryWidthRatio,
  concurrentTarget,
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
  const resolvedHeaderProps = concurrentChats && targetColumnControls
    && targetColumnControls.messageCollapseTargetKeys.length > 0
    ? {
      ...headerProps,
      actions: (
        <>
          {headerProps.actions}
          {createMessageCollapseHeaderAction({
            allMessagesCollapsed: targetColumnControls.allMessagesCollapsed,
            onToggle: targetColumnControls.onToggleAllMessageCollapse,
          })}
        </>
      ),
    }
    : headerProps;

  return (
    <SessionChatScreen
      {...screenProps}
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
        <div className="concurrent-chat-column-content">
          {concurrentChats ? (
            <ConversationMessageColumn
              session={concurrentChats.mainSession ?? { id: resolvedMessageColumnProps.sessionId }}
              baseProps={{
                ...resolvedMessageColumnProps,
                isContentActive: (resolvedMessageColumnProps.isContentActive ?? true)
                  && concurrentChats.target === "main",
                messageViewMode,
              }}
              enabled={concurrentChats.isExpanded || concurrentChats.target === "main"}
              api={concurrentChats.api}
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
              className={`concurrent-chat-session-switcher${concurrentChats.isExpanded ? "" : " is-collapsed"}`}
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
                  enabled={concurrentChats.isExpanded || concurrentChats.target === "auxiliary"}
                  api={concurrentChats.api}
                  stateCache={conversationStateCacheRef.current}
                  onColumnControls={handleAuxiliaryColumnControls}
                />
                {concurrentChats.target !== "auxiliary" ? (
                  <div className="concurrent-chat-target-overlay" aria-hidden="true" />
                ) : null}
              </>
            ) : (
              <div className="concurrent-chat-state" role="status">Auxiliaryを選択してください。</div>
            )}
          </div>
        </>
      ) : auxiliaryMessageColumn}
      auxiliarySplitter={concurrentChats ? (
        <ConcurrentChatSplitter
          isExpanded={concurrentChats.isExpanded}
          widthRatio={concurrentChats.widthRatio}
          onCollapse={concurrentChats.onCollapse}
          onExpand={concurrentChats.onExpand}
          onWidthRatioChange={concurrentChats.onWidthRatioChange}
        />
      ) : auxiliarySplitter}
      isAuxiliaryVisible={concurrentChats ? true : isAuxiliaryVisible}
      auxiliaryWidthRatio={concurrentChats
        ? (concurrentChats.isExpanded ? concurrentChats.widthRatio : COLLAPSED_AUXILIARY_WIDTH_RATIO)
        : auxiliaryWidthRatio}
      concurrentTarget={concurrentChats?.target ?? concurrentTarget}
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
  isActive = false,
  isPanelExpanded = true,
  canCollapse = true,
  onActivate,
  onPointerDown,
  onTogglePanel,
  ariaLabel,
  title,
}: ChatDockSplitterProps) {
  const effectiveTogglePanel = isPanelExpanded && !canCollapse ? undefined : onTogglePanel;
  if (!onPointerDown && !onTogglePanel && !onActivate) {
    return <div className={`session-dock-splitter edge-${edge} is-static`} aria-hidden="true" />;
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
    onActivate?.();
    if (isPanelExpanded) {
      onPointerDown?.(event);
    }
  };
  const handleClick: MouseEventHandler<HTMLButtonElement> = (event) => {
    onActivate?.();
    effectiveTogglePanel?.(event);
  };

  return (
    <button
      className={`session-dock-splitter edge-${edge}${!onPointerDown ? " is-toggle-only" : ""}${isActive ? " is-active" : ""}${
        isPanelExpanded ? "" : " is-collapsed"
      }`}
      type="button"
      onPointerDown={handlePointerDown}
      onClick={handleClick}
      aria-label={resolvedAriaLabel}
      aria-controls={effectiveTogglePanel ? controlledId : undefined}
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

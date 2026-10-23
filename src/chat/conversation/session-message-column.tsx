import { SelectionActionOverlayContext } from "./selection-action-overlay-context.js";
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEventHandler, type CSSProperties, type ReactNode, type RefObject, type UIEventHandler } from "react";
import { createPortal } from "react-dom";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";

import type { ChangedFile, LiveApprovalRequest, LiveElicitationRequest, LiveElicitationResponse, ElicitationRecord } from "../../../src-shared/session/runtime-state.js";
import type { CharacterProfile } from "../../../src-shared/character/character-state.js";
import type { Message, MessageArtifact } from "../../../src-shared/session/session-state.js";
import { getMessageHistoryIndex, type ConversationSearchMatch, type ConversationSearchRequest, type ConversationQueryOutcome, type ConversationQueryCancelRequest } from "../../../src-shared/session/conversation-page.js";
import { useConversationQueryPages } from "./use-conversation-query-pages.js";
import { useStreamedResponseText } from "./use-streamed-response-text.js";

import { MessageRichText, type MessageViewMode } from "../../ui/markdown/MessageRichText.js";
import { useMarkdownImageResolver, type MarkdownImageContext, type MarkdownImageResolver } from "../../ui/markdown/image-resource-loader.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import { LoadingIndicator } from "../../ui/loading-indicator.js";
import type { GlossaryAnnotationMatcher } from "../../glossary/glossary-annotation-projection.js";
import { approvalModeLabel, CharacterAvatar, liveRunStepStatusLabel, operationTypeLabel } from "../../ui/ui-utils.js";

import { SessionContentFindBar } from "./session-content-find-bar.js";
import { InlineQuestionContent, LiveRequestSurface, type LiveElicitationDrafts } from "../runtime/live-request-surface.js";
import { SessionTurnQueueStatus } from "./session-turn-queue-row.js";
import { SessionRunFailure } from "./session-run-failure.js";
import type { SessionTurnQueueActionKind } from "./use-session-turn-queue.js";
import { PendingRunIndicator } from "../runtime/pending-run-indicator.js";
import { clampFindMatchIndex, findTextMatches, iterateTextMatches } from "../../../src-shared/text/find-text-matches.js";

import { resolveSelectionActionOverlayPosition } from "../../chat/selection-action-overlay.js";

import {
  createMessageRenderedSearchTextProjection,
  isMessageRenderedSearchTextNode,
} from "./message-rendered-search-text.js";
import { projectMessageRenderedSearchText } from "../../../src-shared/session/message-search.js";
import {
  appendRenderedTextMatches,
  applyRenderedTextHighlights,
  clearRenderedTextHighlights,
  createRenderedTextSearchIndex,
  findRenderedTextMatchOffsets,
  resolveRenderedTextMatch,
  scrollRenderedTextMatchIntoView,
  type RenderedTextMatch,
} from "../../file-explorer/rendered-text-search.js";
import { SHORTCUT_COMMAND_IDS, useShortcutCommandHandler, useShortcutScope } from "../../settings/shortcut-registry.js";
import type { MessageCollapseTarget, MessageJumpRequest } from "./session-message-collapse.js";

function displayApprovalValue(value: string): string {
  return approvalModeLabel(value);
}

function displayRunCheckValue(check: { label: string; value: string }): string {
  return check.label.trim().toLowerCase() === "approval" ? displayApprovalValue(check.value) : check.value;
}

function collapseSummaryText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const SESSION_MESSAGE_ESTIMATED_ROW_HEIGHT = 168;
const SESSION_MESSAGE_FALLBACK_VIEWPORT_HEIGHT = 720;
const SESSION_MESSAGE_OVERSCAN = 6;
const SESSION_MESSAGE_SCROLL_END_THRESHOLD = 80;
const SESSION_ACTION_DOCK_ID = "session-action-dock";

export function shouldAdjustSessionMessageScrollPosition(input: { itemEnd: number; scrollOffset: number }): boolean {
  return input.itemEnd <= input.scrollOffset;
}

type MessageArtifactFoldSection = "operation" | "operations";
function messageArtifactFoldKey(artifactKey: string, section: MessageArtifactFoldSection, index?: number): string {
  return `${artifactKey}:${section}${index === undefined ? "" : `:${index}`}`;
}
export type SessionMessageColumnProps = {
  turnSubmissions?: import("../runtime/session-turn-submissions.js").SessionTurnSubmissions;
  responsePending?: boolean;
  submissionError?: string;
  submissionUncertain?: boolean;
  turnQueueMetadata?: ReadonlyMap<string, import("../../../src-shared/session/session-turn-queue.js").SessionTurnQueueReceipt>;
  onCancelQueuedTurn?: (receipt: import("../../../src-shared/session/session-turn-queue.js").SessionTurnQueueReceipt) => void;
  onReleaseInterruptedTurn?: (receipt: import("../../../src-shared/session/session-turn-queue.js").SessionTurnQueueReceipt) => void;
  queueBusyId?: string | null;
  queueBusyKind?: SessionTurnQueueActionKind | null;
  renderQueueTail?: (resolveImageSource: MarkdownImageResolver, markdownImageContext: MarkdownImageContext) => ReactNode;
  sessionId: string;
  workspacePath?: string | null;
  elicitationDisabled?: boolean;
  provider?: string;
  character: CharacterProfile;
  messages: Message[];
  messageKeys?: string[];
  pendingResponseMessageKey?: string | null;
  responsePresentationKey?: string;
  streamingResponseMessageKey?: string | null;
  messageCollapseTargets?: readonly MessageCollapseTarget[];
  collapsedMessageKeys?: ReadonlySet<string>;
  messageJumpRequest?: MessageJumpRequest | null;
  conversationPaging?: {
    loading: boolean; error: string;
    onRetry: () => void;
  };
  searchConversation?: (request: ConversationSearchRequest) => Promise<ConversationQueryOutcome<ConversationSearchMatch>>;
  cancelConversationQuery?: (request: ConversationQueryCancelRequest) => Promise<void>;
  conversationQueryOwner?: string;
  conversationQueryRevision?: string | number;
  searchTailMessages?: readonly Message[];
  searchMessageIndexes?: readonly number[];
  onLoadMessagePage?: (messageIndex: number) => Promise<void>;
  messageGroups?: Array<{
    id: string;
    label: string;
  } | null>;
  expandedArtifacts: Record<string, boolean>;
  messageListRef: RefObject<HTMLDivElement | null>;
  isRunning: boolean;
  pendingCancelSessionIds?: ReadonlySet<string>;
  pendingRunIndicatorAnnouncement?: string;
  liveApprovalRequest: LiveApprovalRequest | null;
  approvalActionRequestId: string | null;
  approvalActionDecision?: "approve" | "deny" | null;
  liveElicitationRequest: LiveElicitationRequest | null;
  liveElicitationRequests?: readonly LiveElicitationRequest[];
  liveElicitationRecords?: readonly ElicitationRecord[];
  elicitationInputAvailable?: boolean;
  elicitationActionRequestId: string | null;
  elicitationAction?: LiveElicitationResponse["action"] | null;
  liveRunAssistantText: string;
  hasLiveRunAssistantText: boolean;
  liveRunErrorMessage: string;
  pendingMessageText?: string;
  pendingMessageTextVisible?: boolean;
  pendingMessageGroupId?: string | null;
  isMessageListFollowing: boolean;
  onBrowseMessages?: () => void;
  onMessageListScroll: UIEventHandler<HTMLDivElement>;
  onMessageListLayout?: () => void;
  onJumpToBottom?: () => void;
  onToggleMessageCollapse?: (key: string) => void;
  onToggleAllMessageCollapse?: () => void;
  onToggleMessageBookmark?: (target: MessageCollapseTarget) => void;
  onToggleArtifact: (artifactKey: string) => void;
  onLoadArtifactDetail?: (messageIndex: number) => Promise<MessageArtifact | null>;
  artifactDetailsEnabled?: boolean;
  onOpenDiff: (title: string, file: ChangedFile) => void;
  onResolveLiveApproval: (request: LiveApprovalRequest, decision: "approve" | "deny") => void;
  onResolveLiveElicitation: (request: LiveElicitationRequest, response: LiveElicitationResponse) => void;
  onOpenPath?: (target: string) => void;
  onCopyMessageText?: (text: string) => void;
  onQuoteMessageText?: (text: string) => void;
  isContentActive?: boolean;
  messageViewMode?: MessageViewMode;
  glossaryAnnotationMatcher?: GlossaryAnnotationMatcher;
  onActivateGlossaryEntry?: (canonicalTerm: string) => void;
};

function getNonBlankSelectionText(selection: Selection): string | null {
  const text = selection.toString();
  return text.trim() ? text : null;
}

function getSelectionDetailsWithinMessageList(element: Element | null): { anchorRect: DOMRect; text: string } | null {
  if (!element || typeof window === "undefined") {
    return null;
  }

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const commonAncestor = range.commonAncestorContainer;
  const commonElement =
    commonAncestor.nodeType === Node.ELEMENT_NODE
      ? commonAncestor as Element
      : commonAncestor.parentElement;
  const messageBody = commonElement?.closest("[data-message-body='true']") ?? null;
  if (
    !messageBody ||
    !element.contains(messageBody) ||
    messageBody.getAttribute("data-message-text-actions") !== "true"
  ) {
    return null;
  }

  const text = getNonBlankSelectionText(selection);
  if (text === null) {
    return null;
  }

  const rangeRect = range.getBoundingClientRect();
  if (rangeRect.width > 0 || rangeRect.height > 0) {
    return { anchorRect: rangeRect, text };
  }

  const fallbackRect = range.getClientRects()[0] ?? null;
  return fallbackRect ? { anchorRect: fallbackRect, text } : null;
}

function clampToolbarPosition(input: {
  anchorRect: DOMRect;
  boundaryRect: DOMRect;
  toolbarRect: Pick<DOMRect, "width" | "height">;
  padding?: number;
}): CSSProperties {
  const padding = input.padding ?? 8;
  const toolbarWidth = input.toolbarRect.width || 112;
  const toolbarHeight = input.toolbarRect.height || 32;
  const preferredLeft = input.anchorRect.left + (input.anchorRect.width - toolbarWidth) / 2;
  const preferredTop =
    input.anchorRect.top - toolbarHeight - padding >= input.boundaryRect.top + padding
      ? input.anchorRect.top - toolbarHeight - padding
      : input.anchorRect.bottom + padding;
  const left = Math.min(
    input.boundaryRect.right - toolbarWidth - padding,
    Math.max(input.boundaryRect.left + padding, preferredLeft),
  );
  const top = Math.min(
    input.boundaryRect.bottom - toolbarHeight - padding,
    Math.max(input.boundaryRect.top + padding, preferredTop),
  );

  return { left, top };
}

function rectsIntersect(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

type MessageResponseActionsProps = {
  actionText: string;
  onCopyMessageText?: (text: string) => void;
  onQuoteMessageText?: (text: string) => void;
  style?: CSSProperties;
  toolbarRef?: RefObject<HTMLDivElement | null>;
};

function MessageResponseActions({
  actionText,
  onCopyMessageText,
  onQuoteMessageText,
  style,
  toolbarRef,
}: MessageResponseActionsProps) {
  return (
    <div
      ref={toolbarRef}
      className="message-response-actions"
      aria-label="Response actions"
      style={style}
    >
      {onCopyMessageText ? (
        <button
          className="message-response-action"
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onCopyMessageText(actionText)}
        >
          Copy
        </button>
      ) : null}
      {onQuoteMessageText ? (
        <button
          className="message-response-action"
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onQuoteMessageText(actionText)}
        >
          Quote
        </button>
      ) : null}
    </div>
  );
}

export type SelectionTextActionSurfaceProps = {
  children: ReactNode;
  className?: string;
  onCopyText: (text: string) => void;
  onQuoteText?: (text: string) => void;
  selectAllText?: string;
  surfaceRef?: RefObject<HTMLDivElement | null>;
};

export function SelectionTextActionSurface({
  children,
  className = "",
  onCopyText,
  onQuoteText,
  selectAllText,
  surfaceRef: externalSurfaceRef,
}: SelectionTextActionSurfaceProps) {
  const internalSurfaceRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = externalSurfaceRef ?? internalSurfaceRef;
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const logicalSelectAllTextRef = useRef<string | null>(null);
  const [selectionToolbar, setSelectionToolbar] = useState<{ style: CSSProperties; text: string } | null>(null);

  const updateSelectionToolbar = useCallback(() => {
    const surface = surfaceRef.current;
    const selection = typeof window === "undefined" ? null : window.getSelection();
    if (!surface || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      setSelectionToolbar(null);
      return;
    }

    const range = selection.getRangeAt(0);
    const commonAncestor = range.commonAncestorContainer;
    const commonElement = commonAncestor.nodeType === Node.ELEMENT_NODE
      ? commonAncestor as Element
      : commonAncestor.parentElement;
    const selectableBody = commonElement?.closest("[data-selection-copy-body='true']") ?? null;
    const selectedText = logicalSelectAllTextRef.current ?? getNonBlankSelectionText(selection);
    if (!selectableBody || !surface.contains(selectableBody) || selectedText === null) {
      setSelectionToolbar(null);
      return;
    }

    const anchorRect = range.getBoundingClientRect();
    const fallbackRect = range.getClientRects()[0] ?? null;
    const resolvedAnchorRect = anchorRect.width > 0 || anchorRect.height > 0 ? anchorRect : fallbackRect;
    const boundaryRect = surface.getBoundingClientRect();
    if (!resolvedAnchorRect || !rectsIntersect(resolvedAnchorRect, boundaryRect)) {
      setSelectionToolbar(null);
      return;
    }

    setSelectionToolbar({
      text: selectedText,
      style: clampToolbarPosition({
        anchorRect: resolvedAnchorRect,
        boundaryRect,
        toolbarRect: toolbarRef.current?.getBoundingClientRect() ?? {
          width: onQuoteText ? 112 : 72,
          height: 32,
        },
      }),
    });
  }, [onQuoteText, surfaceRef]);

  const clearLogicalSelectAll = useCallback((clearBrowserSelection = false) => {
    const wasLogicalSelectAll = logicalSelectAllTextRef.current !== null;
    logicalSelectAllTextRef.current = null;
    if (wasLogicalSelectAll && clearBrowserSelection && typeof window !== "undefined") {
      window.getSelection()?.removeAllRanges();
    }
  }, []);

  const handleSelectAllShortcut = useCallback((): boolean => {
    const surface = surfaceRef.current;
    const selectableBody = surface?.querySelector<HTMLElement>("[data-selection-copy-body='true']") ?? null;
    const selection = typeof window === "undefined" ? null : window.getSelection();
    if (!surface || !selectableBody || !selection) {
      return false;
    }

    surface.focus({ preventScroll: true });
    clearLogicalSelectAll();
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(selectableBody);
    selection.addRange(range);
    const resolvedText = selectAllText ?? selection.toString();
    if (!resolvedText.trim()) {
      selection.removeAllRanges();
      setSelectionToolbar(null);
      return true;
    }

    logicalSelectAllTextRef.current = resolvedText;
    updateSelectionToolbar();
    return true;
  }, [clearLogicalSelectAll, selectAllText, surfaceRef, updateSelectionToolbar]);

  useShortcutCommandHandler(SHORTCUT_COMMAND_IDS.filePreviewSelectAll, handleSelectAllShortcut);

  const handleCopy = useCallback<ClipboardEventHandler<HTMLDivElement>>((event) => {
    const logicalText = logicalSelectAllTextRef.current;
    if (logicalText === null) {
      return;
    }
    event.preventDefault();
    event.clipboardData.setData("text/plain", logicalText);
  }, []);

  useEffect(() => {
    clearLogicalSelectAll();
    setSelectionToolbar(null);
  }, [clearLogicalSelectAll, selectAllText]);

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    document.addEventListener("selectionchange", updateSelectionToolbar);
    window.addEventListener("resize", updateSelectionToolbar);
    const surface = surfaceRef.current;
    surface?.addEventListener("scroll", updateSelectionToolbar, { passive: true });
    return () => {
      document.removeEventListener("selectionchange", updateSelectionToolbar);
      window.removeEventListener("resize", updateSelectionToolbar);
      surface?.removeEventListener("scroll", updateSelectionToolbar);
    };
  }, [updateSelectionToolbar]);

  return (
    <div
      ref={surfaceRef}
      className={className}
      tabIndex={0}
      onCopy={handleCopy}
      onPointerDownCapture={(event) => {
        if (!(event.target instanceof HTMLElement) || !event.target.closest(".message-response-actions")) {
          clearLogicalSelectAll();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          clearLogicalSelectAll(true);
          setSelectionToolbar(null);
        }
      }}
    >
      <div data-selection-copy-body="true">{children}</div>
      {selectionToolbar ? (
        <MessageResponseActions
          actionText={selectionToolbar.text}
          onCopyMessageText={onCopyText}
          onQuoteMessageText={onQuoteText}
          style={selectionToolbar.style}
          toolbarRef={toolbarRef}
        />
      ) : null}
    </div>
  );
}

export function SessionMessageColumn({
  turnQueueMetadata,
  onCancelQueuedTurn,
  onReleaseInterruptedTurn,
  queueBusyId,
  queueBusyKind,
  renderQueueTail,
  responsePending = false,
  submissionError = "",
  submissionUncertain = false,
  sessionId,
  workspacePath,
  elicitationDisabled,
  provider,
  character,
  messages: suppliedMessages,
  messageKeys: suppliedMessageKeys,
  pendingResponseMessageKey: suppliedPendingResponseKey = null,
  responsePresentationKey,
  streamingResponseMessageKey,
  messageCollapseTargets = [],
  collapsedMessageKeys = new Set(),
  messageJumpRequest = null,
  conversationPaging,
  searchConversation,
  cancelConversationQuery,
  conversationQueryOwner = sessionId,
  conversationQueryRevision = 0,
  searchTailMessages,
  searchMessageIndexes,
  onLoadMessagePage,
  messageGroups,
  expandedArtifacts,
  messageListRef,
  isRunning,
  pendingRunIndicatorAnnouncement,
  liveApprovalRequest,
  approvalActionRequestId,
  approvalActionDecision,
  liveElicitationRequest,
  liveElicitationRequests,
  liveElicitationRecords,
  elicitationInputAvailable,
  elicitationActionRequestId,
  elicitationAction,
  liveRunAssistantText,
  hasLiveRunAssistantText,
  liveRunErrorMessage,
  pendingMessageText = "",
  pendingMessageTextVisible = true,
  pendingMessageGroupId = null,
  isMessageListFollowing,
  onBrowseMessages,
  onMessageListScroll,
  onMessageListLayout,
  onJumpToBottom,
  onToggleMessageCollapse,
  onToggleAllMessageCollapse,
  onToggleMessageBookmark,
  onToggleArtifact,
  onLoadArtifactDetail,
  artifactDetailsEnabled = true,
  onResolveLiveApproval,
  onResolveLiveElicitation,
  onOpenPath,
  onCopyMessageText,
  onQuoteMessageText,
  isContentActive = true,
  messageViewMode = "preview",
  glossaryAnnotationMatcher,
  onActivateGlossaryEntry,
}: SessionMessageColumnProps) {
  const hasResponseStatus = isRunning || responsePending || !!submissionError;
  const sharedPending = !!responsePresentationKey && hasResponseStatus && (suppliedPendingResponseKey === null || !suppliedMessageKeys?.includes(suppliedPendingResponseKey));
  const rawMessages = useMemo(() => sharedPending ? [...suppliedMessages, { role: "assistant" as const, text: "" }] : suppliedMessages, [suppliedMessages, sharedPending]);
  const messageKeys = useMemo(() => sharedPending ? [...suppliedMessages.map((_, index) => suppliedMessageKeys?.[index] ?? `${sessionId}-${index}`), responsePresentationKey!] : suppliedMessageKeys, [suppliedMessages, suppliedMessageKeys, sharedPending, responsePresentationKey, sessionId]);
  const pendingResponseMessageKey = sharedPending ? responsePresentationKey! : suppliedPendingResponseKey;
  const responseRowKeys = useRef({ owner: conversationQueryOwner, keys: new Map<string, string>() });
  if (responseRowKeys.current.owner !== conversationQueryOwner) responseRowKeys.current = { owner: conversationQueryOwner, keys: new Map() };
  const rowKeys = responseRowKeys.current.keys;
  for (const key of rowKeys.keys()) if (!messageKeys?.includes(key)) rowKeys.delete(key);
  if (responsePresentationKey && pendingResponseMessageKey && !rowKeys.has(pendingResponseMessageKey)) rowKeys.set(pendingResponseMessageKey, responsePresentationKey);
  const streamingIndex = streamingResponseMessageKey ? suppliedMessageKeys?.indexOf(streamingResponseMessageKey) ?? -1 : -1;
  const responseTextIndex = pendingResponseMessageKey ? messageKeys?.indexOf(pendingResponseMessageKey) ?? -1 : -1;
  const selectionActionOverlay = useContext(SelectionActionOverlayContext);
  const elicitationDrafts = useMemo<LiveElicitationDrafts>(() => new Map(), [sessionId]);
  useEffect(() => {
    const requests = liveElicitationRequests ?? (liveElicitationRequest ? [liveElicitationRequest] : []);
    for (const key of elicitationDrafts.keys()) {
      if (!requests.some((request) => request.requestId === key)) elicitationDrafts.delete(key);
    }
  }, [elicitationDrafts, liveElicitationRequests, liveElicitationRequest]);
  const [openArtifactFolds, setOpenArtifactFolds] = useState<Record<string, boolean>>({});
  const loadedArtifactDetails = useRef(new Map<string, MessageArtifact>());
  const [, refreshArtifactDetails] = useState(0);
  const [loadingArtifactDetails, setLoadingArtifactDetails] = useState<Record<string, boolean>>({});
  const [artifactDetailErrors, setArtifactDetailErrors] = useState<Record<string, string>>({});
  const artifactAttempts = useRef(new Map<string, object>());
  const activeArtifactKeys = useRef(new Set<string>());
  const [selectionToolbar, setSelectionToolbar] = useState<{ style: CSSProperties; text: string } | null>(null);
  const [selectionActive, setSelectionActive] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const presentedText = useStreamedResponseText(conversationQueryOwner, pendingResponseMessageKey,
    responseTextIndex >= 0 ? rawMessages[responseTextIndex].text : "", streamingIndex >= 0 && !(findOpen && findQuery.trim()), artifactDetailsEnabled);
  const messages = useMemo(() => streamingIndex < 0 || rawMessages[streamingIndex].text === presentedText ? rawMessages
    : rawMessages.map((message, index) => index === streamingIndex ? { ...message, text: presentedText } : message), [rawMessages, streamingIndex, presentedText]);
  const [currentFindMatch, setCurrentFindMatch] = useState(0);
  const [conversationFindError, setConversationFindError] = useState("");
  const [messageJumpHighlightKey, setMessageJumpHighlightKey] = useState<string | null>(null);
  const selectionToolbarRef = useRef<HTMLDivElement | null>(null);
  const previousMessageViewModeRef = useRef(messageViewMode);
  const handledMessageJumpRequestIdRef = useRef<number | null>(null);
  const requestedMessageJumpIdRef = useRef<number | null>(null);
  const markdownLinkFileContext = useMemo(() => ({ sessionId }), [sessionId]);
  const resolveImageSource = useMarkdownImageResolver(getWithMateApi(), markdownLinkFileContext, messageViewMode);
  const messageCollapseTargetByKey = useMemo(
    () => new Map(messageCollapseTargets.map((target) => [target.key, target])),
    [messageCollapseTargets],
  );

  useShortcutScope("message-list", isContentActive);
  useShortcutCommandHandler(
    SHORTCUT_COMMAND_IDS.messageFind,
    () => {
      setFindOpen(true);
      return true;
    },
    isContentActive,
  );
  useShortcutCommandHandler(
    SHORTCUT_COMMAND_IDS.messageCloseFind,
    () => {
      if (!findOpen) {
        return false;
      }
      setFindOpen(false);
      return true;
    },
    isContentActive,
  );
  useShortcutCommandHandler(
    SHORTCUT_COMMAND_IDS.messageToggleCollapse,
    () => {
      const targetCount = messageCollapseTargets.length;
      const callbackAvailable = Boolean(onToggleAllMessageCollapse);
      const accepted = targetCount > 0 && callbackAvailable;
      if (!accepted || !onToggleAllMessageCollapse) {
        return false;
      }
      onToggleAllMessageCollapse();
      return true;
    },
    isContentActive,
  );

  const getMessageKey = useCallback(
    (index: number) => messageKeys?.[index] ?? `${sessionId}-${index}`,
    [messageKeys, sessionId],
  );
  const getRowKey = useCallback((index: number) => rowKeys.get(getMessageKey(index)) ?? getMessageKey(index), [getMessageKey, rowKeys]);
  const artifactPageKeys = useRef<Set<string> | null>(null);
  artifactPageKeys.current = new Set(messages.map((_, index) => getMessageKey(index)));
  activeArtifactKeys.current = new Set(artifactDetailsEnabled
    ? Object.keys(expandedArtifacts).filter((key) => expandedArtifacts[key] && artifactPageKeys.current!.has(key)) : []);
  useEffect(() => {
    const keys = activeArtifactKeys.current;
    for (const key of artifactAttempts.current.keys()) {
      if (!keys.has(key)) artifactAttempts.current.delete(key);
    }
    let released = false;
    for (const key of loadedArtifactDetails.current.keys()) {
      if (!keys.has(key)) { loadedArtifactDetails.current.delete(key); released = true; }
    }
    if (released) refreshArtifactDetails((revision) => revision + 1);
    setLoadingArtifactDetails((current) => Object.keys(current).some((key) => !keys.has(key))
      ? Object.fromEntries(Object.entries(current).filter(([key]) => keys.has(key))) : current);
    setArtifactDetailErrors((current) => Object.keys(current).some((key) => !keys.has(key))
      ? Object.fromEntries(Object.entries(current).filter(([key]) => keys.has(key))) : current);
  }, [artifactDetailsEnabled, expandedArtifacts, messageKeys, messages]);
  useEffect(() => () => { artifactAttempts.current.clear(); loadedArtifactDetails.current.clear(); }, []);
  const pendingResponseMessageIndex = (isRunning || responsePending || !!submissionError) && pendingResponseMessageKey !== null
    ? messageKeys?.indexOf(pendingResponseMessageKey) ?? -1
    : -1;
  const hasElicitationRequests = liveElicitationRequests ? liveElicitationRequests.length > 0 : liveElicitationRequest !== null;
  const persistedQuestionIds = new Set(messages.flatMap((message) => message.elicitationRecords?.map((record) => record.requestId) ?? []));
  const visibleLiveElicitationRecords = liveElicitationRecords?.filter((record) => !persistedQuestionIds.has(record.requestId));
  const activeQuestions = liveElicitationRequests ?? (liveElicitationRequest ? [liveElicitationRequest] : []);
  const elicitationMessageIndex = hasElicitationRequests ? pendingResponseMessageIndex : -1;
  const extractMessageRange = useCallback((range: Range) => {
    const indexes = defaultRangeExtractor(range);
    // 未送信の回答を保持するため、入力待ちの応答行はviewport外でもunmountしない。
    if (elicitationMessageIndex >= 0 && !indexes.includes(elicitationMessageIndex)) {
      indexes.push(elicitationMessageIndex);
      indexes.sort((left, right) => left - right);
    }
    return indexes;
  }, [elicitationMessageIndex]);
  const messageVirtualizer = useVirtualizer({
    enabled: artifactDetailsEnabled,
    count: messages.length,
    getScrollElement: () => messageListRef.current,
    estimateSize: () => SESSION_MESSAGE_ESTIMATED_ROW_HEIGHT,
    getItemKey: getRowKey,
    rangeExtractor: extractMessageRange,
    overscan: SESSION_MESSAGE_OVERSCAN,
    anchorTo: isMessageListFollowing ? "end" : "start",
    followOnAppend: false,
    scrollEndThreshold: SESSION_MESSAGE_SCROLL_END_THRESHOLD,
    initialRect: { width: 0, height: SESSION_MESSAGE_FALLBACK_VIEWPORT_HEIGHT },
    initialOffset: Math.max(
      0,
      messages.length * SESSION_MESSAGE_ESTIMATED_ROW_HEIGHT - SESSION_MESSAGE_FALLBACK_VIEWPORT_HEIGHT,
    ),
    directDomUpdates: true,
    directDomUpdatesMode: "position",
    useFlushSync: false,
    useAnimationFrameWithResizeObserver: false,
  });
  messageVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => (
    shouldAdjustSessionMessageScrollPosition({
      itemEnd: item.end,
      scrollOffset: instance.scrollOffset ?? 0,
    })
  );
  const virtualMessages = messageVirtualizer.getVirtualItems();
  useLayoutEffect(() => {
    onMessageListLayout?.();
  }, [virtualMessages, onMessageListLayout]);
  useEffect(() => {
    if (!artifactDetailsEnabled) {
      requestedMessageJumpIdRef.current = null;
      return;
    }
    if (!messageJumpRequest || messageJumpRequest.sessionId !== sessionId) {
      return;
    }
    if (handledMessageJumpRequestIdRef.current === messageJumpRequest.requestId) {
      return;
    }
    const messageIndex = messageKeys?.indexOf(messageJumpRequest.key) ?? -1;
    if (messageIndex < 0) {
      return;
    }

    if (messageJumpRequest.offset !== undefined) {
      const element = messageListRef.current;
      const row = element?.querySelector<HTMLElement>(`.session-message-virtual-row[data-index="${messageIndex}"]`);
      if (element && row) {
        handledMessageJumpRequestIdRef.current = messageJumpRequest.requestId;
        // Replace the index target so a later reconciliation cannot undo the viewport offset.
        messageVirtualizer.scrollToOffset(element.scrollTop + row.getBoundingClientRect().top - element.getBoundingClientRect().top - messageJumpRequest.offset);
        return;
      }
    }
    if (requestedMessageJumpIdRef.current === messageJumpRequest.requestId) return;
    requestedMessageJumpIdRef.current = messageJumpRequest.requestId;
    messageVirtualizer.scrollToIndex(messageIndex, { align: "start" });
    if (messageJumpRequest.offset === undefined) {
      handledMessageJumpRequestIdRef.current = messageJumpRequest.requestId;
      setMessageJumpHighlightKey(messageJumpRequest.key);
    }
  }, [artifactDetailsEnabled, messageJumpRequest, messageKeys, messageVirtualizer, sessionId, virtualMessages]);

  useEffect(() => {
    if (!messageJumpHighlightKey || typeof window === "undefined") {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setMessageJumpHighlightKey((current) => current === messageJumpHighlightKey ? null : current);
    }, 1200);
    return () => window.clearTimeout(timeoutId);
  }, [messageJumpHighlightKey]);

  useEffect(() => {
    setMessageJumpHighlightKey(null);
    handledMessageJumpRequestIdRef.current = null;
    requestedMessageJumpIdRef.current = null;
  }, [sessionId]);
  const hasPendingMessageText =
    pendingMessageTextVisible &&
    pendingResponseMessageIndex < 0 &&
    !hasLiveRunAssistantText &&
    liveApprovalRequest === null &&
    !hasElicitationRequests &&
    !liveRunErrorMessage.trim() &&
    pendingMessageText.trim().length > 0;
  const canUsePendingMessageTextActions = !!(onCopyMessageText || onQuoteMessageText);
  const hasFindQuery = findQuery.trim().length > 0;
  const projectMessageSearchTexts = useMemo(() => createMessageRenderedSearchTextProjection(provider), [sessionId, provider]);
  const conversationFind = useConversationQueryPages({
    identity: `${conversationQueryOwner}:${conversationQueryRevision}:${messageViewMode}:${findQuery}`,
    enabled: isContentActive && artifactDetailsEnabled && findOpen && hasFindQuery,
    ordinal: currentFindMatch,
    read: searchConversation ? (request) => searchConversation({ ...request, query: findQuery, mode: messageViewMode }) : undefined,
    cancel: cancelConversationQuery,
  });
  useEffect(() => { setConversationFindError(""); }, [findQuery, messageViewMode, conversationQueryOwner]);
  const messageRenderedSearchTexts = useMemo(
    () => projectMessageSearchTexts(messages, messageKeys, messageViewMode, hasFindQuery),
    [hasFindQuery, messageKeys, messageViewMode, messages, projectMessageSearchTexts],
  );
  const pendingRenderedSearchText = useMemo(
    () => (hasFindQuery && isRunning && hasPendingMessageText
      ? messageViewMode === "source"
        ? pendingMessageText
        : projectMessageRenderedSearchText(pendingMessageText, provider)
      : ""),
    [hasFindQuery, hasPendingMessageText, isRunning, messageViewMode, pendingMessageText, provider],
  );
  const pendingMessageGroupEndIndex = useMemo(
    () => {
      if (!isRunning || pendingMessageGroupId === null) {
        return -1;
      }

      return messageGroups?.findIndex((messageGroup, index) => (
        messageGroup?.id === pendingMessageGroupId &&
        messageGroups[index + 1]?.id !== messageGroup.id
      )) ?? -1;
    },
    [isRunning, messageGroups, pendingMessageGroupId],
  );
  const messageFindMatches = useMemo(() => {
    const matches: Array<
      | { kind: "message"; messageIndex: number; occurrenceIndex: number }
      | { kind: "pending"; occurrenceIndex: number }
    > = [];
    if (searchConversation) return matches;
    const pendingMatches = findTextMatches(pendingRenderedSearchText, findQuery);
    const appendPendingMatches = () => {
      pendingMatches.forEach((_, occurrenceIndex) => {
        matches.push({ kind: "pending", occurrenceIndex });
      });
    };
    messageRenderedSearchTexts.forEach((text, messageIndex) => {
      findTextMatches(text, findQuery).forEach((_, occurrenceIndex) => {
        matches.push({ kind: "message", messageIndex, occurrenceIndex });
      });
      if (messageIndex === pendingMessageGroupEndIndex) {
        appendPendingMatches();
      }
    });
    if (pendingMessageGroupEndIndex < 0) {
      appendPendingMatches();
    }
    return matches;
  }, [searchConversation, findQuery, messageRenderedSearchTexts, pendingMessageGroupEndIndex, pendingRenderedSearchText]);
  const tailSearchProjection = useMemo(() => createMessageRenderedSearchTextProjection(provider), [conversationQueryOwner, provider]);
  const tailFind = useMemo(() => {
    type TailMatch = { kind: "message"; messageIndex: number; historyIndex: number; occurrenceIndex: number } | { kind: "pending"; occurrenceIndex: number };
    let totalCount = 0;
    let selected: TailMatch | undefined;
    if (!searchConversation || conversationFind.messageCount === undefined) return { totalCount, selected };
    const candidates = (searchTailMessages ?? messages).filter((message, index) => getMessageHistoryIndex(message, index) >= conversationFind.messageCount!);
    const texts = tailSearchProjection(candidates, undefined, messageViewMode, hasFindQuery);
    const selectedIndex = currentFindMatch - conversationFind.totalCount;
    candidates.forEach((message, index) => {
      const historyIndex = getMessageHistoryIndex(message, index);
      if (historyIndex < conversationFind.messageCount!) return;
      let occurrenceIndex = 0;
      for (const _match of iterateTextMatches(texts[index], findQuery)) {
        if (totalCount === selectedIndex) selected = { kind: "message", historyIndex, messageIndex: messages.findIndex((loaded, localIndex) => (searchMessageIndexes?.[localIndex] ?? getMessageHistoryIndex(loaded, localIndex)) === historyIndex), occurrenceIndex };
        totalCount++;
        occurrenceIndex++;
      }
    });
    let occurrenceIndex = 0;
    for (const _match of iterateTextMatches(pendingRenderedSearchText, findQuery)) {
      if (totalCount === selectedIndex) selected = { kind: "pending", occurrenceIndex };
      totalCount++;
      occurrenceIndex++;
    }
    return { totalCount, selected };
  }, [searchConversation, conversationFind.messageCount, conversationFind.totalCount, currentFindMatch, searchTailMessages, searchMessageIndexes, messages, tailSearchProjection, messageViewMode, hasFindQuery, findQuery, pendingRenderedSearchText]);
  const findMatchCount = searchConversation ? conversationFind.totalCount + tailFind.totalCount : messageFindMatches.length;
  const findMatchMessageIndexes = useMemo(
    () => searchConversation ? new Set(messageRenderedSearchTexts.flatMap((text, index) => iterateTextMatches(text, findQuery).next().done ? [] : [index])) : new Set(
      messageFindMatches
        .filter((match): match is Extract<typeof match, { kind: "message" }> => match.kind === "message")
        .map((match) => match.messageIndex),
    ),
    [messageFindMatches, searchConversation, messageRenderedSearchTexts, findQuery],
  );
  const activeCurrentFindMatch = clampFindMatchIndex(currentFindMatch, findMatchCount);
  const savedFindMatch = searchConversation && activeCurrentFindMatch < conversationFind.totalCount ? conversationFind.itemAt(activeCurrentFindMatch) : undefined;
  const tailFindMatch = tailFind.selected;
  const selectedFindMatch = searchConversation ? savedFindMatch
    ? { kind: "message" as const, messageIndex: messages.findIndex((message, index) => getMessageHistoryIndex(message, index) === savedFindMatch.messageIndex), occurrenceIndex: savedFindMatch.occurrenceIndex }
    : tailFindMatch
    : messageFindMatches[activeCurrentFindMatch];
  const canRenderGroupedPending =
    pendingResponseMessageIndex < 0 &&
    pendingMessageGroupEndIndex >= 0 &&
    virtualMessages.some((virtualMessage) => virtualMessage.index === pendingMessageGroupEndIndex);
  const getFindMatchScrollIndex = useCallback((match: (typeof messageFindMatches)[number] | undefined) => {
    if (!match) {
      return null;
    }
    if (match.kind === "message") {
      return match.messageIndex < 0 ? null : match.messageIndex;
    }
    if (pendingMessageGroupEndIndex >= 0) {
      return pendingMessageGroupEndIndex;
    }
    return messages.length > 0 ? messages.length - 1 : null;
  }, [messages.length, pendingMessageGroupEndIndex]);
  const firstFindScrollIndex = getFindMatchScrollIndex(selectedFindMatch);
  const findHistoryIndex = savedFindMatch?.messageIndex ?? (tailFindMatch?.kind === "message" ? tailFindMatch.historyIndex : undefined);
  useEffect(() => {
    let active = true;
    if (findHistoryIndex !== undefined && onLoadMessagePage) void onLoadMessagePage(findHistoryIndex).catch((error: unknown) => { if (active) setConversationFindError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [findHistoryIndex, onLoadMessagePage]);

  useEffect(() => {
    if (previousMessageViewModeRef.current === messageViewMode) {
      return;
    }
    previousMessageViewModeRef.current = messageViewMode;
    setSelectionToolbar(null);
    setSelectionActive(false);
  }, [messageViewMode]);

  useEffect(() => {
    if (!isContentActive) {
      setSelectionToolbar(null);
      setSelectionActive(false);
    }
  }, [isContentActive]);

  const handleMessageListScroll: UIEventHandler<HTMLDivElement> = (event) => {
    onMessageListScroll(event);
  };

  const updateSelectionToolbar = useCallback(() => {
    if (!isContentActive) {
      setSelectionActive(false);
      setSelectionToolbar(null);
      return;
    }
    const messageListElement = messageListRef.current;
    const selectionDetails = getSelectionDetailsWithinMessageList(messageListElement);
    setSelectionActive(Boolean(selectionDetails));
    if (!selectionDetails) {
      setSelectionToolbar(null);
      return;
    }
    const sourceRect = messageListElement?.getBoundingClientRect() ?? null;
    const overlayRect = selectionActionOverlay?.getBoundingClientRect() ?? null;
    const actionDockRect = document.getElementById(SESSION_ACTION_DOCK_ID)?.getBoundingClientRect() ?? null;
    const toolbarRect =
      selectionToolbarRef.current?.getBoundingClientRect() ??
      { width: 112, height: 32 };
    if (
      !sourceRect ||
      !overlayRect ||
      !rectsIntersect(selectionDetails.anchorRect, sourceRect)
    ) {
      setSelectionToolbar(null);
      return;
    }

    const style = resolveSelectionActionOverlayPosition({
      actionDockRect,
      anchorRect: selectionDetails.anchorRect,
      overlayRect,
      sourceRect,
      toolbarRect,
    });
    if (!style) {
      setSelectionToolbar(null);
      return;
    }

    setSelectionToolbar({
      style,
      text: selectionDetails.text,
    });
  }, [isContentActive, messageListRef, selectionActionOverlay]);

  useLayoutEffect(() => {
    if (selectionToolbar) {
      updateSelectionToolbar();
    }
  }, [selectionToolbar?.text, updateSelectionToolbar]);

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    document.addEventListener("selectionchange", updateSelectionToolbar);
    window.addEventListener("resize", updateSelectionToolbar);
    const messageListElement = messageListRef.current;
    messageListElement?.addEventListener("scroll", updateSelectionToolbar, {
      capture: true,
      passive: true,
    });
    return () => {
      document.removeEventListener("selectionchange", updateSelectionToolbar);
      window.removeEventListener("resize", updateSelectionToolbar);
      messageListElement?.removeEventListener("scroll", updateSelectionToolbar, { capture: true });
    };
  }, [messageListRef, updateSelectionToolbar]);

  useEffect(() => {
    if (!isContentActive || !selectionActive || typeof window === "undefined") return;
    const messageListElement = messageListRef.current;
    const actionDockElement = document.getElementById(SESSION_ACTION_DOCK_ID);
    const resizeObserver = typeof window.ResizeObserver === "undefined"
      ? null : new window.ResizeObserver(updateSelectionToolbar);
    if (messageListElement) resizeObserver?.observe(messageListElement);
    if (selectionActionOverlay) resizeObserver?.observe(selectionActionOverlay);
    if (actionDockElement) resizeObserver?.observe(actionDockElement);
    const mutationObserver = messageListElement && typeof window.MutationObserver !== "undefined"
      ? new window.MutationObserver(updateSelectionToolbar) : null;
    if (messageListElement) mutationObserver?.observe(messageListElement, {
      attributeFilter: ["data-index", "style"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [isContentActive, messageListRef, selectionActionOverlay, selectionActive, updateSelectionToolbar]);

  useEffect(() => {
    setCurrentFindMatch(0);
  }, [findQuery, sessionId]);

  useEffect(() => {
    if (!conversationFind.loading) setCurrentFindMatch((current) => clampFindMatchIndex(current, findMatchCount));
  }, [findMatchCount, conversationFind.loading]);

  useEffect(() => {
    if (firstFindScrollIndex !== null) {
      onBrowseMessages?.();
      messageVirtualizer.scrollToIndex(firstFindScrollIndex, { align: "center" });
    }
  }, [findQuery, firstFindScrollIndex, messageVirtualizer, sessionId, onBrowseMessages]);

  const navigateFindMatch = useCallback((direction: 1 | -1) => {
    if (findMatchCount === 0 || conversationFind.error || conversationFindError) {
      return;
    }
    onBrowseMessages?.();
    setCurrentFindMatch((current) => {
      const next = (
        clampFindMatchIndex(current, findMatchCount)
        + direction
        + findMatchCount
      ) % findMatchCount;
      const scrollIndex = searchConversation ? null : getFindMatchScrollIndex(messageFindMatches[next]);
      if (scrollIndex !== null) {
        messageVirtualizer.scrollToIndex(scrollIndex, { align: "center" });
      }
      return next;
    });
  }, [getFindMatchScrollIndex, messageFindMatches, messageVirtualizer, findMatchCount, searchConversation, conversationFind.error, conversationFindError, onBrowseMessages]);

  const visibleMessageSignature = virtualMessages.map((message) => {
    const key = getMessageKey(message.index);
    const target = messageCollapseTargetByKey.get(key);
    const isCollapsed = !!target && collapsedMessageKeys.has(key);
    const isTemporarilyExpanded = findOpen && hasFindQuery && findMatchMessageIndexes.has(message.index);
    return `${message.index}:${isCollapsed && !isTemporarilyExpanded ? "collapsed" : "expanded"}`;
  }).join(",");
  useLayoutEffect(() => {
    const messageListElement = messageListRef.current;
    if (!isContentActive || !findOpen || !findQuery.trim() || !messageListElement) {
      return;
    }
    const ownerDocument = messageListElement.ownerDocument;
    const current = selectedFindMatch ?? null;
    const applyHighlights = () => {
      const resolvedMatches: RenderedTextMatch[] = [];
      let resolvedCurrentMatch: RenderedTextMatch | null = null;
      const appendPendingHighlights = (container: ParentNode) => {
        const pendingRichText = container.querySelector<HTMLElement>(
          "[data-pending-message-body=\"true\"] > .rich-text",
        );
        if (!pendingRichText) {
          return false;
        }
        const index = createRenderedTextSearchIndex(pendingRichText, isMessageRenderedSearchTextNode);
        const matches = findRenderedTextMatchOffsets(index, findQuery);
        appendRenderedTextMatches(resolvedMatches, index, matches);
        if (current?.kind === "pending") {
          resolvedCurrentMatch = resolveRenderedTextMatch(index, matches, current.occurrenceIndex);
        }
        return true;
      };
      let pendingHighlightsAppended = false;
      for (const row of messageListElement.querySelectorAll<HTMLElement>(".session-message-virtual-row")) {
        const messageIndex = Number(row.dataset.index);
        const body = row.querySelector<HTMLElement>("[data-message-body=\"true\"]:not([data-pending-message-body])");
        if (!Number.isInteger(messageIndex) || !body) {
          continue;
        }
        for (const richText of body.querySelectorAll<HTMLElement>(":scope > .rich-text")) {
          const index = createRenderedTextSearchIndex(richText, isMessageRenderedSearchTextNode);
          const matches = findRenderedTextMatchOffsets(index, findQuery);
          appendRenderedTextMatches(resolvedMatches, index, matches);
          if (current?.kind === "message" && current.messageIndex === messageIndex) {
            // Count the original prefix, including a question currently replaced by controls.
            // Form labels and inserted tool-only questions do not belong to the message body.
            const sourceStart = Number(richText.dataset.sourceStart ?? 0);
            const prefix = sourceStart > 0 ? messages[messageIndex].text.slice(0, sourceStart) : "";
            const prefixText = messageViewMode === "source" || !prefix ? prefix : projectMessageRenderedSearchText(prefix, messages[messageIndex].role === "assistant" ? provider : undefined);
            const precedingMatches = findTextMatches(prefixText, findQuery).length;
            resolvedCurrentMatch ??= resolveRenderedTextMatch(index, matches, current.occurrenceIndex - precedingMatches);
          }
        }
        if (messageIndex === pendingMessageGroupEndIndex) {
          pendingHighlightsAppended = appendPendingHighlights(row);
        }
      }
      if (!pendingHighlightsAppended) {
        appendPendingHighlights(messageListElement);
      }
      applyRenderedTextHighlights(ownerDocument, resolvedMatches, resolvedCurrentMatch);
      scrollRenderedTextMatchIntoView(resolvedCurrentMatch, messageListElement);
    };
    applyHighlights();
    const MutationObserverConstructor = ownerDocument.defaultView?.MutationObserver;
    const observer = MutationObserverConstructor ? new MutationObserverConstructor(applyHighlights) : null;
    observer?.observe(messageListElement, { childList: true, characterData: true, subtree: true });
    return () => {
      observer?.disconnect();
      clearRenderedTextHighlights(ownerDocument);
    };
  }, [
    activeCurrentFindMatch,
    findOpen,
    findQuery,
    isContentActive,
    messageFindMatches,
    messages,
    messageViewMode,
    provider,
    selectedFindMatch?.kind,
    selectedFindMatch?.occurrenceIndex,
    selectedFindMatch?.kind === "message" ? selectedFindMatch.messageIndex : -1,
    messageCollapseTargetByKey,
    collapsedMessageKeys,
    messageListRef,
    pendingMessageGroupEndIndex,
    visibleMessageSignature,
  ]);

  const isArtifactFoldOpen = (artifactKey: string, section: MessageArtifactFoldSection, index?: number) =>
    Boolean(openArtifactFolds[messageArtifactFoldKey(artifactKey, section, index)]);

  const loadArtifactDetail = useCallback((artifactKey: string, messageIndex: number, artifact: MessageArtifact | undefined) => {
    if (!artifactDetailsEnabled || !artifact?.detailAvailable || !onLoadArtifactDetail || loadedArtifactDetails.current.has(artifactKey) || artifactAttempts.current.has(artifactKey)) {
      return;
    }

    const request = {};
    artifactAttempts.current.set(artifactKey, request);
    const isCurrentAttempt = () => artifactAttempts.current.get(artifactKey) === request && activeArtifactKeys.current.has(artifactKey);
    const reportError = (message: string) => {
      if (isCurrentAttempt()) setArtifactDetailErrors((current) => ({ ...current, [artifactKey]: message }));
    };
    setLoadingArtifactDetails((current) => ({ ...current, [artifactKey]: true }));
    void onLoadArtifactDetail(messageIndex)
      .then((detail) => {
        if (!isCurrentAttempt()) {
          return;
        }
        if (!detail) {
          reportError("Details are unavailable. Close and reopen to retry.");
          return;
        }
        loadedArtifactDetails.current.set(artifactKey, detail);
        refreshArtifactDetails((revision) => revision + 1);
      })
      .catch(() => reportError("Failed to load details. Close and reopen to retry."))
      .finally(() => {
        if (!isCurrentAttempt()) return;
        setLoadingArtifactDetails((current) => {
          if (!current[artifactKey]) {
            return current;
          }
          const next = { ...current };
          delete next[artifactKey];
          return next;
        });
      });
  }, [artifactDetailsEnabled, onLoadArtifactDetail]);

  useEffect(() => {
    for (const row of virtualMessages) {
      const key = getMessageKey(row.index);
      if (activeArtifactKeys.current.has(key)) loadArtifactDetail(key, row.index, messages[row.index]?.artifact);
    }
  }, [artifactDetailsEnabled, expandedArtifacts, getMessageKey, loadArtifactDetail, messages, virtualMessages]);

  const handleArtifactFoldToggle = (
    artifactKey: string,
    section: MessageArtifactFoldSection,
    openFold: boolean,
    index?: number,
  ) => {
    setOpenArtifactFolds((current) => {
      const key = messageArtifactFoldKey(artifactKey, section, index);
      if (openFold) {
        return current[key] ? current : { ...current, [key]: true };
      }

      if (!current[key]) {
        return current;
      }

      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const renderPendingContent = () => (
    <div className="pending-response-content">
      {!conversationPaging ? <LiveRequestSurface
        sessionId={sessionId}
        workspacePath={workspacePath}
        disabled={elicitationDisabled}
        liveApprovalRequest={liveApprovalRequest}
        approvalActionRequestId={approvalActionRequestId}
        approvalActionDecision={approvalActionDecision}
        liveElicitationRequest={null}
        inputAvailable={elicitationInputAvailable}
        drafts={elicitationDrafts}
        elicitationActionRequestId={elicitationActionRequestId}
        elicitationAction={elicitationAction}
        onResolveLiveApproval={onResolveLiveApproval}
        onResolveLiveElicitation={onResolveLiveElicitation}
        onOpenPath={onOpenPath}
      /> : null}
      {pendingResponseMessageIndex < 0 ? <InlineQuestionContent
        sessionId={sessionId}
        workspacePath={workspacePath}
        disabled={elicitationDisabled}
        text={liveRunAssistantText}
        responseProvider={provider}
        records={visibleLiveElicitationRecords}
        requests={activeQuestions}
        inputAvailable={elicitationInputAvailable}
        drafts={elicitationDrafts}
        elicitationActionRequestId={elicitationActionRequestId}
        elicitationAction={elicitationAction}
        onResolveLiveElicitation={onResolveLiveElicitation}
        onOpenPath={onOpenPath}
        renderText={(text, key, sourceStart) => <MessageRichText key={key} text={text} sourceStart={sourceStart} isStreaming={isRunning} responseProvider={provider}
          resolveImageSource={resolveImageSource} displayMode={messageViewMode} onOpenPath={onOpenPath}
          markdownLinkFileContext={markdownLinkFileContext} markdownImageContext={markdownLinkFileContext} glossaryAnnotationMatcher={glossaryAnnotationMatcher}
          glossaryAnnotationScopeKey={`${sessionId}:pending`} onActivateGlossaryEntry={onActivateGlossaryEntry} />}
      /> : null}
      {hasPendingMessageText ? (
        <div
          data-message-body="true"
          data-message-text-actions={canUsePendingMessageTextActions ? "true" : undefined}
          data-pending-message-body="true"
        >
          <MessageRichText
            resolveImageSource={resolveImageSource}
            text={pendingMessageText}
            responseProvider={provider}
            isStreaming={isRunning}
            forceFullRender={findOpen && hasFindQuery}
            displayMode={messageViewMode}
            onOpenPath={onOpenPath}
            markdownLinkFileContext={markdownLinkFileContext}
            markdownImageContext={markdownLinkFileContext}
            glossaryAnnotationMatcher={glossaryAnnotationMatcher}
            glossaryAnnotationScopeKey={`${sessionId}:pending:${pendingMessageGroupId ?? "main"}`}
            onActivateGlossaryEntry={onActivateGlossaryEntry}
          />
        </div>
      ) : null}
      {liveRunErrorMessage ? (
        <p className="pending-run-error-note" role="alert">{liveRunErrorMessage}</p>
      ) : null}
      <PendingRunIndicator announcement={pendingRunIndicatorAnnouncement} />
    </div>
  );

  const renderResponseStatus = () => isRunning ? renderPendingContent() : <div className="pending-response-content">
    {submissionError ? submissionUncertain ? <p className="pending-run-error-note" role="alert">{submissionError}</p> : <SessionRunFailure reason={submissionError} />
      : <PendingRunIndicator announcement="Waiting for response" />}
  </div>;
  const renderPendingResponse = (className = "") => (
    <article className={`message-row assistant pending-row${className ? ` ${className}` : ""}`}>
      <div className="message-avatar-stack">
        <CharacterAvatar character={character} size="small" className="message-avatar" />
      </div>
      <div className="message-card assistant pending-message-card">
        {renderResponseStatus()}
      </div>
    </article>
  );

  return (
    <div className={`session-message-column${conversationPaging ? " is-paged" : ""}`}>
      <SessionContentFindBar
        open={findOpen}
        query={findQuery}
        currentMatch={activeCurrentFindMatch}
        matchCount={findMatchCount}
        loading={!!searchConversation && conversationFind.loading}
        unavailable={!!conversationFind.error || !!conversationFindError}
        onQueryChange={setFindQuery}
        onPrevious={() => navigateFindMatch(-1)}
        onNext={() => navigateFindMatch(1)}
        onClose={() => setFindOpen(false)}
      />
      {findOpen && (conversationFindError || conversationFind.error) ? <div role="alert">{conversationFindError || conversationFind.error}<button className="drawer-toggle compact secondary" type="button" onClick={() => { setConversationFindError(""); conversationFind.retry(); }}>Retry</button></div> : null}
      {conversationPaging && (conversationPaging.loading || conversationPaging.error) ? (
        <div className="conversation-page-feedback">
          <div className="conversation-page-controls" aria-busy={conversationPaging.loading}>
            {conversationPaging.loading ? <LoadingIndicator inline label="Loading Messages" /> : null}
            {conversationPaging.error ? <><span role="alert">{conversationPaging.error}</span><button className="drawer-toggle compact secondary" type="button" onClick={conversationPaging.onRetry}>Retry</button></> : null}
          </div>
        </div>
      ) : null}
      {conversationPaging ? <div className="conversation-live-request"><LiveRequestSurface
        sessionId={sessionId}
        workspacePath={workspacePath}
        disabled={elicitationDisabled}
        liveApprovalRequest={liveApprovalRequest}
        approvalActionRequestId={approvalActionRequestId}
        approvalActionDecision={approvalActionDecision}
        liveElicitationRequest={null}
        inputAvailable={elicitationInputAvailable}
        drafts={elicitationDrafts}
        elicitationActionRequestId={elicitationActionRequestId}
        elicitationAction={elicitationAction}
        onResolveLiveApproval={onResolveLiveApproval}
        onResolveLiveElicitation={onResolveLiveElicitation}
        onOpenPath={onOpenPath}
      /></div> : null}
      {onJumpToBottom && !isMessageListFollowing ? (
        <button
          className="message-list-jump-bottom-button"
          type="button"
          onClick={() => {
            messageListRef.current?.focus({ preventScroll: true });
            onJumpToBottom();
          }}
          aria-label="Jump to latest"
          title="Jump to latest"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M8 2v9M3.5 7.5 8 12l4.5-4.5M3 14h10" />
          </svg>
        </button>
      ) : null}
      <div className="session-message-list" ref={messageListRef} onScroll={handleMessageListScroll} data-message-count={messages.length} tabIndex={0} role="region" aria-label="Conversation messages">
        {messages.length > 0 || isRunning || responsePending || submissionError || renderQueueTail ? (
          <div className="session-message-list-window">
            <div
              ref={messageVirtualizer.containerRef}
              className="session-message-list-window-items"
              style={{ position: "relative" }}
            >
          {virtualMessages.map((virtualMessage) => {
            const absoluteIndex = virtualMessage.index;
            const message = messages[absoluteIndex];
            if (!message) {
              return null;
            }
            const messageKey = getMessageKey(absoluteIndex);
            const messageGroup = messageGroups?.[absoluteIndex] ?? null;
            const previousMessageGroup = absoluteIndex > 0 ? messageGroups?.[absoluteIndex - 1] ?? null : null;
            const nextMessageGroup = messageGroups?.[absoluteIndex + 1] ?? null;
            const isMessageGroupStart = !!messageGroup && previousMessageGroup?.id !== messageGroup.id;
            const isMessageGroupEnd = !!messageGroup && nextMessageGroup?.id !== messageGroup.id;
            const doesMessageGroupContinue = !!messageGroup && nextMessageGroup?.id === messageGroup.id;
            const shouldRenderGroupedPending =
              isRunning &&
              canRenderGroupedPending &&
              isMessageGroupEnd &&
              messageGroup?.id === pendingMessageGroupId;
            const shouldCloseMessageGroup = isMessageGroupEnd && !shouldRenderGroupedPending;
            const artifactKey = messageKey;
            const artifactExpanded = expandedArtifacts[artifactKey] ?? false;
            const isAssistant = message.role === "assistant";
            const artifact = artifactExpanded ? loadedArtifactDetails.current.get(artifactKey) ?? message.artifact : message.artifact;
            const artifactLoading = loadingArtifactDetails[artifactKey] ?? false;
            const artifactDetailError = artifactDetailErrors[artifactKey];
            const artifactOperations: import("../../../src-shared/session/runtime-state.js").MessageOperation[] =
              artifact?.operationTimeline ??
              artifact?.activitySummary.map((item) => ({
                type: "summary",
                summary: item,
                details: undefined,
              })) ??
              [];
            const artifactOperationsOpen = isArtifactFoldOpen(artifactKey, "operations");
            const canUseMessageTextActions = isAssistant && (onCopyMessageText || onQuoteMessageText);
            const messageCollapseTarget = messageCollapseTargetByKey.get(messageKey);
            const isMessageCollapsed = !!messageCollapseTarget && collapsedMessageKeys.has(messageKey);
            const isFindMatch = findMatchMessageIndexes.has(absoluteIndex);
            const shouldRenderFullMessage = !isMessageCollapsed || (findOpen && hasFindQuery && isFindMatch)
              || (hasElicitationRequests && absoluteIndex === pendingResponseMessageIndex);
            const messageBodyId = `message-body-${messageKey.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
            const messageCollapseLabel = isMessageCollapsed ? "Expand message" : "Collapse message";
            const isMessageBookmarked = messageCollapseTarget?.isBookmarked === true;
            const messageBookmarkLabel = isMessageBookmarked ? "Remove bookmark" : "Add bookmark";

            return (
              <div
                key={`${message.role}-${getRowKey(absoluteIndex)}`}
                ref={messageVirtualizer.measureElement}
                className={`session-message-virtual-row${
                  doesMessageGroupContinue ? " auxiliary-message-group-continues" : ""
                }${absoluteIndex === messages.length - 1 ? " session-message-virtual-row-end" : ""}${
                  messageJumpHighlightKey === messageKey ? " message-jump-highlight" : ""
                }`}
                data-index={absoluteIndex}
              >
                {isMessageGroupStart && messageGroup ? (
                  <div
                    className="auxiliary-message-group-label"
                    role="separator"
                    aria-label={messageGroup.label}
                  >
                    <span>{messageGroup.label}</span>
                  </div>
                ) : null}
              <article
                className={`message-row ${message.role}${sharedPending && absoluteIndex === messages.length - 1 ? " pending-row" : ""}${message.accent ? " accent" : ""}${
                  messageGroup ? " auxiliary-message-group-item" : ""
                }${isMessageGroupStart ? " auxiliary-message-group-start" : ""}${
                  shouldCloseMessageGroup ? " auxiliary-message-group-end" : ""
                }`}
              >
                {isAssistant ? (
                  <div className="message-avatar-stack">
                    <CharacterAvatar character={character} size="small" className="message-avatar" />
                    {artifact ? (
                      <button
                        className="artifact-toggle artifact-toggle-icon"
                        type="button"
                        onClick={() => {
                          if (!artifactExpanded) {
                            loadArtifactDetail(artifactKey, absoluteIndex, message.artifact);
                          }
                          onToggleArtifact(artifactKey);
                        }}
                        aria-expanded={artifactExpanded}
                        aria-controls={`artifact-panel-${artifactKey}`}
                        aria-label={artifactExpanded ? "Hide details" : "Show details"}
                        title={artifactExpanded ? "Hide details" : "Details"}
                      >
                        {artifactExpanded ? "−" : "i"}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <div className={`message-card ${message.role}${message.accent ? " accent" : ""}${artifact ? " has-artifact" : ""}${isMessageCollapsed ? " is-collapsed" : ""}${isMessageCollapsed && shouldRenderFullMessage ? " is-find-temporary-expanded" : ""}`}>
                  <div className="message-card-content">
                    {artifact && !isAssistant ? (
                      <button
                        className="artifact-toggle artifact-toggle-icon"
                        type="button"
                        onClick={() => {
                          if (!artifactExpanded) {
                            loadArtifactDetail(artifactKey, absoluteIndex, message.artifact);
                          }
                          onToggleArtifact(artifactKey);
                        }}
                        aria-expanded={artifactExpanded}
                        aria-controls={`artifact-panel-${artifactKey}`}
                        aria-label={artifactExpanded ? "Hide details" : "Show details"}
                        title={artifactExpanded ? "Hide details" : "Details"}
                      >
                        {artifactExpanded ? "−" : "i"}
                      </button>
                    ) : null}
                    <div className={`message-text-wrapper${messageCollapseTarget && (onToggleMessageCollapse || onToggleMessageBookmark) ? " has-message-collapse-control" : ""}`}>
                      {messageCollapseTarget && (onToggleMessageCollapse || onToggleMessageBookmark) ? (
                        <div className="message-collapse-control">
                          {onToggleMessageCollapse ? (
                            <button
                              className="message-collapse-toggle"
                              type="button"
                              onClick={() => onToggleMessageCollapse(messageKey)}
                              aria-expanded={!isMessageCollapsed}
                              aria-controls={messageBodyId}
                              aria-label={`${messageCollapseLabel}: ${messageCollapseTarget.preview}`}
                              title={messageCollapseLabel}
                            >
                              <span aria-hidden="true">{isMessageCollapsed ? "+" : "−"}</span>
                              <span className="visually-hidden">{messageCollapseLabel}</span>
                            </button>
                          ) : null}
                          {onToggleMessageBookmark ? (
                            <button
                              className={`message-bookmark-toggle${isMessageBookmarked ? " is-bookmarked" : ""}`}
                              type="button"
                              aria-pressed={isMessageBookmarked}
                              aria-label={messageBookmarkLabel}
                              title={messageBookmarkLabel}
                              onClick={() => void onToggleMessageBookmark(messageCollapseTarget)}
                            >
                              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                                <path d="M4 2.25h8a.75.75 0 0 1 .75.75v10.2l-4.75-2.55-4.75 2.55V3a.75.75 0 0 1 .75-.75Z" />
                              </svg>
                              <span className="visually-hidden">{messageBookmarkLabel}</span>
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                      <div
                        id={messageBodyId}
                        data-message-body="true"
                        data-message-text-actions={canUseMessageTextActions ? "true" : undefined}
                      >
                        {shouldRenderFullMessage ? (
                          <InlineQuestionContent
                            sessionId={sessionId}
                            workspacePath={workspacePath}
                            disabled={elicitationDisabled}
                            text={message.text}
                            responseProvider={message.role === "assistant" ? provider : undefined}
                            records={absoluteIndex === pendingResponseMessageIndex ? [...message.elicitationRecords ?? [], ...visibleLiveElicitationRecords ?? []] : message.elicitationRecords}
                            requests={absoluteIndex === pendingResponseMessageIndex ? activeQuestions : []}
                            inputAvailable={elicitationInputAvailable}
                            drafts={elicitationDrafts}
                            elicitationActionRequestId={elicitationActionRequestId}
                            elicitationAction={elicitationAction}
                            onResolveLiveElicitation={onResolveLiveElicitation}
                            onOpenPath={onOpenPath}
                            renderText={(text, key, sourceStart) => <MessageRichText
                              key={key}
                              sourceStart={sourceStart}
                              resolveImageSource={resolveImageSource}
                              text={text}
                              responseProvider={message.role === "assistant" ? provider : undefined}
                              isStreaming={isRunning && absoluteIndex === pendingResponseMessageIndex}
                              streamingTextPresented={responsePresentationKey !== undefined}
                              forceFullRender={findOpen && hasFindQuery}
                              displayMode={messageViewMode}
                              onOpenPath={onOpenPath}
                              markdownLinkFileContext={markdownLinkFileContext}
                              markdownImageContext={markdownLinkFileContext}
                              glossaryAnnotationMatcher={glossaryAnnotationMatcher}
                              glossaryAnnotationScopeKey={messageKey}
                              onActivateGlossaryEntry={onActivateGlossaryEntry}
                            />}
                          />
                        ) : (
                          <p className="message-collapsed-preview">{messageCollapseTarget?.preview}</p>
                        )}
                      </div>
                    </div>

                    {isAssistant && message.runFailure !== undefined ? <SessionRunFailure reason={message.runFailure} /> : null}
                    {artifact ? (
                      <section className="artifact-shell">
                      {artifactExpanded ? (
                        <div id={`artifact-panel-${artifactKey}`} className="artifact-block">
                          {artifactLoading ? (
                            <div className="artifact-detail-loading">
                              <LoadingIndicator inline label="Loading details" />
                            </div>
                          ) : null}
                          {artifactDetailError ? <p className="pending-run-error-note" role="alert">{artifactDetailError}</p> : null}
                          <div className="artifact-grid artifact-grid-single">
                            <section className="artifact-section compact">
                              <div className="artifact-section-header">
                                <strong>Run Checks</strong>
                              </div>
                              <div className="check-list">
                                {artifact.runChecks.map((check) => (
                                  <div key={check.label} className="check-item">
                                    <span>{check.label}</span>
                                    <strong>{displayRunCheckValue(check)}</strong>
                                  </div>
                                ))}
                              </div>
                            </section>
                          </div>

                          {artifactOperations.length > 0 ? (
                            <section className="artifact-section compact">
                              <details
                                className="artifact-fold artifact-operations-fold"
                                open={artifactOperationsOpen}
                                onToggle={(event) => {
                                  handleArtifactFoldToggle(artifactKey, "operations", event.currentTarget.open);
                                }}
                              >
                                <summary
                                  className="artifact-fold-summary artifact-operations-summary"
                                  aria-controls={`artifact-operations-panel-${artifactKey}`}
                                  aria-expanded={artifactOperationsOpen}
                                >
                                  <span className="artifact-fold-summary-copy">
                                    <strong>Operations</strong>
                                    <span>{artifactOperations.length} {artifactOperations.length === 1 ? "operation" : "operations"}</span>
                                  </span>
                                </summary>
                                <div id={`artifact-operations-panel-${artifactKey}`} className="artifact-fold-body artifact-operations-body">
                                  {artifactOperations.map((operation, operationIndex) => {
                                    const operationSummary = collapseSummaryText(operation.summary) || operationTypeLabel(operation.type);
                                    const operationOpen = isArtifactFoldOpen(artifactKey, "operation", operationIndex);
                                    const operationPanelId = `artifact-operation-panel-${artifactKey}-${operationIndex}`;
                                    return (
                                      <article key={`${operation.type}-${operationIndex}`} className={`artifact-operation-item ${operation.type}`}>
                                        <details
                                          className="artifact-operation-fold"
                                          open={operationOpen}
                                          onToggle={(event) => {
                                            handleArtifactFoldToggle(artifactKey, "operation", event.currentTarget.open, operationIndex);
                                          }}
                                        >
                                          <summary
                                            className="artifact-operation-summary"
                                            title={operationSummary}
                                            aria-controls={operationPanelId}
                                            aria-expanded={operationOpen}
                                          >
                                            <div className="artifact-operation-head">
                                              <span className={`artifact-operation-type ${operation.type}`}>{operationTypeLabel(operation.type)}</span>
                                              <span className="artifact-operation-summary-text">{operationSummary}</span>
                                            </div>
                                          </summary>
                                          <div id={operationPanelId} className="artifact-operation-body">
                                            {operation.type === "agent_message" ? (
                                              <div className="artifact-operation-message">
                                                <MessageRichText
                                                  resolveImageSource={resolveImageSource}
                                                  text={operation.summary}
                                                  responseProvider={provider}
                                                  onOpenPath={onOpenPath}
                                                  markdownLinkFileContext={markdownLinkFileContext}
                                                  markdownImageContext={markdownLinkFileContext}
                                                />
                                              </div>
                                            ) : (
                                              <p>{operation.summary}</p>
                                            )}
                                            {operation.status ? <p>{liveRunStepStatusLabel(operation.status)}</p> : null}
                                            {operation.exitCode !== undefined ? <p>Exit Code: {operation.exitCode}</p> : null}
                                            {operation.error ? <p className="pending-run-error-note" role="alert">{operation.error.message}</p> : null}
                                            {operation.truncated ? <p>Output Truncated</p> : null}
                                            {operation.details ? <pre>{operation.details}</pre> : null}
                                          </div>
                                        </details>
                                      </article>
                                    );
                                  })}
                                </div>
                              </details>
                            </section>
                          ) : null}
                        </div>
                      ) : null}
                      </section>
                    ) : null}
                    {turnQueueMetadata?.get(messageKey) ? <SessionTurnQueueStatus receipt={turnQueueMetadata.get(messageKey)!} busy={queueBusyId === turnQueueMetadata.get(messageKey)!.id} busyKind={queueBusyId === turnQueueMetadata.get(messageKey)!.id ? queueBusyKind : null} onCancel={onCancelQueuedTurn ?? (() => {})} onRelease={onReleaseInterruptedTurn ?? (() => {})} /> : null}
                    {message.runFailure === undefined && (isRunning || responsePending || submissionError) && absoluteIndex === pendingResponseMessageIndex ? renderResponseStatus() : null}
                  </div>
                </div>
                </article>
                {shouldRenderGroupedPending ? renderPendingResponse("auxiliary-message-group-item auxiliary-message-group-end") : null}
              </div>
            );
          })}
            </div>
            {(isRunning || responsePending || submissionError) && pendingResponseMessageIndex < 0 && !canRenderGroupedPending ? renderPendingResponse() : null}
            {renderQueueTail?.(resolveImageSource, markdownLinkFileContext)}
            <div className="message-list-bottom-anchor" aria-hidden="true" />
          </div>
        ) : null}
        {selectionToolbar && selectionActionOverlay ? createPortal(
          <MessageResponseActions
            actionText={selectionToolbar.text}
            onCopyMessageText={onCopyMessageText}
            onQuoteMessageText={onQuoteMessageText}
            style={selectionToolbar.style}
            toolbarRef={selectionToolbarRef}
          />,
          selectionActionOverlay,
        ) : null}
      </div>
    </div>
  );
}

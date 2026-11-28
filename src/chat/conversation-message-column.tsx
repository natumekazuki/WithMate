import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type UIEvent } from "react";

import { type SessionMessageColumnProps } from "./conversation/session-message-column.js";
import { useSessionMessageListFollowing } from "./shell/session-chat-layout-hooks.js";
import { StableSessionMessageColumn } from "./stable-session-message-column.js";
import { buildLiveAssistantProjectionKey, buildMessageListProjection, hasPersistedLiveAssistantMessage, loadProjectedMessageArtifact, projectLiveAssistantOnSessionHistory, resolveLiveAssistantMessageIndex, type LiveAssistantProjection } from "./auxiliary/auxiliary-session-message-projection.js";
import { buildMessageCollapseTargets, buildMessageNavigatorEntries, type MessageCollapseStateEntry, type MessageJumpRequest, type MessageNavigatorEntry } from "./conversation/session-message-collapse.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { Message, Session } from "../../src-shared/session/session-state.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { buildCharacterThemeStyle } from "../ui/theme-utils.js";
import { replaceLiveRunAfterResolvedRequest } from "./runtime/session-live-run-state.js";
import { CONVERSATION_PAGE_SIZE, CONVERSATION_QUERY_PAGE_SIZE, getMessageHistoryIndex, type ConversationPage, type ConversationPageRequest } from "../../src-shared/session/conversation-page.js";
import { getSessionIncarnationId, setMessageBookmarked } from "../../src-shared/session/session-state.js";
import { subscribeSessionLiveSelection } from "./runtime/session-window-live-ingress.js";
import { useConversationQueryPages } from "./conversation/use-conversation-query-pages.js";
import type { MessageNavigatorPage } from "./shell/session-context-pane.js";
import { useSessionTurnQueue } from "./conversation/use-session-turn-queue.js";
import { projectSessionTurnQueue, savedQueuedInputSeqs } from "./conversation/session-turn-queue-projection.js";
import { SessionTurnQueueRow, SessionTurnSubmissionRow } from "./conversation/session-turn-queue-row.js";
import { SessionTurnSubmissions } from "./runtime/session-turn-submissions.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import type { MarkdownImageContext, MarkdownImageResolver } from "../ui/markdown/image-resource-loader.js";
import { composerControllerRegistry, type ComposerControllerRegistry } from "./composer-controller.js";
import { observeSessionResultRead } from "./conversation/observe-session-result-read.js";
import { conversationPeerKey, type ConversationThreads } from "../../src-shared/session/conversation-threads.js";
import { ALL_MAIN_THREADS_ID, threadPageIndexes, type MainConversationFrame } from "./conversation/use-main-conversation-threads.js";
import type { SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";

const CONVERSATION_WINDOW_SIZE = CONVERSATION_PAGE_SIZE * 3;
const CONVERSATION_LOAD_MARGIN = 96;
const EMPTY_MESSAGES: Message[] = [];
type ConversationPageDirection = "earlier" | "later";
type ResponseBridge = LiveAssistantProjection & { userMessageSeq?: number };
type StableMessageKey = { role: Message["role"]; key: string; withMateTurnId?: string };

function turnResponsePosition(history: readonly Message[], userMessageSeq: number, withMateTurnId: string, confirmedInputs?: ReadonlyMap<number, string>): number {
  let seq = userMessageSeq + 1;
  // 応答位置を移動できるのは、同じ Turn に属する連続した入力だけ。
  // 別の開始プロンプトや履歴の欠落があれば、それに続く assistant の応答をこの Turn に結び付ける根拠にはならない。
  for (const [index, message] of history.entries()) {
    const messageSeq = getMessageHistoryIndex(message, index);
    if (messageSeq < seq) continue;
    if (messageSeq !== seq || message.role !== "user" || (message.turnInput?.turnId ?? confirmedInputs?.get(seq)) !== withMateTurnId) break;
    seq++;
  }
  return seq;
}

function positionResponseBridge<T extends Omit<ResponseBridge, "text">>(bridge: T, history: readonly Message[]): T {
  if (!bridge.withMateTurnId || bridge.userMessageSeq === undefined) return bridge;
  const messageIndex = turnResponsePosition(history, bridge.userMessageSeq, bridge.withMateTurnId);
  return messageIndex === bridge.messageIndex ? bridge : { ...bridge, messageIndex };
}

function responseBridgeKey(bridge: Omit<ResponseBridge, "text">): string {
  return buildLiveAssistantProjectionKey(bridge.sessionId, bridge.threadId, bridge.messageIndex, bridge.withMateTurnId);
}

export type ConversationColumnSession = Pick<Session, "id"> & Partial<Pick<Session,
  "messages" | "messageCount" | "incarnationId" | "updatedAt" | "runState" | "threadId" | "characterId" | "character" | "characterIconPath" | "characterThemeColors" | "accessMode" | "provider" | "workspacePath"
>>;

export type ConversationMessageColumnApi = Partial<Pick<WithMateWindowApi,
  "subscribeLiveSessionRun" | "getLiveSessionRun" | "resolveLiveApproval" | "resolveLiveElicitation" | "getSessionMessageArtifact" | "getConversationPage" | "searchConversation" | "listConversationNavigator" | "cancelConversationQuery"
  | "listSessionTurnQueue" | "getSessionTurnQueueReceipt" | "listSessionTurnQueueReceipts" | "onSessionTurnQueueChanged" | "cancelQueuedSessionTurn" | "sendQueuedSessionInput" | "reorderQueuedSessionTurns"
  | "getUnreadSessionResult" | "markSessionResultRead" | "onSessionTurnUpdated"
>>;

export type ConversationColumnCache = {
  incarnationId?: string;
  scrollState: { scrollTop: number; isFollowing: boolean } | null;
  collapsedMessageKeys: Set<string>;
  defaultCollapsed?: boolean;
  collapseExceptions?: Map<number, boolean>;
  liveRun: LiveSessionRunState | null;
  bridge: Omit<ResponseBridge, "text"> | null;
  liveBridgeBody?: { text: string; turnId?: string };
  approvalRequestId: string | null;
  approvalDecision?: "approve" | "deny" | null;
  elicitationRequestId: string | null;
  elicitationAction?: SessionMessageColumnProps["elicitationAction"];
  error: string;
  liveReadError?: string;
  messageJumpRequest: MessageJumpRequest | null;
  messageJumpRequestId: number;
  pageStart?: number;
  anchor?: { key: string; offset: number; messageIndex?: number };
};

export type UseConversationMessageColumnInput = {
  session: ConversationColumnSession | null;
  baseProps: SessionMessageColumnProps;
  messageSourceKind?: "session" | "auxiliary";
  enabled: boolean;
  navigatorActive?: boolean;
  api?: ConversationMessageColumnApi;
  liveRun?: LiveSessionRunState | null;
  stateCache?: Map<string, ConversationColumnCache>;
  onColumnControls?: (controls: ConversationColumnControls) => void;
  composerRegistry?: ComposerControllerRegistry;
  frame?: MainConversationFrame;
  mainThreads?: ConversationThreads;
  showAllThreads?: boolean;
};

export type ConversationColumnControls = {
  sessionId: string;
  messageCollapseTargetKeys: readonly string[];
  collapsedMessageKeys: ReadonlySet<string>;
  allMessagesCollapsed: boolean;
  isMessageListFollowing: boolean;
  captureMessageListSend: (scrollToLatestOnSend: boolean) => (() => void);
  onToggleAllMessageCollapse: () => void;
  followLatest: () => void;
  /** 保留中の承認・質問フォームが見える位置までスクロールし、その後フォームの上端が一覧内にあるかを返す。 */
  revealRequest: () => boolean;
  messageNavigatorEntries: readonly MessageNavigatorEntry[];
  messageNavigatorPage?: MessageNavigatorPage;
  onJumpToMessage: (key: string) => void;
  onJumpToReply: (seq: number, sentKey: string | undefined, isCurrent: () => boolean) => void;
  replyOwnerKey?: string;
  captureReadingPosition?: () => void;
  frameId?: string;
  liveFrameId?: string;
  runningFrameId?: string;
};

export function useConversationMessageColumn({
  session, baseProps, messageSourceKind = "session", enabled, navigatorActive = false, api, liveRun: liveRunOverride, stateCache, onColumnControls, composerRegistry = composerControllerRegistry,
  frame, mainThreads, showAllThreads = false,
}: UseConversationMessageColumnInput): SessionMessageColumnProps | null {
  const localCache = useRef(new Map<string, ConversationColumnCache>());
  const caches = stateCache ?? localCache.current;
  const sessionId = session?.id ?? baseProps.sessionId;
  const child = frame?.child;
  const peerKey = child ? conversationPeerKey(child.target) : undefined;
  const frameId = showAllThreads ? ALL_MAIN_THREADS_ID : peerKey;
  const cacheKey = frameId ? JSON.stringify([sessionId, session?.incarnationId, frameId]) : sessionId;
  const getCache = (key: string) => {
    let cache = caches.get(key);
    if (!cache || (cache.incarnationId !== undefined && cache.incarnationId !== (session?.incarnationId ?? ""))) {
      cache = { incarnationId: session?.incarnationId ?? "", scrollState: null, collapsedMessageKeys: new Set(), liveRun: null, bridge: null, approvalRequestId: null, elicitationRequestId: null, error: "", messageJumpRequest: null, messageJumpRequestId: 0 };
      caches.set(key, cache);
    }
    return cache;
  };
  const conversation = getCache(cacheKey);
  // この観測値は実行中の Session に属し、選択中の表示には属さない。
  const liveState = getCache(sessionId);
  const liveRunEventRevision = useRef(0);
  const [liveReadRevision, setLiveReadRevision] = useState(0);
  const [, rerender] = useState(0);
  const displayedId = useRef(sessionId);
  displayedId.current = sessionId;
  const mounted = useRef(true);
  const retainedBridges = useRef<{ owner: string; projections: ResponseBridge[] }>({ owner: "", projections: [] });
  const stableMessageKeys = useRef<{ owner: string; keys: Map<number, StableMessageKey>; responses: Map<string, string> }>({ owner: "", keys: new Map(), responses: new Map() });
  const liveResponseOwner = useRef<{ owner: string; turnId?: string; messageIndex: number } | null>(null);
  const responsePresentation = useRef<{ owner: string; requestId?: string; sessionTurnId?: string; turnId?: string; key: string } | null>(null);
  const [browsePage, setBrowsePage] = useState<{ owner: string; page: ConversationPage } | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState("");
  const [navigatorFilter, setNavigatorFilter] = useState<"all" | "bookmarks">("all");
  const [navigatorOffset, setNavigatorOffset] = useState(0);
  const [navigatorRevision, setNavigatorRevision] = useState(0);
  const pageRevision = useRef(0);
  const requestedPageStart = useRef<number | undefined>(undefined);
  const requestedPageDirection = useRef<ConversationPageDirection | undefined>(undefined);
  const inFlightPage = useRef<number | null>(null);
  const capturePageAnchor = useRef<() => ConversationColumnCache["anchor"]>(() => undefined);
  const loadAtBoundary = useRef<() => void>(() => {});
  const bookmarkRevision = useRef(0);
  const pageOwner = frameId ? cacheKey : `${sessionId}:${session?.incarnationId ?? ""}`;
  const activePageOwner = useRef(pageOwner);
  activePageOwner.current = pageOwner;
  const displayEnabled = useRef(enabled);
  displayEnabled.current = enabled;
  const incomingTailMessages = session?.messages ?? baseProps.messages;
  const totalCount = session?.messageCount ?? incomingTailMessages.length;
  const threadIndexes = useMemo(() => frame ? threadPageIndexes(frame) : undefined, [frame]);
  const threadPageSignature = threadIndexes?.join(",");
  const threadFullIndexes = useMemo(() => frame ? new Set(frame.messageIndexes) : undefined, [frame]);
  const pageIndexes = useMemo(() => threadIndexes && new Set(threadIndexes), [threadIndexes]);
  const currentThreadIndexes = useRef(threadIndexes);
  currentThreadIndexes.current = threadIndexes;
  const currentPage = browsePage?.owner === pageOwner ? browsePage.page : null;
  const isBrowsing = conversation.pageStart !== undefined;
  const scopedMessages = useMemo(() => pageIndexes
    ? currentPage?.messages.filter((message, index) => pageIndexes.has(getMessageHistoryIndex(message, index))) ?? EMPTY_MESSAGES
    : EMPTY_MESSAGES, [currentPage, pageIndexes]);
  const queueIncarnationId = session ? getSessionIncarnationId(session) : "";
  const canonicalUserSeqs = useMemo(() => incomingTailMessages.flatMap((message, index) => message.role === "user" ? [getMessageHistoryIndex(message, index)] : []), [incomingTailMessages]);
  const observedUserSeqs = useMemo(() => !isBrowsing && scopedMessages.length
    ? [...new Set([...canonicalUserSeqs, ...scopedMessages.flatMap((message, index) =>
      message.role === "user" && threadFullIndexes?.has(getMessageHistoryIndex(message, index)) ? [getMessageHistoryIndex(message, index)] : [])])].sort((a, b) => a - b)
    : canonicalUserSeqs, [canonicalUserSeqs, scopedMessages, threadFullIndexes, isBrowsing]);
  const canonicalStartSeqs = useMemo(() => incomingTailMessages.flatMap((message, index) =>
    message.role === "user" && !message.turnInput ? [getMessageHistoryIndex(message, index)] : []), [incomingTailMessages]);
  const emptySubmissions = useRef(new SessionTurnSubmissions());
  const submissionStore = baseProps.turnSubmissions ?? emptySubmissions.current;
  const submissionSnapshot = useSyncExternalStore(submissionStore.subscribe, submissionStore.getSnapshot, submissionStore.getSnapshot);
  const submissions = useMemo(() => submissionSnapshot.filter((submission) => submission.sessionId === sessionId && submission.incarnationId === queueIncarnationId), [submissionSnapshot, sessionId, queueIncarnationId]);
  const rawLiveRun = liveRunOverride !== undefined ? liveRunOverride : liveState.liveRun;
  const allQueue = useSessionTurnQueue(api, sessionId, queueIncarnationId, enabled, canonicalUserSeqs, submissions, rawLiveRun, observedUserSeqs);
  const observeTurnReceipts = baseProps.onTurnReceiptsObserved;
  useEffect(() => {
    if (enabled && queueIncarnationId) observeTurnReceipts?.(allQueue.receipts, {
      sessionId, incarnationId: queueIncarnationId, kind: messageSourceKind === "auxiliary" ? "auxiliary" : "main",
    });
  }, [observeTurnReceipts, allQueue.receipts, enabled, sessionId, queueIncarnationId, messageSourceKind]);
  const children = mainThreads?.children ?? frame?.children;
  const visibleSubmissions = useMemo(() => !frame ? submissions : submissions.filter(({ mainConversationFrame }) => {
    const target = mainConversationFrame && children?.find((candidate) => conversationPeerKey(candidate.target) === conversationPeerKey(mainConversationFrame));
    return (target || undefined) === child;
  }), [submissions, frame, children, child]);
  const receiptFrame = useCallback((receipt: SessionTurnQueueReceipt) => {
    const input = receipt.dispatched ?? receipt.accepted ?? receipt.captured;
    const { origin } = input;
    if (origin?.targetSessionId !== sessionId || origin.targetIncarnationId !== queueIncarnationId) return undefined;
    if (origin.kind === "gui" && (input.retrySource || input.coordination?.operation === "answer" && input.coordination.targetKind === "main")) {
      return input.request.mainConversationFrame !== undefined ? input.request.mainConversationFrame : receipt.captured.request.mainConversationFrame;
    }
    if (origin.kind === "gui" && receipt.inputTurnId == null && !input.retrySource && input.request.mainConversationFrame !== undefined) {
      return input.request.mainConversationFrame;
    }
    if (origin.kind === "session" && origin.actorKind === "main") {
      return children?.find(({ target }) => target.sessionId === origin.actorSessionId && target.incarnationId === origin.actorIncarnationId)?.target;
    }
    return undefined;
  }, [children, sessionId, queueIncarnationId]);
  const findChild = (target: ReturnType<typeof receiptFrame>) => target
    ? children?.find((candidate) => conversationPeerKey(candidate.target) === conversationPeerKey(target)) : undefined;
  const currentTurnId = rawLiveRun?.sessionTurnId;
  const liveReceipt = rawLiveRun?.queueReceipt;
  const entry = currentTurnId ? allQueue.receipts.find((receipt) => receipt.inputTurnId == null
    && (receipt.turnId === currentTurnId || receipt.id === liveReceipt?.id && receipt.incarnationId === liveReceipt.incarnationId)) : undefined;
  const liveChild = currentTurnId ? children?.find(({ inboundTurnIds }) => inboundTurnIds.includes(currentTurnId))
    ?? (entry && findChild(receiptFrame(entry))) : undefined;
  const awaitingLiveFrame = !!children?.length && !!currentTurnId && !!liveReceipt && !entry && !liveChild
    && !mainThreads?.initialMessageIndexes.includes(liveReceipt.userMessageSeq);
  const liveBelongsHere = !frame || !awaitingLiveFrame && child === liveChild;
  const liveRun = liveBelongsHere ? rawLiveRun : null;
  const threadReceipts = useMemo(() => allQueue.receipts.filter((receipt) => {
    const input = receipt.dispatched ?? receipt.accepted ?? receipt.captured;
    if (receipt.inputTurnId != null && input.origin?.kind === "gui" && !input.coordination) {
      if (receipt.userMessageSeq !== null && threadFullIndexes?.has(receipt.userMessageSeq)) return true;
      const owner = receipt.turnId ? children?.find(({ inboundTurnIds }) => inboundTurnIds.includes(receipt.turnId!)) : undefined;
      if (owner) return owner === child;
      // 実行中の開始受付情報が、スレッドのインデックスより先に到着する場合がある。
      // 一致する WithMate Turn だけを使い、予約行が以前属していたフレームは使わない。
      if (receipt.turnId === currentTurnId && entry) {
        const startFrame = receiptFrame(entry);
        if (startFrame !== undefined) return startFrame === null ? !child
          : !!child && conversationPeerKey(startFrame) === conversationPeerKey(child.target);
        return entry.userMessageSeq !== null && threadFullIndexes?.has(entry.userMessageSeq);
      }
      return false;
    }
    const target = receiptFrame(receipt);
    const owner = target ? children?.find((candidate) => conversationPeerKey(candidate.target) === conversationPeerKey(target)) : undefined;
    return receipt.userMessageSeq === null || (receipt.inputTurnId == null || input.coordination?.operation === "answer") && target !== undefined
      ? owner === child : threadFullIndexes?.has(receipt.userMessageSeq);
  }), [allQueue.receipts, threadFullIndexes, receiptFrame, children, child, currentTurnId, entry]);
  const queue = frame ? { ...allQueue, receipts: threadReceipts } : allQueue;
  const presentedHistory = useRef<{ owner: string; messages: typeof incomingTailMessages }>({ owner: "", messages: [] });
  const firstUnboundSeq = (candidates: typeof submissions) => candidates.reduce((boundary, submission) => {
    const receipt = allQueue.receipts.find((receipt) => receipt.requestId === submission.requestId);
    return (!submission.error || submission.uncertain) && receipt?.userMessageSeq == null
      ? Math.min(boundary, submission.historyMessageCount) : boundary;
  }, Infinity);
  const unboundBoundary = firstUnboundSeq(submissions);
  const isUnjoined = (seq: number, boundary: number) => seq >= boundary && !allQueue.receipts.some((receipt) => receipt.userMessageSeq === seq);
  const unjoinedUser = canonicalStartSeqs.find((seq) => isUnjoined(seq, unboundBoundary));
  // 正本の履歴と対応する受付情報は、一度の表示の引き継ぎとして扱い、別々に挿入しない。
  // 履歴取得後の受付情報の読み取りでは、実行中の質問への回答など、別の入力も確認する。
  const isHistoryHandoffPending = unjoinedUser !== undefined && !queue.historyReconciled;
  const tailMessages = isHistoryHandoffPending
    ? presentedHistory.current.owner === pageOwner ? presentedHistory.current.messages
      : incomingTailMessages.filter((message, index) => getMessageHistoryIndex(message, index) < unjoinedUser)
    : incomingTailMessages;
  presentedHistory.current = { owner: pageOwner, messages: tailMessages };
  useEffect(() => {
    const consumed = submissions.filter((submission) => {
      const receipt = allQueue.receipts.find((receipt) => receipt.requestId === submission.requestId);
      const terminal = receipt && receipt.state !== "queued" && receipt.state !== "starting" && receipt.state !== "running";
      const hasResponse = receipt?.state !== "completed" || tailMessages.some((message, index) => message.role === "assistant" && getMessageHistoryIndex(message, index) > receipt.userMessageSeq!);
      return terminal && (hasResponse && receipt.userMessageSeq !== null && canonicalUserSeqs.includes(receipt.userMessageSeq)
        || receipt.state === "canceled" && receipt.userMessageSeq === null);
    });
    if (consumed.length) submissionStore.forget(consumed.map((submission) => submission.requestId));
  }, [submissions, allQueue.receipts, canonicalUserSeqs, tailMessages, submissionStore]);
  const queueComposerOwner = useMemo(() => ({ kind: messageSourceKind === "auxiliary" ? "auxiliary" as const : "main" as const, id: sessionId }), [messageSourceKind, sessionId]);
  const subscribeFreeze = useCallback((listener: () => void) => composerRegistry.subscribe(queueComposerOwner, listener), [composerRegistry, queueComposerOwner]);
  const readFreeze = useCallback(() => composerRegistry.isFrozen, [composerRegistry]);
  const queueActionsFrozen = useSyncExternalStore(subscribeFreeze, readFreeze, readFreeze);
  const scopedBoundary = firstUnboundSeq(visibleSubmissions);
  // 対象ページと親の履歴末尾は別々に届く。正確な保存済み入力と受付情報を
  // 読み取りで対応付けられるまでは、既存の予約行を残す。
  const pendingScopedSeq = !frame || isBrowsing || queue.historyReconciled ? undefined : scopedMessages.find((message, index) => {
    const seq = getMessageHistoryIndex(message, index);
    return message.role === "user" && !message.turnInput && threadFullIndexes?.has(seq) && isUnjoined(seq, scopedBoundary);
  })?.historyIndex;
  const messages = useMemo(() => {
    if (pageIndexes) return pendingScopedSeq === undefined ? scopedMessages
      : scopedMessages.filter((message, index) => {
        const seq = getMessageHistoryIndex(message, index);
        // 他の会話に属する送信元位置は送信カードにだけ使い、入力行を重複して表示しない。
        return seq < pendingScopedSeq || !threadFullIndexes?.has(seq);
      });
    // All ビューの以前のページを復元している間、その履歴末尾を閲覧位置のアンカーにはできない。
    if (isBrowsing) return currentPage?.messages ?? (showAllThreads ? EMPTY_MESSAGES : tailMessages);
    return tailMessages;
  }, [pageIndexes, currentPage, isBrowsing, showAllThreads, tailMessages, pendingScopedSeq, scopedMessages, threadFullIndexes]);
  const displayedHistory = useRef(messages);
  displayedHistory.current = messages;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const refresh = useCallback(() => {
    if (mounted.current && displayedId.current === sessionId) rerender((revision) => revision + 1);
  }, [sessionId]);
  const loadPage = useCallback(async (startIndex?: number, direction?: ConversationPageDirection,
    exact?: { seq: number; isCurrent: () => boolean }): Promise<number | undefined> => {
    if (!api?.getConversationPage) return;
    requestedPageStart.current = startIndex;
    requestedPageDirection.current = direction;
    const revision = ++pageRevision.current;
    inFlightPage.current = revision;
    const mutationRevision = bookmarkRevision.current;
    const owner = pageOwner;
    const scoped = currentThreadIndexes.current;
    let request: ConversationPageRequest | undefined = startIndex === undefined ? undefined : { startIndex };
    if (scoped) {
      const ordinal = startIndex === undefined ? Math.max(0, scoped.length - CONVERSATION_PAGE_SIZE)
        : scoped.findIndex((index) => index >= startIndex);
      const indexes = ordinal >= 0 ? scoped.slice(ordinal, ordinal + CONVERSATION_PAGE_SIZE) : [];
      request = { messageIndexes: indexes };
    }
    setPageLoading(true);
    setPageError("");
    try {
      const page = await api.getConversationPage(sessionId, request);
      if (!mounted.current || activePageOwner.current !== owner || revision !== pageRevision.current) return;
      if (!page || page.sessionId !== sessionId || (session?.incarnationId && page.incarnationId !== session.incarnationId)) throw new Error("Conversation Is No Longer Available");
      if (exact && (!exact.isCurrent() || !page.messages.some((message) => message.historyIndex === exact.seq))) return;
      if (request?.messageIndexes?.some((index) =>
        !page.messages.some((message) => message.historyIndex === index))) throw new Error("Some saved messages are no longer available.");
      if (mutationRevision !== bookmarkRevision.current) return loadPage(startIndex, direction, exact);
      const anchor = direction ? capturePageAnchor.current() : conversation.anchor;
      let nextPage = page;
      if (direction) {
        if (!displayEnabled.current || !anchor) return;
        const merged = new Map(displayedHistory.current
          .map((message, index) => [getMessageHistoryIndex(message, index), message] as const)
          .filter(([index]) => index < page.totalCount));
        page.messages.forEach((message, index) => merged.set(getMessageHistoryIndex(message, page.startIndex + index), message));
        const ordered = [...merged.entries()].sort(([left], [right]) => left - right);
        const retained = direction === "earlier" ? ordered.slice(0, CONVERSATION_WINDOW_SIZE) : ordered.slice(-CONVERSATION_WINDOW_SIZE);
        // リクエストの処理中に、閲覧者が移動方向を変えている場合がある。
        if (anchor.messageIndex === undefined || !retained.some(([index]) => index === anchor.messageIndex)) return;
        nextPage = { ...page, startIndex: retained[0][0], messages: retained.map(([, message]) => message) };
      }
      conversation.pageStart = startIndex === undefined ? undefined : nextPage.startIndex;
      setBrowsePage(startIndex === undefined && !scoped ? null : { owner, page: nextPage });
      if (anchor && (startIndex !== undefined || scoped)) conversation.messageJumpRequest = { sessionId, ...anchor, requestId: ++conversation.messageJumpRequestId };
      return revision;
    } catch (error) {
      if (activePageOwner.current === owner && revision === pageRevision.current) setPageError(error instanceof Error ? error.message : String(error));
    } finally {
      if (inFlightPage.current === revision) inFlightPage.current = null;
      if (activePageOwner.current === owner && revision === pageRevision.current) setPageLoading(false);
    }
  }, [api, conversation, pageOwner, session?.incarnationId, sessionId]);
  const pageAround = (messageIndex: number) => threadIndexes
    ? threadIndexes[Math.max(0, threadIndexes.indexOf(messageIndex) - Math.floor(CONVERSATION_PAGE_SIZE / 2))]
    : Math.max(0, messageIndex - Math.floor(CONVERSATION_PAGE_SIZE / 2));
  useEffect(() => {
    ++pageRevision.current;
    requestedPageStart.current = conversation.pageStart;
    requestedPageDirection.current = undefined;
    setBrowsePage((previous) => previous?.owner === pageOwner ? previous : null);
    setPageError("");
    setPageLoading(false);
    if (conversation.pageStart !== undefined) {
      const anchorIndex = conversation.anchor?.messageIndex;
      void loadPage(anchorIndex !== undefined ? pageAround(anchorIndex) : conversation.pageStart);
    } else if (frame) void loadPage();
    return () => { ++pageRevision.current; };
  }, [pageOwner]);
  const previousThreadPage = useRef({ owner: pageOwner, signature: threadPageSignature });
  useEffect(() => {
    const previous = previousThreadPage.current;
    previousThreadPage.current = { owner: pageOwner, signature: threadPageSignature };
    if (previous.owner === pageOwner && previous.signature !== threadPageSignature) {
      const index = conversation.anchor?.messageIndex;
      if (conversation.pageStart === undefined) void loadPage();
      else if (index !== undefined && threadIndexes?.includes(index)) void loadPage(pageAround(index));
      else if (conversation.pageStart !== undefined) void loadPage(conversation.pageStart);
    }
  }, [pageOwner, threadPageSignature]);
  useEffect(() => {
    if (!enabled && requestedPageDirection.current && inFlightPage.current === pageRevision.current) {
      ++pageRevision.current;
      setPageLoading(false);
    }
  }, [enabled]);
  useEffect(() => { setNavigatorFilter("all"); setNavigatorOffset(0); }, [pageOwner]);
  const navigator = useConversationQueryPages({
    identity: `${pageOwner}:${totalCount}:${session?.updatedAt ?? ""}:${navigatorRevision}:${navigatorFilter}:${frame?.messageIndexes.join(",") ?? ""}`,
    enabled: enabled && navigatorActive && session?.messageCount !== undefined,
    ordinal: navigatorOffset,
    read: api?.listConversationNavigator ? async (request) => {
      const outcome = await api.listConversationNavigator!(sessionId, { ...request, filter: navigatorFilter, ...(frame ? { messageIndexes: frame.messageIndexes } : {}) });
      return outcome.status === "complete" && session?.incarnationId && outcome.incarnationId !== session.incarnationId ? { status: "invalidated" } : outcome;
    } : undefined,
    cancel: api?.cancelConversationQuery,
  });
  useEffect(() => {
    if (!enabled) {
      delete conversation.liveBridgeBody;
      if (retainedBridges.current.owner === pageOwner) retainedBridges.current.projections = [];
    }
    return () => {
      if (!frame || !mounted.current || displayedId.current !== sessionId) delete conversation.liveBridgeBody;
    };
  }, [conversation, enabled, pageOwner, !!frame, sessionId]);
  useEffect(() => {
    if (liveRunOverride !== undefined) {
      liveState.liveRun = enabled ? liveRunOverride : null;
      refresh();
      return () => { liveState.liveRun = null; };
    }
    if (!session || !enabled || !api?.getLiveSessionRun || !api.subscribeLiveSessionRun) return;
    const unsubscribe = subscribeSessionLiveSelection({
      api: api as Required<Pick<ConversationMessageColumnApi, "getLiveSessionRun" | "subscribeLiveSessionRun">>,
      sessionId, select: (state) => state,
      onChange: (state) => {
        liveRunEventRevision.current += 1;
        liveState.liveRun = state;
        liveState.liveReadError = "";
        refresh();
      },
      onError: (error) => {
        liveState.liveReadError = `Live updates could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
        refresh();
      },
    });
    return () => { unsubscribe(); liveState.liveRun = null; };
  }, [api, enabled, liveRunOverride, liveState, sessionId, refresh, liveReadRevision]);

  const previousResponse = responsePresentation.current;
  // リクエスト欄が空では未紐付けの実行中 Turn を特定できない。本文やフォームを結び付ける前に受付情報を解決する。
  const isResponseBindingPending = !!api?.listSessionTurnQueue && !!(liveRun?.sessionTurnId || liveRun?.turnId)
    && previousResponse?.owner === pageOwner && !!previousResponse.requestId
    && !conversation.liveBridgeBody
    && queue.receipts.some((receipt) => !receipt.inputTurnId && (receipt.state === "starting"
      || receipt.requestId === previousResponse.requestId && (receipt.state === "queued" || receipt.state === "running")))
    && !queue.receipts.some((receipt) => !!liveRun?.sessionTurnId && receipt.turnId === liveRun.sessionTurnId && !receipt.inputTurnId);
  useEffect(() => { if (isResponseBindingPending) queue.reload(); }, [pageOwner, liveRun?.sessionTurnId, isResponseBindingPending, queue.reload]);
  const isCancelRequested = baseProps.pendingCancelSessionIds?.has(sessionId) ?? false;
  const sessionHasActiveRun = isCancelRequested || !!rawLiveRun?.cancellationState || (rawLiveRun?.runState !== undefined
    ? rawLiveRun.runState === "running" : session?.runState === "running" || !!rawLiveRun);
  const hasActiveRun = liveBelongsHere && sessionHasActiveRun;
  const assistantText = isResponseBindingPending ? "" : api || frame ? liveRun?.assistantText ?? "" : baseProps.liveRunAssistantText;
  const queuedResponseIndex = queue.receipts.reduce((index, receipt) => {
    const ownsRun = receipt.state === "running" && !receipt.inputTurnId
      || receipt.state === "completed" && !!receipt.inputTurnId && receipt.inputTurnId === liveRun?.turnId;
    return ownsRun && receipt.userMessageSeq !== null ? Math.max(index, receipt.userMessageSeq + 1) : index;
  }, 0);
  const tail = tailMessages.at(-1);
  if (!liveRun) liveResponseOwner.current = null;
  else if (!isResponseBindingPending && liveRun.runState === "running" && api?.listSessionTurnQueue) {
    if (liveResponseOwner.current?.owner !== pageOwner || liveResponseOwner.current.turnId !== liveRun.turnId) {
      // 新runは保存済み応答を再利用しない。user未着なら次のuserと応答の位置を開始時に確保する。
      liveResponseOwner.current = {
        owner: pageOwner, turnId: liveRun.turnId,
        messageIndex: Math.max(
          tail ? getMessageHistoryIndex(tail, tailMessages.length - 1) + (tail.role === "assistant" ? 2 : 1) : 1,
          conversation.bridge && conversation.liveBridgeBody && conversation.liveBridgeBody.turnId !== liveRun.turnId ? conversation.bridge.messageIndex + 2 : 0,
        ),
      };
    }
    liveResponseOwner.current.messageIndex = Math.max(
      liveResponseOwner.current.messageIndex,
      tail?.role === "user" ? getMessageHistoryIndex(tail, tailMessages.length - 1) + 1 : 0,
      queuedResponseIndex,
    );
  }
  const bridgeRun = liveRun?.sessionId === sessionId ? liveRun : undefined;
  const bridgeReceipt = bridgeRun?.queueReceipt?.incarnationId === queueIncarnationId ? bridgeRun.queueReceipt : undefined;
  const currentBridge = assistantText ? positionResponseBridge({
    sessionId,
    threadId: liveRun?.threadId ?? session?.threadId ?? null,
    ...(bridgeRun?.sessionTurnId ? { withMateTurnId: bridgeRun.sessionTurnId } : {}),
    ...(bridgeReceipt ? { userMessageSeq: bridgeReceipt.userMessageSeq } : {}),
    messageIndex: Math.max(
      liveResponseOwner.current?.owner === pageOwner ? liveResponseOwner.current.messageIndex : 0,
      resolveLiveAssistantMessageIndex(tailMessages, [], sessionId, sessionId, assistantText),
      queuedResponseIndex,
    ),
    text: assistantText,
  }, tailMessages) : null;
  if (retainedBridges.current.owner !== pageOwner) retainedBridges.current = { owner: pageOwner, projections: [] };
  if (!liveBelongsHere && rawLiveRun?.turnId && conversation.liveBridgeBody?.turnId === rawLiveRun.turnId) {
    conversation.bridge = null;
    delete conversation.liveBridgeBody;
  }
  const previousBridge = conversation.bridge;
  const previousBody = conversation.liveBridgeBody;
  const isDifferentTurn = currentBridge?.withMateTurnId && previousBridge?.withMateTurnId
    ? currentBridge.withMateTurnId !== previousBridge.withMateTurnId : previousBody?.turnId !== liveRun?.turnId;
  if (currentBridge && previousBridge && previousBody && isDifferentTurn
    && previousBridge.messageIndex !== currentBridge.messageIndex) {
    if (!retainedBridges.current.projections.some((candidate) => responseBridgeKey(candidate) === responseBridgeKey(previousBridge))) {
      retainedBridges.current.projections.push({ ...previousBridge, text: previousBody.text });
    }
  }
  const displayWindowStart = frame ? threadIndexes?.[0] ?? 0 : tailMessages.length ? getMessageHistoryIndex(tailMessages[0], 0) : 0;
  const positionedRetained = enabled ? retainedBridges.current.projections.map((candidate) => positionResponseBridge(candidate, tailMessages))
    .filter((candidate) => candidate.messageIndex >= displayWindowStart) : [];
  retainedBridges.current.projections = positionedRetained.filter((candidate) => !hasPersistedLiveAssistantMessage(messages, [], candidate, sessionId));
  if (currentBridge && enabled) {
    const { text, ...position } = currentBridge;
    conversation.bridge = position;
    conversation.liveBridgeBody = { text, turnId: liveRun?.turnId };
  }
  const remembered = conversation.bridge ? positionResponseBridge(conversation.bridge, tailMessages) : null;
  conversation.bridge = remembered;
  const cachedMessage = remembered ? messages.find((message, index) => message.role === "assistant" && getMessageHistoryIndex(message, index) === remembered.messageIndex) : undefined;
  // 会話全体の履歴末尾で保存を確認できても、相手別の選択ページがこの行を置き換えられるのは後になる場合がある。
  const cachedText = cachedMessage?.text || (enabled && remembered && remembered.messageIndex >= displayWindowStart ? conversation.liveBridgeBody?.text : undefined);
  const cachedBridge = remembered && cachedText ? { ...remembered, text: cachedText } : null;
  if (!currentBridge && remembered && (cachedMessage || remembered.messageIndex < displayWindowStart)) delete conversation.liveBridgeBody;
  const hasSavedBridge = hasPersistedLiveAssistantMessage(messages, [], cachedBridge, sessionId);
  const bridge = currentBridge ?? cachedBridge;
  const bridgeKey = bridge ? responseBridgeKey(bridge) : null;
  if (stableMessageKeys.current.owner !== pageOwner) stableMessageKeys.current = { owner: pageOwner, keys: new Map(), responses: new Map() };
  const stableKeys = stableMessageKeys.current.keys;
  const responseKeys = stableMessageKeys.current.responses;
  const previousPresentation = responsePresentation.current;
  if (enabled && previousPresentation?.owner === pageOwner && previousPresentation.requestId) responseKeys.set(previousPresentation.requestId, previousPresentation.key);
  const savedInputs = useMemo(() => savedQueuedInputSeqs(tailMessages), [tailMessages]);
  const confirmedInputs = useMemo(() => new Map(queue.receipts.flatMap((receipt) =>
    receipt.state === "completed" && receipt.inputTurnId && receipt.turnId && receipt.userMessageSeq !== null
      ? [[receipt.userMessageSeq, receipt.turnId] as const] : [])), [queue.receipts]);
  for (const receipt of queue.receipts) {
    const seq = receipt.userMessageSeq ?? savedInputs.get(receipt.id);
    if (seq !== undefined) stableKeys.set(seq, { role: "user", key: `turn-submission-${receipt.incarnationId}-${receipt.requestId}` });
  }
  for (const candidate of [...positionedRetained, ...(bridge && enabled ? [bridge] : [])]) {
    const key = responseBridgeKey(candidate);
    for (const [index, value] of stableKeys) {
      if (value.key === key && index !== candidate.messageIndex) stableKeys.delete(index);
    }
    stableKeys.set(candidate.messageIndex, { role: "assistant", key, withMateTurnId: candidate.withMateTurnId });
  }
  // 先に次の Turn が始まっても、保存済みの本文が届くまでは観測した各応答の識別情報を保持する。
  for (const receipt of queue.receipts) {
    const key = responseKeys.get(receipt.requestId);
    if (!key || receipt.state === "queued" || receipt.state === "starting" || receipt.state === "running" || receipt.inputTurnId
      || receipt.userMessageSeq === null || !receipt.turnId) continue;
    const responseSeq = turnResponsePosition(tailMessages, receipt.userMessageSeq, receipt.turnId, confirmedInputs);
    const savedResponseIndex = messages.findIndex((message, index) => message.role === "assistant"
      && getMessageHistoryIndex(message, index) === responseSeq);
    if (savedResponseIndex >= 0) {
      const historyIndex = getMessageHistoryIndex(messages[savedResponseIndex], savedResponseIndex);
      if (!stableKeys.has(historyIndex)) stableKeys.set(historyIndex, { role: "assistant", key, withMateTurnId: receipt.turnId });
    }
  }
  for (const requestId of responseKeys.keys()) if (!queue.receipts.some((receipt) => receipt.requestId === requestId)) responseKeys.delete(requestId);
  const responseKeySignature = [...responseKeys].map(([requestId, key]) => `${requestId}:${key}`).join(",");
  const loadedIndexes = new Set(messages.map((message, index) => getMessageHistoryIndex(message, index)));
  for (const index of stableKeys.keys()) if (!loadedIndexes.has(index) && !queue.receipts.some((receipt) => receipt.userMessageSeq === index)
    && index !== bridge?.messageIndex && !retainedBridges.current.projections.some((candidate) => candidate.messageIndex === index)) stableKeys.delete(index);
  const stableKeySignature = [...stableKeys].map(([index, value]) => `${index}:${value.role}:${value.key}:${value.withMateTurnId ?? ""}`).join(",");
  const historyProjection = useMemo(() => {
    const history = buildMessageListProjection(messages, [], sessionId, { primaryMessageSourceKind: messageSourceKind });
    return { ...history, keys: history.keys.map((key, index) => {
      const messageIndex = getMessageHistoryIndex(messages[index], index);
      const stable = stableKeys.get(messageIndex);
      return stable?.role === messages[index].role ? stable.key
        : conversation.anchor?.messageIndex === messageIndex ? conversation.anchor.key : key;
    }) };
  }, [messages, sessionId, messageSourceKind, stableKeySignature, conversation.anchor?.messageIndex, conversation.anchor?.key]);
  const keyedHistory = useMemo(() => projectLiveAssistantOnSessionHistory(
    historyProjection, messages, sessionId,
    hasSavedBridge ? bridge : null,
  ), [historyProjection, messages, sessionId, hasSavedBridge, bridgeKey, bridge?.messageIndex]);
  const currentLiveProjection = useMemo(() => hasSavedBridge
    ? keyedHistory
    : projectLiveAssistantOnSessionHistory(historyProjection, messages, sessionId, isBrowsing ? null : bridge),
  [historyProjection, keyedHistory, messages, sessionId, hasSavedBridge, bridgeKey, bridge?.messageIndex, bridge?.text, isBrowsing]);
  const retainedSignature = retainedBridges.current.projections.map((candidate) => `${candidate.messageIndex}:${candidate.withMateTurnId}:${candidate.text.length}`).join(",");
  const liveProjection = useMemo(() => {
    const candidates = isBrowsing ? [] : retainedBridges.current.projections;
    if (!candidates.length && !bridge) return currentLiveProjection;
    const allBridges = [...candidates, ...(bridge ? [bridge] : [])];
    const expanded = candidates.reduce((projection, candidate) => projectLiveAssistantOnSessionHistory(projection, messages, sessionId, candidate), currentLiveProjection);
    const rows = expanded.messages.map((message, index) => {
      const source = expanded.sources[index];
      const live = source.kind === "live-assistant" ? allBridges.find((candidate) => responseBridgeKey(candidate) === expanded.keys[index]) : undefined;
      return { message: live ? { ...message, historyIndex: live.messageIndex } : message, source, key: expanded.keys[index], group: expanded.groups[index], index: live?.messageIndex ?? (source.kind === "session" || source.kind === "auxiliary" ? source.messageIndex : index) };
    }).sort((left, right) => left.index - right.index);
    return { messages: rows.map((row) => row.message), sources: rows.map((row) => row.source), keys: rows.map((row) => row.key), groups: rows.map((row) => row.group) };
  }, [currentLiveProjection, retainedSignature, messages, sessionId, bridgeKey, bridge?.text, isBrowsing]);
  const bindingRequestId = isResponseBindingPending ? previousResponse?.requestId : undefined;
  const queuedProjection = useMemo(() => projectSessionTurnQueue(liveProjection, isBrowsing ? [] : queue.receipts, {
    sessionId, incarnationId: queueIncarnationId,
  }, {
    submissions: isBrowsing ? [] : visibleSubmissions,
    hasActiveRun: hasActiveRun && !isResponseBindingPending,
    sessionQueue: { receipts: allQueue.receipts, hasActiveRun: sessionHasActiveRun },
    bindingRequestId,
    responseKeys,
  }), [liveProjection, queue.receipts, isBrowsing, sessionId, queueIncarnationId, visibleSubmissions, hasActiveRun, isResponseBindingPending, allQueue.receipts, sessionHasActiveRun, bindingRequestId, responseKeySignature]);
  const projection = queuedProjection.projection;
  const savedReplySourceIndexes = useMemo(() => projection.sources.map((source) =>
    source.kind === "session" || source.kind === "auxiliary" ? source.messageIndex : undefined), [projection.sources]);
  const responseExecutionTurnIds = useMemo(() => projection.sources.map((source, index) => {
    if (source.kind === "live-assistant") return source.withMateTurnId;
    if (source.kind === "turn-queue" && projection.messages[index].role === "assistant" && !source.receipt.inputTurnId) return source.receipt.turnId ?? undefined;
    if ((source.kind === "session" || source.kind === "auxiliary") && projection.messages[index].role === "assistant") {
      const recorded = stableKeys.get(source.messageIndex);
      if (recorded?.key === projection.keys[index]) return recorded.withMateTurnId;
    }
    return undefined;
  }), [projection, stableKeySignature]);
  const searchTailMessages = useMemo(() => {
    const missingBridges = [...retainedBridges.current.projections, ...(bridge ? [bridge] : [])]
      .filter((candidate) => !hasPersistedLiveAssistantMessage(tailMessages, [], candidate, sessionId));
    const searchTail = missingBridges.length ? [...tailMessages.map((message, index) => ({ ...message, historyIndex: getMessageHistoryIndex(message, index) })), ...missingBridges.map((candidate) => ({ role: "assistant" as const, text: candidate.text, historyIndex: candidate.messageIndex }))]
      .sort((left, right) => left.historyIndex - right.historyIndex) : tailMessages;
    const searchProjection = projectSessionTurnQueue(buildMessageListProjection(searchTail, [], sessionId, {
      primaryMessageSourceKind: messageSourceKind,
    }), queue.receipts, { sessionId, incarnationId: queueIncarnationId }).projection;
    return searchProjection.messages.flatMap((message, index) => {
      const source = searchProjection.sources[index];
      if (threadFullIndexes && source.kind === "session" && !threadFullIndexes.has(source.messageIndex)
        && !missingBridges.some((candidate) => candidate.messageIndex === source.messageIndex)) return [];
      if (source.kind !== "turn-queue") return [message];
      return source.receipt.userMessageSeq === null ? [] : [{ ...message, historyIndex: source.receipt.userMessageSeq }];
    });
  }, [tailMessages, bridgeKey, bridge?.messageIndex, bridge?.text, retainedSignature, sessionId, messageSourceKind, queue.receipts, queueIncarnationId, threadFullIndexes]);
  const searchMessageIndexes = useMemo(() => projection.sources.map((source, index) => source.kind === "live-assistant" && bridge
    ? projection.messages[index].historyIndex ?? bridge.messageIndex : source.kind === "turn-queue"
    ? source.receipt.userMessageSeq ?? -1 : source.kind === "turn-submission" ? -1 : getMessageHistoryIndex(projection.messages[index], index)), [projection, bridgeKey]);
  // 受付済みuserも含めた表示順で、現在のprompt後の応答だけを待機表示の所有先にする。
  const responseIndex = bridgeKey ? projection.keys.indexOf(bridgeKey) : -1;
  const pendingResponseMessageKey = responseIndex >= 0
    && (bridge?.withMateTurnId && liveRun?.sessionTurnId ? bridge.withMateTurnId === liveRun.sessionTurnId
      : liveResponseOwner.current?.owner !== pageOwner || bridge?.messageIndex === liveResponseOwner.current.messageIndex)
    && !projection.messages.slice(responseIndex + 1, queuedProjection.waitingStart).some((message) => message.role === "user")
    ? bridgeKey : null;
  const responseSessionTurnId = hasActiveRun && !isResponseBindingPending ? liveRun?.sessionTurnId : undefined;
  const responseTurnId = hasActiveRun && !isResponseBindingPending ? liveRun?.turnId : undefined;
  const responseReceipt = queuedProjection.activeReceipt;
  const previous = responsePresentation.current;
  const receiptTurnId = responseReceipt?.turnId
    ?? (responseReceipt && previous?.owner === pageOwner && previous.requestId === responseReceipt.requestId ? previous.sessionTurnId : undefined);
  const responseRequestId = responseSessionTurnId && receiptTurnId && receiptTurnId !== responseSessionTurnId
    ? undefined : responseReceipt?.requestId ?? queuedProjection.pendingSubmission?.requestId;
  if (responseRequestId || responseSessionTurnId || responseTurnId) {
    const sameResponse = previous?.owner === pageOwner && (responseSessionTurnId && previous.sessionTurnId
      ? previous.sessionTurnId === responseSessionTurnId : responseTurnId && previous.turnId
        ? previous.turnId === responseTurnId : responseRequestId && previous.requestId === responseRequestId);
    responsePresentation.current = { owner: pageOwner, requestId: responseRequestId ?? (sameResponse ? previous.requestId : undefined),
      sessionTurnId: responseSessionTurnId ?? (sameResponse ? previous.sessionTurnId : undefined), turnId: responseTurnId ?? (sameResponse ? previous.turnId : undefined),
      key: sameResponse ? previous.key : `response-${pageOwner}-${responseRequestId ?? responseSessionTurnId ?? responseTurnId}` };
  }
  const responsePresentationKey = !isBrowsing && responsePresentation.current?.owner === pageOwner
    ? responsePresentation.current.key : !isBrowsing && hasActiveRun
      ? `response-${pageOwner}-${pendingResponseMessageKey && bridge ? bridge.messageIndex : tail ? getMessageHistoryIndex(tail, tailMessages.length - 1) + (tail.role === "assistant" ? 2 : 1) : 1}` : undefined;
  const presentationReceipt = queue.receipts.find((receipt) => receipt.requestId === responsePresentation.current?.requestId);
  const presentationResponseSeq = presentationReceipt?.userMessageSeq != null && presentationReceipt.turnId
    ? turnResponsePosition(tailMessages, presentationReceipt.userMessageSeq, presentationReceipt.turnId, confirmedInputs) : undefined;
  const presentationResponseIndex = pendingResponseMessageKey ? responseIndex : projection.sources.findIndex((source, index) => projection.messages[index].role === "assistant"
    && (source.kind === "turn-queue" && source.receipt.requestId === responsePresentation.current?.requestId
      || presentationResponseSeq !== undefined && (source.kind === "session" || source.kind === "auxiliary") && source.messageIndex === presentationResponseSeq));
  const presentationResponseKey = presentationResponseIndex >= 0 ? projection.keys[presentationResponseIndex] : null;
  const projectionScrollSignature = useMemo(
    () => `${projection.keys.join("\u001f")}:${projection.messages.map((message) => message.text.length).join(",")}`,
    [projection],
  );
  const messageScrollSignature = projectionScrollSignature
    + `:queue:${queue.receipts.map((receipt) => `${receipt.id}:${receipt.state}`).join(",")}`
    + `:submissions:${submissions.map((submission) => `${submission.requestId}:${submission.error}`).join(",")}`;
  const previousTargets = useRef<SessionMessageColumnProps["messageCollapseTargets"]>([]);
  const collapseTargets = useMemo(() => buildMessageCollapseTargets(keyedHistory.messages, keyedHistory.sources, keyedHistory.keys, previousTargets.current, session?.provider, queue.receipts)
    .filter((target) => !threadFullIndexes || threadFullIndexes.has(target.source.messageIndex)),
    [keyedHistory, session?.provider, queue.receipts, threadFullIndexes]);
  const columnCharacter = useMemo(() => session?.characterId ? {
    id: session.characterId,
    name: session.character ?? "",
    iconPath: session.characterIconPath ?? "",
    description: "",
    roleMarkdown: "",
    notesMarkdown: "",
    updatedAt: "",
    themeColors: session.characterThemeColors ?? baseProps.character.themeColors,
  } : baseProps.character, [
    baseProps.character,
    session?.character,
    session?.characterIconPath,
    session?.characterId,
    session?.characterThemeColors,
  ]);
  const paged = session?.messageCount !== undefined && !!api?.getConversationPage;
  const isHistoryCollapsed = (index: number) => conversation.collapseExceptions?.get(index) ?? conversation.defaultCollapsed ?? false;
  const collapsedMessageKeys = useMemo(() => paged
    ? new Set(collapseTargets.filter((target) => isHistoryCollapsed(target.source.messageIndex)).map((target) => target.key))
    : new Set(conversation.collapsedMessageKeys), [paged, collapseTargets, conversation.collapsedMessageKeys, conversation.defaultCollapsed, conversation.collapseExceptions]);
  previousTargets.current = collapseTargets;
  const following = useSessionMessageListFollowing({
    ownerKey: pageOwner,
    scrollSignature: messageScrollSignature,
    enabled: enabled && session !== null,
    savedScrollState: isBrowsing ? { scrollTop: conversation.scrollState?.scrollTop ?? 0, isFollowing: false } : conversation.scrollState,
    onScrollStateChange: (state) => { conversation.scrollState = state; },
  });
  const assistantMessageIndexes = useMemo(() => new Map(projection.sources.flatMap((source, index) =>
    (source.kind === "session" || source.kind === "auxiliary") && projection.messages[index].role === "assistant"
      ? [[source.messageIndex, index] as const] : [])), [projection.sources, projection.messages]);
  useEffect(() => {
    const list = following.messageListRef.current;
    if (!enabled || baseProps.isContentActive === false || !list || !api?.getUnreadSessionResult || !api.markSessionResultRead || !api.onSessionTurnUpdated) return;
    return observeSessionResultRead({
      api: { getUnreadSessionResult: api.getUnreadSessionResult, markSessionResultRead: api.markSessionResultRead, onSessionTurnUpdated: api.onSessionTurnUpdated },
      sessionId, list, assistantMessageIndexes,
    });
  }, [api, enabled, baseProps.isContentActive, following.messageListRef, sessionId, assistantMessageIndexes]);
  const anchorFrame = useRef<number | null>(null);
  const captureAnchor = useCallback(() => {
    const element = following.messageListRef.current;
    if (!enabled || !element || (!isBrowsing && conversation.scrollState?.isFollowing)) return;
    const listTop = element.getBoundingClientRect().top;
    const listBottom = listTop + element.clientHeight;
    for (const row of element.querySelectorAll<HTMLElement>(".session-message-virtual-row")) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= listTop || rect.top >= listBottom) continue;
      const key = row.dataset.conversationRowKey ?? projection.keys[Number(row.dataset.index)];
      if (key) {
        const rowIndex = projection.keys.indexOf(key);
        const source = projection.sources[rowIndex];
        const messageIndex = source?.kind === "session" || source?.kind === "auxiliary" ? source.messageIndex
          : source?.kind === "turn-queue" ? source.receipt.userMessageSeq ?? undefined : undefined;
        conversation.anchor = { key, offset: rect.top - listTop, messageIndex };
        return conversation.anchor;
      }
      break;
    }
  }, [conversation, enabled, isBrowsing, projection.keys, projection.sources]);
  capturePageAnchor.current = captureAnchor;
  const scheduleAnchorCapture = useCallback(() => {
    const element = following.messageListRef.current;
    if (!enabled || !element || anchorFrame.current !== null || (!isBrowsing && conversation.scrollState?.isFollowing)) return;
    anchorFrame.current = element.ownerDocument.defaultView!.requestAnimationFrame(() => {
      anchorFrame.current = null;
      captureAnchor();
      loadAtBoundary.current();
    });
  }, [captureAnchor, conversation, enabled, isBrowsing]);
  useLayoutEffect(() => {
    const element = following.messageListRef.current;
    return () => {
      if (anchorFrame.current !== null) {
        element?.ownerDocument.defaultView?.cancelAnimationFrame(anchorFrame.current);
        anchorFrame.current = null;
        captureAnchor();
      }
    };
  }, [captureAnchor]);
  useLayoutEffect(() => {
    if (enabled && conversation.anchor && !conversation.scrollState?.isFollowing) {
      conversation.messageJumpRequest = { sessionId, ...conversation.anchor, requestId: ++conversation.messageJumpRequestId };
      refresh();
    }
  }, [enabled, pageOwner]);
  const followLatest = useCallback(() => {
    ++pageRevision.current;
    requestedPageStart.current = undefined;
    requestedPageDirection.current = undefined;
    conversation.pageStart = undefined;
    conversation.anchor = undefined;
    conversation.scrollState = { scrollTop: 0, isFollowing: true };
    if (currentThreadIndexes.current) void loadPage();
    else setBrowsePage(null);
    setPageError("");
    setPageLoading(false);
    following.followMessageListLatest();
  }, [conversation, following.followMessageListLatest, loadPage]);
  const revealRequest = useCallback(() => {
    const list = following.messageListRef.current;
    const request = list?.querySelector<HTMLElement>(".live-approval-card[data-live-request-id]")
      ?? list?.querySelector<HTMLElement>(".live-elicitation-card[data-live-request-id]");
    if (!request) return false;
    // 追尾中は一覧が末尾に固定されるため、フォームへ移動する前に追尾を止める。
    const isInView = () => {
      const requestBounds = request.getBoundingClientRect();
      const listBounds = list!.getBoundingClientRect();
      return requestBounds.top >= listBounds.top - 1 && requestBounds.top <= listBounds.bottom - 1;
    };
    following.pauseMessageListFollowing();
    if (!isInView()) request.scrollIntoView({ block: "center" });
    return isInView();
  }, [following.messageListRef, following.pauseMessageListFollowing]);
  const onMessageListScroll = useCallback((_event: UIEvent<HTMLDivElement>) => {
    if (!enabled) return;
    following.handleMessageListScroll();
    if (isBrowsing && conversation.scrollState?.isFollowing) {
      const last = messages.at(-1);
      if (last && getMessageHistoryIndex(last, messages.length - 1) >= (threadIndexes?.at(-1) ?? (totalCount - 1))) {
        followLatest();
        return;
      }
      following.pauseMessageListFollowing();
      conversation.scrollState.isFollowing = false;
    }
    scheduleAnchorCapture();
  }, [following.handleMessageListScroll, following.pauseMessageListFollowing, scheduleAnchorCapture, enabled, isBrowsing, conversation, messages, totalCount, threadPageSignature, followLatest]);
  loadAtBoundary.current = () => {
    const element = following.messageListRef.current;
    if (!enabled || !paged || !element || pageLoading || pageError || inFlightPage.current === pageRevision.current
      || (!isBrowsing && conversation.scrollState?.isFollowing !== false) || !messages.length) return;
    const first = getMessageHistoryIndex(messages[0], 0);
    const end = getMessageHistoryIndex(messages[messages.length - 1], messages.length - 1) + 1;
    const firstOrdinal = threadIndexes?.indexOf(first) ?? first;
    const endOrdinal = threadIndexes ? threadIndexes.indexOf(end - 1) + 1 : end;
    if (element.scrollTop <= CONVERSATION_LOAD_MARGIN && firstOrdinal > 0) {
      following.pauseMessageListFollowing();
      const start = Math.max(0, firstOrdinal - CONVERSATION_PAGE_SIZE);
      void loadPage(threadIndexes?.[start] ?? start, "earlier");
    } else if (isBrowsing && element.scrollHeight - element.clientHeight - element.scrollTop <= CONVERSATION_LOAD_MARGIN && endOrdinal < (threadIndexes?.length ?? totalCount)) {
      following.pauseMessageListFollowing();
      void loadPage(threadIndexes?.[endOrdinal] ?? end, "later");
    }
  };
  const captureMessageListSend = useCallback((scrollToLatestOnSend: boolean) =>
    following.captureMessageListSend(scrollToLatestOnSend, followLatest), [followLatest, following.captureMessageListSend]);
  const onToggleMessageCollapse = (key: string) => {
    if (paged) {
      const target = collapseTargets.find((value) => value.key === key);
      if (!target) return;
      const index = target.source.messageIndex;
      const next = !isHistoryCollapsed(index);
      conversation.collapseExceptions = new Map(conversation.collapseExceptions);
      if (next === !!conversation.defaultCollapsed) conversation.collapseExceptions.delete(index);
      else conversation.collapseExceptions.set(index, next);
      refresh();
      return;
    }
    conversation.collapsedMessageKeys = new Set(conversation.collapsedMessageKeys);
    if (conversation.collapsedMessageKeys.has(key)) conversation.collapsedMessageKeys.delete(key);
    else conversation.collapsedMessageKeys.add(key);
    refresh();
  };
  const onToggleAllMessageCollapse = () => {
    if (paged) {
      conversation.defaultCollapsed = !(conversation.defaultCollapsed && !conversation.collapseExceptions?.size);
      conversation.collapseExceptions = new Map();
      refresh();
      return;
    }
    const keys = collapseTargets.map((target) => target.key);
    const allCollapsed = keys.every((key) => conversation.collapsedMessageKeys.has(key));
    conversation.collapsedMessageKeys = allCollapsed ? new Set() : new Set(keys);
    refresh();
  };
  const collapseKeys = collapseTargets.map((target) => target.key);
  const allMessagesCollapsed = paged ? totalCount > 0 && !!conversation.defaultCollapsed && !conversation.collapseExceptions?.size : collapseKeys.length > 0
    && collapseKeys.every((key) => conversation.collapsedMessageKeys.has(key));
  const loadedNavigatorEntries = useMemo(
    () => buildMessageNavigatorEntries(collapseTargets, new Map(
      collapseTargets
        .filter((target) => collapsedMessageKeys.has(target.key))
        .map((target) => [target.key, {
          sourceIdentity: target.sourceIdentity,
          role: target.role,
          text: target.text,
        } satisfies MessageCollapseStateEntry]),
    )),
    [collapseTargets, collapsedMessageKeys],
  );
  const messageNavigatorEntries = loadedNavigatorEntries;
  const tailNavigatorTargets = useMemo(() => {
    if (!paged || !api?.listConversationNavigator) return [];
    const boundary = Math.max(totalCount, navigator.messageCount ?? totalCount);
    const unsaved = tailMessages.flatMap((message, index) => {
      const historyIndex = getMessageHistoryIndex(message, index);
      return historyIndex >= boundary && (!frame || threadFullIndexes?.has(historyIndex)
        || historyIndex === bridge?.messageIndex || !child && !frame.children.some(({ messageIndexes }) => messageIndexes.includes(historyIndex)))
        ? [{ ...message, historyIndex }] : [];
    });
    const history = buildMessageListProjection(unsaved, [], sessionId, { primaryMessageSourceKind: messageSourceKind });
    const keyed = projectLiveAssistantOnSessionHistory(history, unsaved, sessionId,
      hasPersistedLiveAssistantMessage(unsaved, [], bridge, sessionId) ? bridge : null);
    return buildMessageCollapseTargets(keyed.messages, keyed.sources, keyed.keys, [], session?.provider, queue.receipts);
  }, [paged, api?.listConversationNavigator, tailMessages, totalCount, navigator.messageCount, sessionId, messageSourceKind, bridgeKey, session?.provider, queue.receipts, threadFullIndexes, child, frame]);
  const unsavedNavigatorTargets = tailNavigatorTargets.filter((target) =>
    target.source.messageIndex >= Math.max(totalCount, navigator.messageCount ?? totalCount)
    && (navigatorFilter === "all" || target.isBookmarked));
  const uniqueUnsavedTargets = [...new Map(unsavedNavigatorTargets.map((target) => [target.sourceIdentity, target])).values()];
  const navigatorTotalCount = navigator.messageCount === undefined ? 0 : navigator.totalCount + uniqueUnsavedTargets.length;
  const navigatorPageStart = Math.floor(Math.max(0, navigatorOffset) / CONVERSATION_QUERY_PAGE_SIZE) * CONVERSATION_QUERY_PAGE_SIZE;
  let mergedNavigatorOffset = Math.max(0, navigatorPageStart - CONVERSATION_QUERY_PAGE_SIZE);
  const mergedNavigatorItems: MessageNavigatorEntry[] = [];
  for (let ordinal = mergedNavigatorOffset; ordinal < Math.min(navigatorTotalCount, navigatorPageStart + 2 * CONVERSATION_QUERY_PAGE_SIZE); ordinal += 1) {
    const entry = ordinal < navigator.totalCount ? navigator.itemAt(ordinal) : undefined;
    const target = ordinal >= navigator.totalCount ? uniqueUnsavedTargets[ordinal - navigator.totalCount]
      : collapseTargets.find((value) => value.source.messageIndex === entry?.messageIndex);
    if (!entry && !target) {
      if (mergedNavigatorItems.length) break;
      mergedNavigatorOffset = ordinal + 1;
      continue;
    }
    mergedNavigatorItems.push({
      key: target?.key ?? `session-${sessionId}-${entry!.messageIndex}`,
      sourceKind: messageSourceKind, role: entry?.role ?? target!.role,
      preview: entry?.preview ?? target!.preview, accent: entry?.accent ?? target!.accent,
      isBookmarked: entry?.isBookmarked ?? target!.isBookmarked,
      speaker: entry?.speaker ?? target?.speaker,
      isCollapsed: isHistoryCollapsed(target?.source.messageIndex ?? entry!.messageIndex),
    });
  }
  const messageNavigatorPage: MessageNavigatorPage | undefined = paged && api?.listConversationNavigator ? {
    items: mergedNavigatorItems,
    offset: mergedNavigatorOffset, totalCount: navigatorTotalCount, filter: navigatorFilter,
    loading: navigator.loading, error: navigator.error,
    onFilterChange: (filter) => { setNavigatorFilter(filter); setNavigatorOffset(0); },
    onRequestRange: setNavigatorOffset, onRetry: navigator.retry,
  } : undefined;
  const onJumpToMessage = useCallback(async (key: string) => {
    following.pauseMessageListFollowing();
    if (isBrowsing && tailNavigatorTargets.some((target) => target.key === key && target.source.messageIndex >= totalCount)) {
      followLatest();
    } else if (!projection.keys.includes(key)) {
      const index = Number(key.slice(`session-${sessionId}-`.length));
      if (!Number.isInteger(index)) return;
      const revision = await loadPage(pageAround(index));
      if (revision === undefined || revision !== pageRevision.current || !mounted.current || activePageOwner.current !== pageOwner) return;
    } else {
      ++pageRevision.current;
      requestedPageStart.current = conversation.pageStart;
      requestedPageDirection.current = undefined;
      setPageLoading(false);
      setPageError("");
    }
    conversation.messageJumpRequestId += 1;
    conversation.messageJumpRequest = { sessionId, key, requestId: conversation.messageJumpRequestId };
    refresh();
  }, [conversation, refresh, sessionId, projection.keys, loadPage, pageOwner, isBrowsing, tailNavigatorTargets, totalCount, threadPageSignature, followLatest, following.pauseMessageListFollowing]);
  const onJumpToReply = useCallback(async (seq: number, sentKey: string | undefined, isCurrent: () => boolean) => {
    if (!displayEnabled.current || !isCurrent() || (threadIndexes && !threadIndexes.includes(seq))) return;
    // 一時的なライブ応答行やキューの行が同じ位置を占めることがある。返信元にできるのは保存済みの行だけ。
    if (!savedReplySourceIndexes.includes(seq)) {
      const revision = await loadPage(pageAround(seq), undefined, { seq, isCurrent });
      if (revision === undefined || revision !== pageRevision.current || activePageOwner.current !== pageOwner || !isCurrent()) return;
    } else {
      ++pageRevision.current;
      requestedPageStart.current = conversation.pageStart;
      requestedPageDirection.current = undefined;
      setPageLoading(false);
      setPageError("");
    }
    following.pauseMessageListFollowing();
    conversation.messageJumpRequest = { sessionId, key: "", requestId: ++conversation.messageJumpRequestId, reply: { seq, sentKey, isCurrent } };
    refresh();
  }, [conversation, refresh, sessionId, savedReplySourceIndexes, loadPage, pageOwner, threadPageSignature, following.pauseMessageListFollowing]);
  const replyOwnerKey = baseProps.inputReadContext && conversationPeerKey(baseProps.inputReadContext.target);
  const liveFrameId = showAllThreads ? ALL_MAIN_THREADS_ID : liveChild ? conversationPeerKey(liveChild.target) : undefined;
  const runningFrameId = enabled && rawLiveRun?.sessionId === sessionId && rawLiveRun.runState === "running" && currentTurnId && !awaitingLiveFrame
    ? liveChild ? conversationPeerKey(liveChild.target) : "" : undefined;
  useEffect(() => {
    onColumnControls?.({
      sessionId,
      messageCollapseTargetKeys: collapseTargets.map((target) => target.key),
      collapsedMessageKeys,
      allMessagesCollapsed,
      isMessageListFollowing: !isBrowsing && following.isMessageListFollowing,
      captureMessageListSend,
      onToggleAllMessageCollapse,
      followLatest,
      revealRequest,
      messageNavigatorEntries,
      messageNavigatorPage,
      onJumpToMessage,
      onJumpToReply,
      replyOwnerKey,
      captureReadingPosition: captureAnchor,
      frameId,
      liveFrameId,
      runningFrameId,
    });
  }, [allMessagesCollapsed, collapseTargets, collapsedMessageKeys, followLatest, revealRequest, captureMessageListSend, captureAnchor, following.isMessageListFollowing, messageNavigatorEntries, navigator.items, navigator.loading, navigator.error, navigatorFilter, navigatorOffset, onColumnControls, onJumpToMessage, onJumpToReply, replyOwnerKey, sessionId, frameId, liveFrameId, runningFrameId]);
  const reloadLiveRun = async (requestId: string, requestKind: "approval" | "elicitation", eventRevision: number) => {
    if (!api?.getLiveSessionRun) return;
    const latestLiveRun = await api.getLiveSessionRun(sessionId);
    if (!mounted.current || activePageOwner.current !== pageOwner || !displayEnabled.current) return;
    if (liveRunEventRevision.current !== eventRevision) return;
    liveState.liveRun = replaceLiveRunAfterResolvedRequest({ ownerSessionId: sessionId, state: liveState.liveRun }, {
      sessionId,
      requestId,
      requestKind,
      latestLiveRun,
    }).state;
  };
  const onResolveLiveApproval: SessionMessageColumnProps["onResolveLiveApproval"] = async (request, decision) => {
    if (!api?.resolveLiveApproval) return baseProps.onResolveLiveApproval(request, decision);
    if (conversation.approvalRequestId === request.requestId) return;
    conversation.approvalRequestId = request.requestId;
    conversation.approvalDecision = decision;
    conversation.error = "";
    refresh();
    const eventRevision = liveRunEventRevision.current;
    try {
      await api.resolveLiveApproval(sessionId, request.requestId, decision);
      await reloadLiveRun(request.requestId, "approval", eventRevision);
    } catch (error) {
      conversation.error = error instanceof Error ? error.message : String(error);
    } finally {
      conversation.approvalRequestId = null;
      conversation.approvalDecision = null;
      refresh();
    }
  };
  const hasActiveElicitation = (requestId: string) => {
    const run = liveState.liveRun;
    return (run?.elicitationRequests ?? (run?.elicitationRequest ? [run.elicitationRequest] : []))
      .some((request) => request.requestId === requestId);
  };
  const answeringRequestId = liveState.elicitationRequestId;
  const activeAnsweringRequestId = answeringRequestId && hasActiveElicitation(answeringRequestId) ? answeringRequestId : null;
  const onResolveLiveElicitation: SessionMessageColumnProps["onResolveLiveElicitation"] = async (request, response) => {
    if (!api?.resolveLiveElicitation) return baseProps.onResolveLiveElicitation(request, response);
    const pending = liveState.elicitationRequestId;
    if (!hasActiveElicitation(request.requestId) || pending && hasActiveElicitation(pending)) return;
    liveState.elicitationRequestId = request.requestId;
    liveState.elicitationAction = response.action;
    conversation.error = "";
    refresh();
    const eventRevision = liveRunEventRevision.current;
    try {
      await api.resolveLiveElicitation(sessionId, request.requestId, response);
      await reloadLiveRun(request.requestId, "elicitation", eventRevision);
    } catch (error) {
      if (hasActiveElicitation(request.requestId)) conversation.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (liveState.elicitationRequestId === request.requestId) {
        liveState.elicitationRequestId = null;
        liveState.elicitationAction = null;
      }
      refresh();
    }
  };
  const canSendQueuedInput = !!api?.sendQueuedSessionInput && !!liveRun?.turnId && liveRun.inputAvailable === true
    && !liveRun.cancellationState && !isCancelRequested && (session?.accessMode === undefined || session.accessMode === "active") && !queueActionsFrozen;
  const currentInputTurnId = liveRun?.turnId;
  const sendQueuedInput = useCallback((receipt: import("../../src-shared/session/session-turn-queue.js").SessionTurnQueueReceipt) => {
    if (canSendQueuedInput && !composerRegistry.isFrozen && currentInputTurnId) queue.sendInput(receipt, currentInputTurnId);
  }, [canSendQueuedInput, composerRegistry, currentInputTurnId, queue.sendInput]);
  const inputAction = canSendQueuedInput ? sendQueuedInput : undefined;
  const queuedTurnIds = useMemo(() => allQueue.queuedReceipts.map((receipt) => receipt.id), [allQueue.queuedReceipts]);
  const queueMoveFocus = useRef<{ owner: string; id: string; direction: string; element: Element } | null>(null);
  const moveQueuedTurn = useCallback((receipt: import("../../src-shared/session/session-turn-queue.js").SessionTurnQueueReceipt, direction: import("./conversation/use-session-turn-queue.js").SessionTurnQueueMoveDirection) => {
    if (!enabled || composerRegistry.isFrozen || queue.busyId !== null || (session?.accessMode !== undefined && session.accessMode !== "active")) return;
    const list = following.messageListRef.current;
    const element = list?.ownerDocument.activeElement;
    queueMoveFocus.current = element && list?.contains(element) ? { owner: pageOwner, id: receipt.id, direction, element } : null;
    queue.move(receipt, direction);
  }, [enabled, composerRegistry, session?.accessMode, queue.busyId, queue.move, following.messageListRef, pageOwner]);
  useLayoutEffect(() => {
    const pending = queueMoveFocus.current;
    if (!pending || queue.busyId !== null) return;
    queueMoveFocus.current = null;
    const list = following.messageListRef.current;
    if (!enabled || pending.owner !== pageOwner || !list || pending.element.isConnected) return;
    const active = list.ownerDocument.activeElement;
    if (active !== list && active !== list.ownerDocument.body) return;
    // 入力行がマウントされたままでも、キューの操作ボタンが消えたり無効になったりする場合がある。
    const status = Array.from(list.querySelectorAll<HTMLElement>("[data-queue-receipt-id]")).find((element) => element.dataset.queueReceiptId === pending.id);
    const button = status?.querySelector<HTMLButtonElement>(`button[data-queue-move="${pending.direction}"]`);
    (button && !button.disabled ? button : status ?? list).focus({ preventScroll: true });
  }, [enabled, pageOwner, queue.busyId, queuedTurnIds, following.messageListRef]);
  const moveAction = api?.reorderQueuedSessionTurns ? moveQueuedTurn : undefined;
  const queueReorderDisabled = !enabled || queueActionsFrozen || (session?.accessMode !== undefined && session.accessMode !== "active");
  const renderQueueTail = useMemo(() => !isBrowsing
    && (queuedProjection.tail.length > 0 || queuedProjection.localTail.length > 0 || liveState.liveReadError || queue.error || queue.announcement || queue.loading && queue.receipts.length > 0) ? (resolveImageSource: MarkdownImageResolver, markdownImageContext: MarkdownImageContext) => <>
    {queuedProjection.tail.map((receipt) => <SessionTurnQueueRow key={`${receipt.incarnationId}:${receipt.id}`} character={columnCharacter} receipt={receipt} inputReadContext={baseProps.inputReadContext} resolveImageSource={resolveImageSource} markdownImageContext={markdownImageContext} position={receipt.state === "queued" ? queuedTurnIds.indexOf(receipt.id) + 1 : undefined} queueSize={queuedTurnIds.length} busy={queue.busyId !== null} busyKind={queue.busyId === receipt.id ? queue.busyKind : null} onCancel={queue.cancel} onSendInput={inputAction} onMove={moveAction} moveDisabled={queueReorderDisabled} />)}
    {queuedProjection.localTail.map((submission) => <SessionTurnSubmissionRow key={submission.requestId} character={columnCharacter} submission={submission} resolveImageSource={resolveImageSource} markdownImageContext={markdownImageContext} />)}
    {queue.loading && queue.receipts.length > 0 ? <LoadingIndicator inline label="Loading queued turns" /> : null}
    <span className="visually-hidden" role="status">{queue.announcement}</span>
    {queue.error ? <div className="pending-run-error-note" role="alert">{queue.error}<button type="button" className="drawer-toggle compact secondary" onClick={queue.reload}>Retry Queue</button></div> : null}
    {liveState.liveReadError ? <div className="pending-run-error-note" role="alert">{liveState.liveReadError}<button type="button" className="drawer-toggle compact secondary" onClick={() => setLiveReadRevision((revision) => revision + 1)}>Retry Live Updates</button></div> : null}
  </> : undefined, [isBrowsing, api, columnCharacter, baseProps.inputReadContext, queuedProjection.tail, queuedProjection.localTail, queue.busyId, queue.busyKind, queue.cancel, queue.loading, queue.receipts.length, queue.error, queue.announcement, queue.reload, queuedTurnIds, moveAction, queueReorderDisabled, inputAction, liveState.liveReadError]);
  if (!session) return null;
  return {
    ...baseProps,
    sessionId,
    workspacePath: session.workspacePath ?? baseProps.workspacePath,
    elicitationDisabled: queueActionsFrozen || !enabled || (session.accessMode !== undefined && session.accessMode !== "active"),
    provider: session.provider,
    artifactDetailsEnabled: enabled,
    character: columnCharacter,
    liveWithMateTurnId: responseSessionTurnId,
    sentReadLiveTurnId: child && !isBrowsing ? rawLiveRun?.sessionTurnId : undefined,
    conversationChild: child,
    messages: projection.messages,
    messageKeys: projection.keys,
    turnQueueMetadata: queuedProjection.metadata,
    onCancelQueuedTurn: queue.cancel,
    onSendQueuedTurnInput: inputAction,
    onMoveQueuedTurn: moveAction,
    queuedTurnIds,
    queueReorderDisabled,
    queueBusyId: queue.busyId,
    queueBusyKind: queue.busyKind,
    renderQueueTail,
    pendingResponseMessageKey: pendingResponseMessageKey ?? presentationResponseKey,
    pendingResponseInsertIndex: queuedProjection.waitingStart,
    responsePresentationKey,
    responseExecutionTurnIds,
    streamingResponseMessageKey: hasActiveRun && !hasSavedBridge && !isCancelRequested && !liveRun?.cancellationState && !liveRun?.errorMessage
      && !liveRun?.approvalRequest && !liveRun?.elicitationRequest && !liveRun?.elicitationRequests?.length
      && (api || !baseProps.liveRunErrorMessage && !baseProps.liveApprovalRequest && !baseProps.liveElicitationRequest && !baseProps.liveElicitationRequests?.length) ? pendingResponseMessageKey : null,
    messageGroups: projection.groups,
    messageCollapseTargets: collapseTargets,
    collapsedMessageKeys,
    messageJumpRequest: conversation.messageJumpRequest,
    savedReplySourceIndexes,
    isRunning: !isBrowsing && hasActiveRun,
    responsePending: !isBrowsing && (isResponseBindingPending || !hasActiveRun && (!!queuedProjection.activeReceipt || !!queuedProjection.pendingSubmission && !queuedProjection.pendingSubmission.error)),
    submissionError: queuedProjection.pendingSubmission?.error ?? "",
    submissionUncertain: queuedProjection.pendingSubmission?.uncertain ?? false,
    pendingRunIndicatorAnnouncement: liveRun?.cancellationState
      ? liveRun.cancellationState === "terminating" ? "Waiting for the run to stop" : "Canceling run"
      : isCancelRequested ? "Canceling run" : isResponseBindingPending ? "Waiting for response" : messageSourceKind === "session" ? baseProps.pendingRunIndicatorAnnouncement : "Running",
    liveRunAssistantText: assistantText,
    hasLiveRunAssistantText: assistantText.length > 0,
    liveApprovalRequest: isResponseBindingPending ? null : api ? liveRun?.approvalRequest ?? null : baseProps.liveApprovalRequest,
    liveElicitationRequest: isResponseBindingPending ? null : api ? liveRun?.elicitationRequest ?? null : baseProps.liveElicitationRequest,
    liveElicitationRequests: isResponseBindingPending ? [] : api ? liveRun?.elicitationRequests : baseProps.liveElicitationRequests,
    liveElicitationRecords: isResponseBindingPending ? [] : api ? liveRun?.elicitationRecords : baseProps.liveElicitationRecords,
    elicitationInputAvailable: api ? liveRun?.inputAvailable === true && !liveRun.cancellationState && !isCancelRequested : baseProps.elicitationInputAvailable,
    approvalActionRequestId: conversation.approvalRequestId,
    approvalActionDecision: conversation.approvalDecision,
    elicitationActionRequestId: activeAnsweringRequestId,
    elicitationAction: activeAnsweringRequestId ? liveState.elicitationAction : null,
    liveRunErrorMessage: conversation.error || (api ? liveRun?.errorMessage ?? "" : baseProps.liveRunErrorMessage),
    pendingMessageGroupId: null,
    messageListRef: following.messageListRef,
    isMessageListFollowing: !isBrowsing && following.isMessageListFollowing,
    onBrowseMessages: following.pauseMessageListFollowing,
    onMessageListScroll,
    onMessageListLayout: scheduleAnchorCapture,
    onJumpToBottom: followLatest,
    conversationPaging: session.messageCount !== undefined && api?.getConversationPage ? {
      loading: pageLoading || (!!frame || showAllThreads && isBrowsing) && !currentPage && !pageError, error: pageError,
      onRetry: () => {
        if (inFlightPage.current === pageRevision.current) return;
        setNavigatorRevision((revision) => revision + 1);
        void loadPage(requestedPageStart.current, requestedPageDirection.current);
      },
    } : undefined,
    searchConversation: api?.searchConversation && session.messageCount !== undefined ? async (request) => {
      const outcome = await api.searchConversation!(sessionId, frame ? { ...request, messageIndexes: frame.messageIndexes } : request);
      return outcome.status === "complete" && session.incarnationId && outcome.incarnationId !== session.incarnationId ? { status: "invalidated" } : outcome;
    } : undefined,
    cancelConversationQuery: api?.cancelConversationQuery,
    conversationQueryOwner: pageOwner,
    conversationQueryRevision: `${totalCount}:${session.updatedAt ?? ""}:${frame?.messageIndexes.join(",") ?? ""}`,
    searchTailMessages: searchTailMessages,
    searchMessageIndexes,
    onLoadMessagePage: async (messageIndex) => {
      if (messageIndex >= totalCount) { followLatest(); return; }
      following.pauseMessageListFollowing();
      if (!messages.some((message, index) => getMessageHistoryIndex(message, index) === messageIndex)) {
        await loadPage(pageAround(messageIndex));
      } else {
        ++pageRevision.current;
        requestedPageStart.current = conversation.pageStart;
        requestedPageDirection.current = undefined;
        setPageLoading(false);
        setPageError("");
      }
    },
    onToggleMessageBookmark: baseProps.onToggleMessageBookmark ? async (target) => {
      ++bookmarkRevision.current;
      await baseProps.onToggleMessageBookmark!(target);
      ++bookmarkRevision.current;
      if (activePageOwner.current !== pageOwner) return;
      setBrowsePage((entry) => entry?.owner === pageOwner ? { owner: pageOwner, page: { ...entry.page,
        messages: entry.page.messages.map((message, index) => getMessageHistoryIndex(message, index) === target.source.messageIndex ? setMessageBookmarked(message, !target.isBookmarked) : message) } } : entry);
      setNavigatorRevision((revision) => revision + 1);
    } : undefined,
    onLoadArtifactDetail: baseProps.onLoadArtifactDetail
      ? (messageIndex) => loadProjectedMessageArtifact({
        source: projection.sources[messageIndex],
        loadSessionArtifact: baseProps.onLoadArtifactDetail!,
        loadAuxiliaryArtifact: api?.getSessionMessageArtifact
          ? (sessionId, sourceMessageIndex) => api.getSessionMessageArtifact!(sessionId, sourceMessageIndex)
          : undefined,
      })
      : undefined,
    onToggleMessageCollapse,
    onToggleAllMessageCollapse,
    onResolveLiveApproval,
    onResolveLiveElicitation,
  };
}

export type ConversationMessageColumnProps = UseConversationMessageColumnInput;

export function ConversationMessageColumn(props: ConversationMessageColumnProps) {
  const columnProps = useConversationMessageColumn(props);
  return columnProps ? (
    <div className="conversation-message-column" style={props.session?.characterThemeColors ? buildCharacterThemeStyle(props.session.characterThemeColors) : undefined}>
      <StableSessionMessageColumn key={props.messageSourceKind === "session" ? columnProps.conversationQueryOwner : undefined} {...columnProps} />
    </div>
  ) : null;
}

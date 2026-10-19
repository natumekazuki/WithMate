import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type UIEvent } from "react";

import { type SessionMessageColumnProps } from "./conversation/session-message-column.js";
import { useSessionMessageListFollowing } from "./shell/session-chat-layout-hooks.js";
import { StableSessionMessageColumn } from "./stable-session-message-column.js";
import { buildLiveAssistantProjectionKey, buildMessageListProjection, hasPersistedLiveAssistantMessage, loadProjectedMessageArtifact, projectLiveAssistantOnSessionHistory, resolveLiveAssistantMessageIndex, type LiveAssistantProjection } from "./auxiliary/auxiliary-session-message-projection.js";
import { buildMessageCollapseTargets, buildMessageNavigatorEntries, type MessageCollapseStateEntry, type MessageJumpRequest, type MessageNavigatorEntry } from "./conversation/session-message-collapse.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { Session } from "../../src-shared/session/session-state.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { buildCharacterThemeStyle } from "../ui/theme-utils.js";
import { replaceLiveRunAfterResolvedRequest } from "./runtime/session-live-run-state.js";
import { CONVERSATION_PAGE_SIZE, CONVERSATION_QUERY_PAGE_SIZE, getMessageHistoryIndex, type ConversationPage } from "../../src-shared/session/conversation-page.js";
import { getSessionIncarnationId, setMessageBookmarked } from "../../src-shared/session/session-state.js";
import { subscribeSessionLiveSelection } from "./runtime/session-window-live-ingress.js";
import { useConversationQueryPages } from "./conversation/use-conversation-query-pages.js";
import type { MessageNavigatorPage } from "./shell/session-context-pane.js";
import { useSessionTurnQueue } from "./conversation/use-session-turn-queue.js";
import { projectSessionTurnQueue } from "./conversation/session-turn-queue-projection.js";
import { SessionTurnQueueRow, SessionTurnSubmissionRow } from "./conversation/session-turn-queue-row.js";
import { SessionTurnSubmissions } from "./runtime/session-turn-submissions.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import type { MarkdownImageResolver } from "../ui/markdown/image-resource-loader.js";
import { composerControllerRegistry, type ComposerControllerRegistry } from "./composer-controller.js";

export type ConversationColumnSession = Pick<Session, "id"> & Partial<Pick<Session,
  "messages" | "messageCount" | "incarnationId" | "updatedAt" | "runState" | "threadId" | "characterId" | "character" | "characterIconPath" | "characterThemeColors" | "accessMode" | "provider"
>>;

export type ConversationMessageColumnApi = Partial<Pick<WithMateWindowApi,
  "subscribeLiveSessionRun" | "getLiveSessionRun" | "resolveLiveApproval" | "resolveLiveElicitation" | "getSessionMessageArtifact" | "getConversationPage" | "searchConversation" | "listConversationNavigator" | "cancelConversationQuery"
  | "listSessionTurnQueue" | "getSessionTurnQueueReceipt" | "listSessionTurnQueueReceipts" | "onSessionTurnQueueChanged" | "cancelQueuedSessionTurn" | "releaseInterruptedSessionTurn" | "sendQueuedSessionInput"
>>;

export type ConversationColumnCache = {
  incarnationId?: string;
  scrollState: { scrollTop: number; isFollowing: boolean } | null;
  collapsedMessageKeys: Set<string>;
  defaultCollapsed?: boolean;
  collapseExceptions?: Map<number, boolean>;
  liveRun: LiveSessionRunState | null;
  bridge: Omit<LiveAssistantProjection, "text"> | null;
  approvalRequestId: string | null;
  approvalDecision?: "approve" | "deny" | null;
  elicitationRequestId: string | null;
  elicitationAction?: SessionMessageColumnProps["elicitationAction"];
  error: string;
  liveReadError?: string;
  messageJumpRequest: MessageJumpRequest | null;
  messageJumpRequestId: number;
  pageStart?: number;
  anchor?: { key: string; offset: number };
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
  messageNavigatorEntries: readonly MessageNavigatorEntry[];
  messageNavigatorPage?: MessageNavigatorPage;
  onJumpToMessage: (key: string) => void;
};

export function useConversationMessageColumn({
  session, baseProps, messageSourceKind = "session", enabled, navigatorActive = false, api, liveRun: liveRunOverride, stateCache, onColumnControls, composerRegistry = composerControllerRegistry,
}: UseConversationMessageColumnInput): SessionMessageColumnProps | null {
  const localCache = useRef(new Map<string, ConversationColumnCache>());
  const caches = stateCache ?? localCache.current;
  const sessionId = session?.id ?? baseProps.sessionId;
  let cache = caches.get(sessionId);
  if (!cache || (cache.incarnationId !== undefined && cache.incarnationId !== (session?.incarnationId ?? ""))) {
    cache = { incarnationId: session?.incarnationId ?? "", scrollState: null, collapsedMessageKeys: new Set(), liveRun: null, bridge: null, approvalRequestId: null, elicitationRequestId: null, error: "", messageJumpRequest: null, messageJumpRequestId: 0 };
    caches.set(sessionId, cache);
  }
  const conversation = cache;
  const liveRunEventRevision = useRef(0);
  const [liveReadRevision, setLiveReadRevision] = useState(0);
  const [, rerender] = useState(0);
  const displayedId = useRef(sessionId);
  displayedId.current = sessionId;
  const mounted = useRef(true);
  const displayedBridge = useRef<{ owner: string; projection: LiveAssistantProjection } | null>(null);
  const liveResponseOwner = useRef<{ owner: string; turnId?: string; messageIndex: number } | null>(null);
  const [browsePage, setBrowsePage] = useState<ConversationPage | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState("");
  const [navigatorFilter, setNavigatorFilter] = useState<"all" | "bookmarks">("all");
  const [navigatorOffset, setNavigatorOffset] = useState(0);
  const [navigatorRevision, setNavigatorRevision] = useState(0);
  const pageRevision = useRef(0);
  const requestedPageStart = useRef<number | undefined>(undefined);
  const bookmarkRevision = useRef(0);
  const pageOwner = `${sessionId}:${session?.incarnationId ?? ""}`;
  const activePageOwner = useRef(pageOwner);
  activePageOwner.current = pageOwner;
  const displayEnabled = useRef(enabled);
  displayEnabled.current = enabled;
  const incomingTailMessages = session?.messages ?? baseProps.messages;
  const totalCount = session?.messageCount ?? incomingTailMessages.length;
  const queueIncarnationId = session ? getSessionIncarnationId(session) : "";
  const canonicalUserSeqs = useMemo(() => incomingTailMessages.flatMap((message, index) => message.role === "user" ? [getMessageHistoryIndex(message, index)] : []), [incomingTailMessages]);
  const emptySubmissions = useRef(new SessionTurnSubmissions());
  const submissionStore = baseProps.turnSubmissions ?? emptySubmissions.current;
  const submissionSnapshot = useSyncExternalStore(submissionStore.subscribe, submissionStore.getSnapshot, submissionStore.getSnapshot);
  const submissions = useMemo(() => submissionSnapshot.filter((submission) => submission.sessionId === sessionId && submission.incarnationId === queueIncarnationId), [submissionSnapshot, sessionId, queueIncarnationId]);
  const queue = useSessionTurnQueue(api, sessionId, queueIncarnationId, enabled, canonicalUserSeqs, submissions);
  const presentedHistory = useRef<{ owner: string; messages: typeof incomingTailMessages }>({ owner: "", messages: [] });
  const unboundBoundary = submissions.reduce((boundary, submission) => {
    const receipt = queue.receipts.find((receipt) => receipt.requestId === submission.requestId);
    return (!submission.error || submission.uncertain) && receipt?.userMessageSeq == null
      ? Math.min(boundary, submission.historyMessageCount) : boundary;
  }, Infinity);
  const unjoinedUser = canonicalUserSeqs.find((seq) => seq >= unboundBoundary && !queue.receipts.some((receipt) => receipt.userMessageSeq === seq));
  // Canonical history and its receipt are one display handoff, not two independent inserts.
  const isHistoryHandoffPending = unjoinedUser !== undefined;
  const tailMessages = isHistoryHandoffPending
    ? presentedHistory.current.owner === pageOwner ? presentedHistory.current.messages
      : incomingTailMessages.filter((message, index) => getMessageHistoryIndex(message, index) < unjoinedUser)
    : incomingTailMessages;
  presentedHistory.current = { owner: pageOwner, messages: tailMessages };
  useEffect(() => {
    const consumed = submissions.filter((submission) => {
      const receipt = queue.receipts.find((receipt) => receipt.requestId === submission.requestId);
      const terminal = receipt && receipt.state !== "queued" && receipt.state !== "starting" && receipt.state !== "running";
      const hasResponse = receipt?.state !== "completed" || tailMessages.some((message, index) => message.role === "assistant" && getMessageHistoryIndex(message, index) > receipt.userMessageSeq!);
      return terminal && (hasResponse && receipt.userMessageSeq !== null && canonicalUserSeqs.includes(receipt.userMessageSeq)
        || receipt.state === "canceled" && receipt.userMessageSeq === null);
    });
    if (consumed.length) submissionStore.forget(consumed.map((submission) => submission.requestId));
  }, [submissions, queue.receipts, canonicalUserSeqs, tailMessages, submissionStore]);
  const queueComposerOwner = useMemo(() => ({ kind: messageSourceKind === "auxiliary" ? "auxiliary" as const : "main" as const, id: sessionId }), [messageSourceKind, sessionId]);
  const subscribeFreeze = useCallback((listener: () => void) => composerRegistry.subscribe(queueComposerOwner, listener), [composerRegistry, queueComposerOwner]);
  const readFreeze = useCallback(() => composerRegistry.isFrozen, [composerRegistry]);
  const queueActionsFrozen = useSyncExternalStore(subscribeFreeze, readFreeze, readFreeze);
  const currentPage = browsePage?.sessionId === sessionId && (!session?.incarnationId || browsePage.incarnationId === session.incarnationId) ? browsePage : null;
  const isBrowsing = conversation.pageStart !== undefined;
  const messages = isBrowsing && currentPage ? currentPage.messages : tailMessages;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const refresh = useCallback(() => {
    if (mounted.current && displayedId.current === sessionId) rerender((revision) => revision + 1);
  }, [sessionId]);
  const loadPage = useCallback(async (startIndex?: number): Promise<number | undefined> => {
    if (!api?.getConversationPage) return;
    requestedPageStart.current = startIndex;
    const revision = ++pageRevision.current;
    const mutationRevision = bookmarkRevision.current;
    const owner = pageOwner;
    setPageLoading(true);
    setPageError("");
    try {
      const page = await api.getConversationPage(sessionId, startIndex === undefined ? undefined : { startIndex });
      if (!mounted.current || activePageOwner.current !== owner || revision !== pageRevision.current) return;
      if (!page || page.sessionId !== sessionId || (session?.incarnationId && page.incarnationId !== session.incarnationId)) throw new Error("Conversation Is No Longer Available");
      if (mutationRevision !== bookmarkRevision.current) return loadPage(startIndex);
      conversation.pageStart = startIndex === undefined ? undefined : page.startIndex;
      setBrowsePage(startIndex === undefined ? null : page);
      const anchor = conversation.anchor;
      if (anchor && startIndex !== undefined) conversation.messageJumpRequest = { sessionId, ...anchor, requestId: ++conversation.messageJumpRequestId };
      return revision;
    } catch (error) {
      if (activePageOwner.current === owner && revision === pageRevision.current) setPageError(error instanceof Error ? error.message : String(error));
    } finally {
      if (activePageOwner.current === owner && revision === pageRevision.current) setPageLoading(false);
    }
  }, [api, conversation, pageOwner, session?.incarnationId, sessionId]);
  useEffect(() => {
    ++pageRevision.current;
    requestedPageStart.current = conversation.pageStart;
    setBrowsePage(null);
    setPageError("");
    setPageLoading(false);
    if (conversation.pageStart !== undefined) void loadPage(conversation.pageStart);
    return () => { ++pageRevision.current; };
  }, [pageOwner]);
  useEffect(() => { setNavigatorFilter("all"); setNavigatorOffset(0); }, [pageOwner]);
  const navigator = useConversationQueryPages({
    identity: `${pageOwner}:${totalCount}:${session?.updatedAt ?? ""}:${navigatorRevision}:${navigatorFilter}`,
    enabled: enabled && navigatorActive && session?.messageCount !== undefined,
    ordinal: navigatorOffset,
    read: api?.listConversationNavigator ? async (request) => {
      const outcome = await api.listConversationNavigator!(sessionId, { ...request, filter: navigatorFilter });
      return outcome.status === "complete" && session?.incarnationId && outcome.incarnationId !== session.incarnationId ? { status: "invalidated" } : outcome;
    } : undefined,
    cancel: api?.cancelConversationQuery,
  });
  useEffect(() => {
    const releaseLiveText = () => {
      conversation.liveRun = null;
      if (displayedBridge.current?.owner === pageOwner) displayedBridge.current = null;
    };
    if (!enabled) releaseLiveText();
    return releaseLiveText;
  }, [conversation, enabled, pageOwner]);
  useEffect(() => {
    if (liveRunOverride !== undefined) {
      conversation.liveRun = enabled ? liveRunOverride : null;
      refresh();
      return;
    }
    if (!session || !enabled || !api?.getLiveSessionRun || !api.subscribeLiveSessionRun) return;
    return subscribeSessionLiveSelection({
      api: api as Required<Pick<ConversationMessageColumnApi, "getLiveSessionRun" | "subscribeLiveSessionRun">>,
      sessionId, select: (state) => state,
      onChange: (state) => {
        liveRunEventRevision.current += 1;
        conversation.liveRun = state;
        conversation.liveReadError = "";
        refresh();
      },
      onError: (error) => {
        conversation.liveReadError = `Live updates could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
        refresh();
      },
    });
  }, [api, enabled, liveRunOverride, pageOwner, sessionId, refresh, liveReadRevision]);

  const liveRun = liveRunOverride !== undefined ? liveRunOverride : conversation.liveRun;
  const hasActiveRun = liveRun?.runState !== undefined ? liveRun.runState === "running" : session?.runState === "running" || !!liveRun;
  const assistantText = api ? liveRun?.assistantText ?? "" : baseProps.liveRunAssistantText;
  const queuedResponseIndex = queue.receipts.reduce((index, receipt) => {
    const ownsRun = receipt.state === "running" && !receipt.inputTurnId
      || receipt.state === "completed" && !!receipt.inputTurnId && receipt.inputTurnId === liveRun?.turnId;
    return ownsRun && receipt.userMessageSeq !== null ? Math.max(index, receipt.userMessageSeq + 1) : index;
  }, 0);
  const tail = tailMessages.at(-1);
  if (!liveRun) liveResponseOwner.current = null;
  else if (liveRun.runState === "running" && api?.listSessionTurnQueue) {
    if (liveResponseOwner.current?.owner !== pageOwner || liveResponseOwner.current.turnId !== liveRun.turnId) {
      // 新runは保存済み応答を再利用しない。user未着なら次のuserと応答の位置を開始時に確保する。
      liveResponseOwner.current = {
        owner: pageOwner, turnId: liveRun.turnId,
        messageIndex: tail ? getMessageHistoryIndex(tail, tailMessages.length - 1) + (tail.role === "assistant" ? 2 : 1) : 1,
      };
    }
    liveResponseOwner.current.messageIndex = Math.max(
      liveResponseOwner.current.messageIndex,
      tail?.role === "user" ? getMessageHistoryIndex(tail, tailMessages.length - 1) + 1 : 0,
      queuedResponseIndex,
    );
  }
  const currentBridge = assistantText ? {
    sessionId,
    threadId: liveRun?.threadId ?? session?.threadId ?? null,
    messageIndex: Math.max(
      liveResponseOwner.current?.owner === pageOwner ? liveResponseOwner.current.messageIndex : 0,
      resolveLiveAssistantMessageIndex(tailMessages, [], sessionId, sessionId, assistantText),
      queuedResponseIndex,
    ),
    text: assistantText,
  } : null;
  if (currentBridge && enabled) {
    displayedBridge.current = { owner: pageOwner, projection: currentBridge };
    conversation.bridge = { sessionId: currentBridge.sessionId, threadId: currentBridge.threadId, messageIndex: currentBridge.messageIndex };
  }
  const cachedMessage = conversation.bridge ? messages.find((message, index) => message.role === "assistant" && getMessageHistoryIndex(message, index) === conversation.bridge!.messageIndex) : undefined;
  const cachedBridge = displayedBridge.current?.owner === pageOwner ? displayedBridge.current.projection
    : conversation.bridge && cachedMessage ? { ...conversation.bridge, text: cachedMessage.text } : null;
  const hasSavedBridge = hasPersistedLiveAssistantMessage(messages, [], cachedBridge, sessionId);
  const hasSubmissionBridge = cachedBridge && queue.receipts.some((receipt) => receipt.userMessageSeq !== null
    && receipt.userMessageSeq < cachedBridge.messageIndex && submissions.some((submission) => submission.requestId === receipt.requestId));
  const bridge = currentBridge ?? (
    cachedBridge && (hasSavedBridge || hasSubmissionBridge || isHistoryHandoffPending && cachedBridge.messageIndex > unboundBoundary || session?.runState === "running")
      ? cachedBridge : null
  );
  const historyProjection = useMemo(() => buildMessageListProjection(messages, [], sessionId, {
    primaryMessageSourceKind: messageSourceKind,
  }), [messages, sessionId, messageSourceKind]);
  const bridgeKey = bridge
    ? buildLiveAssistantProjectionKey(bridge.sessionId, bridge.threadId, bridge.messageIndex)
    : null;
  const keyedHistory = useMemo(() => projectLiveAssistantOnSessionHistory(
    historyProjection, messages, sessionId,
    hasSavedBridge ? bridge : null,
  ), [historyProjection, messages, sessionId, hasSavedBridge, bridgeKey]);
  const liveProjection = useMemo(() => hasSavedBridge
    ? keyedHistory
    : projectLiveAssistantOnSessionHistory(historyProjection, messages, sessionId, isBrowsing ? null : bridge),
  [historyProjection, keyedHistory, messages, sessionId, hasSavedBridge, bridgeKey, bridge?.text, isBrowsing]);
  const queuedProjection = useMemo(() => projectSessionTurnQueue(liveProjection, isBrowsing ? [] : queue.receipts, {
    sessionId, incarnationId: queueIncarnationId,
  }, { submissions: isBrowsing ? [] : submissions, hasActiveRun }), [liveProjection, queue.receipts, isBrowsing, sessionId, queueIncarnationId, submissions, hasActiveRun]);
  const projection = queuedProjection.projection;
  const searchTailMessages = useMemo(() => {
    const searchTail = bridge && !hasPersistedLiveAssistantMessage(tailMessages, [], bridge, sessionId)
      ? [...tailMessages, { role: "assistant" as const, text: bridge.text, historyIndex: bridge.messageIndex }]
      : tailMessages;
    const searchProjection = projectSessionTurnQueue(buildMessageListProjection(searchTail, [], sessionId, {
      primaryMessageSourceKind: messageSourceKind,
    }), queue.receipts, { sessionId, incarnationId: queueIncarnationId }).projection;
    return searchProjection.messages.flatMap((message, index) => {
      const source = searchProjection.sources[index];
      if (source.kind !== "turn-queue") return [message];
      return source.receipt.userMessageSeq === null ? [] : [{ ...message, historyIndex: source.receipt.userMessageSeq }];
    });
  }, [tailMessages, bridgeKey, bridge?.text, sessionId, messageSourceKind, queue.receipts, queueIncarnationId]);
  const searchMessageIndexes = useMemo(() => projection.sources.map((source, index) => source.kind === "live-assistant" && bridge
    ? bridge.messageIndex : source.kind === "turn-queue" && source.receipt.userMessageSeq !== null
    ? source.receipt.userMessageSeq : getMessageHistoryIndex(projection.messages[index], index)), [projection, bridgeKey]);
  // 受付済みuserも含めた表示順で、現在のprompt後の応答だけを待機表示の所有先にする。
  const responseIndex = bridgeKey ? projection.keys.indexOf(bridgeKey) : -1;
  const pendingResponseMessageKey = responseIndex >= 0
    && (liveResponseOwner.current?.owner !== pageOwner || bridge?.messageIndex === liveResponseOwner.current.messageIndex)
    && !projection.messages.slice(responseIndex + 1).some((message) => message.role === "user")
    ? bridgeKey : null;
  const historyScrollSignature = useMemo(
    () => `${keyedHistory.keys.join("\u001f")}:${keyedHistory.messages.map((message) => message.text.length).join(",")}`,
    [keyedHistory],
  );
  const messageScrollSignature = (projection.messages.length === keyedHistory.messages.length
    ? historyScrollSignature
    : `${historyScrollSignature}\u001f${bridgeKey}:${bridge?.text.length ?? 0}`)
    + `:queue:${queue.receipts.map((receipt) => `${receipt.id}:${receipt.state}`).join(",")}`
    + `:submissions:${submissions.map((submission) => `${submission.requestId}:${submission.error}`).join(",")}`;
  const previousTargets = useRef<SessionMessageColumnProps["messageCollapseTargets"]>([]);
  const collapseTargets = useMemo(() => buildMessageCollapseTargets(keyedHistory.messages, keyedHistory.sources, keyedHistory.keys, previousTargets.current),
    [keyedHistory]);
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
  const anchorFrame = useRef<number | null>(null);
  const captureAnchor = useCallback(() => {
    const element = following.messageListRef.current;
    if (!enabled || !element || (!isBrowsing && conversation.scrollState?.isFollowing)) return;
    const listTop = element.getBoundingClientRect().top;
    const listBottom = listTop + element.clientHeight;
    for (const row of element.querySelectorAll<HTMLElement>(".session-message-virtual-row")) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= listTop || rect.top >= listBottom) continue;
      const key = projection.keys[Number(row.dataset.index)];
      if (key) conversation.anchor = { key, offset: rect.top - listTop };
      break;
    }
  }, [conversation, enabled, isBrowsing, projection.keys]);
  const scheduleAnchorCapture = useCallback(() => {
    const element = following.messageListRef.current;
    if (!enabled || !element || anchorFrame.current !== null || (!isBrowsing && conversation.scrollState?.isFollowing)) return;
    anchorFrame.current = element.ownerDocument.defaultView!.requestAnimationFrame(() => {
      anchorFrame.current = null;
      captureAnchor();
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
  const onMessageListScroll = useCallback((_event: UIEvent<HTMLDivElement>) => {
    if (!enabled) return;
    following.handleMessageListScroll();
    scheduleAnchorCapture();
  }, [following.handleMessageListScroll, scheduleAnchorCapture, enabled]);
  const followLatest = useCallback(() => {
    ++pageRevision.current;
    requestedPageStart.current = undefined;
    conversation.pageStart = undefined;
    conversation.anchor = undefined;
    conversation.scrollState = { scrollTop: 0, isFollowing: true };
    setBrowsePage(null);
    setPageError("");
    setPageLoading(false);
    following.followMessageListLatest();
  }, [conversation, following.followMessageListLatest]);
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
      return historyIndex >= boundary ? [{ ...message, historyIndex }] : [];
    });
    const history = buildMessageListProjection(unsaved, [], sessionId, { primaryMessageSourceKind: messageSourceKind });
    const keyed = projectLiveAssistantOnSessionHistory(history, unsaved, sessionId,
      hasPersistedLiveAssistantMessage(unsaved, [], bridge, sessionId) ? bridge : null);
    return buildMessageCollapseTargets(keyed.messages, keyed.sources, keyed.keys);
  }, [paged, api?.listConversationNavigator, tailMessages, totalCount, navigator.messageCount, sessionId, messageSourceKind, bridgeKey]);
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
      const revision = await loadPage(Math.max(0, index - Math.floor(CONVERSATION_PAGE_SIZE / 2)));
      if (revision === undefined || revision !== pageRevision.current || !mounted.current || activePageOwner.current !== pageOwner) return;
    } else {
      ++pageRevision.current;
      requestedPageStart.current = conversation.pageStart;
      setPageLoading(false);
      setPageError("");
    }
    conversation.messageJumpRequestId += 1;
    conversation.messageJumpRequest = { sessionId, key, requestId: conversation.messageJumpRequestId };
    refresh();
  }, [conversation, refresh, sessionId, projection.keys, loadPage, pageOwner, isBrowsing, tailNavigatorTargets, totalCount, followLatest, following.pauseMessageListFollowing]);
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
      messageNavigatorEntries,
      messageNavigatorPage,
      onJumpToMessage,
    });
  }, [allMessagesCollapsed, collapseTargets, collapsedMessageKeys, followLatest, captureMessageListSend, following.isMessageListFollowing, messageNavigatorEntries, navigator.items, navigator.loading, navigator.error, navigatorFilter, navigatorOffset, onColumnControls, onJumpToMessage, sessionId]);
  const reloadLiveRun = async (requestId: string, requestKind: "approval" | "elicitation", eventRevision: number) => {
    if (!api?.getLiveSessionRun) return;
    const latestLiveRun = await api.getLiveSessionRun(sessionId);
    if (!mounted.current || activePageOwner.current !== pageOwner || !displayEnabled.current) return;
    if (liveRunEventRevision.current !== eventRevision) return;
    conversation.liveRun = replaceLiveRunAfterResolvedRequest({ ownerSessionId: sessionId, state: conversation.liveRun }, {
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
  const onResolveLiveElicitation: SessionMessageColumnProps["onResolveLiveElicitation"] = async (request, response) => {
    if (!api?.resolveLiveElicitation) return baseProps.onResolveLiveElicitation(request, response);
    if (conversation.elicitationRequestId === request.requestId) return;
    conversation.elicitationRequestId = request.requestId;
    conversation.elicitationAction = response.action;
    conversation.error = "";
    refresh();
    const eventRevision = liveRunEventRevision.current;
    try {
      await api.resolveLiveElicitation(sessionId, request.requestId, response);
      await reloadLiveRun(request.requestId, "elicitation", eventRevision);
    } catch (error) {
      conversation.error = error instanceof Error ? error.message : String(error);
    } finally {
      conversation.elicitationRequestId = null;
      conversation.elicitationAction = null;
      refresh();
    }
  };
  const canSendQueuedInput = !!api?.sendQueuedSessionInput && !!liveRun?.turnId && liveRun.inputAvailable === true
    && !liveRun.cancellationState && (session?.accessMode === undefined || session.accessMode === "active") && !queueActionsFrozen;
  const currentInputTurnId = liveRun?.turnId;
  const sendQueuedInput = useCallback((receipt: import("../../src-shared/session/session-turn-queue.js").SessionTurnQueueReceipt) => {
    if (canSendQueuedInput && !composerRegistry.isFrozen && currentInputTurnId) queue.sendInput(receipt, currentInputTurnId);
  }, [canSendQueuedInput, composerRegistry, currentInputTurnId, queue.sendInput]);
  const inputAction = canSendQueuedInput ? sendQueuedInput : undefined;
  const renderQueueTail = useMemo(() => !isBrowsing
    && (queuedProjection.tail.length > 0 || queuedProjection.localTail.length > 0 || conversation.liveReadError || queue.error || queue.loading && queue.receipts.length > 0) ? (resolveImageSource: MarkdownImageResolver) => <>
    {queuedProjection.tail.map((receipt, index) => <SessionTurnQueueRow key={`${receipt.incarnationId}:${receipt.id}`} receipt={receipt} resolveImageSource={resolveImageSource} position={receipt.state === "queued" ? queuedProjection.tail.slice(0, index + 1).filter((row) => row.state === "queued").length : undefined} busy={queue.busyId !== null} busyKind={queue.busyId === receipt.id ? queue.busyKind : null} onCancel={queue.cancel} onRelease={queue.release} onSendInput={inputAction} />)}
    {queuedProjection.localTail.map((submission) => <SessionTurnSubmissionRow key={submission.requestId} submission={submission} resolveImageSource={resolveImageSource} />)}
    {queue.loading && queue.receipts.length > 0 ? <LoadingIndicator inline label="Loading queued turns" /> : null}
    {queue.error ? <div className="pending-run-error-note" role="alert">{queue.error}<button type="button" className="drawer-toggle compact secondary" onClick={queue.reload}>Retry Queue</button></div> : null}
    {conversation.liveReadError ? <div className="pending-run-error-note" role="alert">{conversation.liveReadError}<button type="button" className="drawer-toggle compact secondary" onClick={() => setLiveReadRevision((revision) => revision + 1)}>Retry Live Updates</button></div> : null}
  </> : undefined, [isBrowsing, api, queuedProjection.tail, queuedProjection.localTail, queue.busyId, queue.busyKind, queue.cancel, queue.release, queue.loading, queue.receipts.length, queue.error, queue.reload, inputAction, conversation.liveReadError]);
  if (!session) return null;
  return {
    ...baseProps,
    sessionId,
    artifactDetailsEnabled: enabled,
    character: columnCharacter,
    messages: projection.messages,
    messageKeys: projection.keys,
    turnQueueMetadata: queuedProjection.metadata,
    onCancelQueuedTurn: queue.cancel,
    onReleaseInterruptedTurn: queue.release,
    queueBusyId: queue.busyId,
    queueBusyKind: queue.busyKind,
    renderQueueTail,
    pendingResponseMessageKey,
    messageGroups: projection.groups,
    messageCollapseTargets: collapseTargets,
    collapsedMessageKeys,
    messageJumpRequest: conversation.messageJumpRequest,
    isRunning: !isBrowsing && hasActiveRun,
    responsePending: !isBrowsing && !hasActiveRun && (!!queuedProjection.activeReceipt || !!queuedProjection.pendingSubmission && !queuedProjection.pendingSubmission.error),
    submissionError: queuedProjection.pendingSubmission?.error ?? "",
    pendingRunIndicatorAnnouncement: messageSourceKind === "session"
      ? baseProps.pendingRunIndicatorAnnouncement
      : "Running",
    liveRunAssistantText: assistantText,
    hasLiveRunAssistantText: assistantText.length > 0,
    liveApprovalRequest: api ? liveRun?.approvalRequest ?? null : baseProps.liveApprovalRequest,
    liveElicitationRequest: api ? liveRun?.elicitationRequest ?? null : baseProps.liveElicitationRequest,
    liveElicitationRequests: api ? liveRun?.elicitationRequests : baseProps.liveElicitationRequests,
    liveElicitationRecords: api ? liveRun?.elicitationRecords : baseProps.liveElicitationRecords,
    elicitationInputAvailable: api ? liveRun?.inputAvailable === true && !liveRun.cancellationState : baseProps.elicitationInputAvailable,
    approvalActionRequestId: conversation.approvalRequestId,
    approvalActionDecision: conversation.approvalDecision,
    elicitationActionRequestId: conversation.elicitationRequestId,
    elicitationAction: conversation.elicitationAction,
    liveRunErrorMessage: conversation.error || (api ? liveRun?.errorMessage ?? "" : baseProps.liveRunErrorMessage),
    pendingMessageGroupId: null,
    messageListRef: following.messageListRef,
    isMessageListFollowing: !isBrowsing && following.isMessageListFollowing,
    onBrowseMessages: following.pauseMessageListFollowing,
    onMessageListScroll,
    onMessageListLayout: scheduleAnchorCapture,
    onJumpToBottom: followLatest,
    conversationPaging: session.messageCount !== undefined && api?.getConversationPage ? {
      loading: pageLoading, error: pageError,
      onRetry: () => { setNavigatorRevision((revision) => revision + 1); void loadPage(requestedPageStart.current); },
    } : undefined,
    searchConversation: api?.searchConversation && session.messageCount !== undefined ? async (request) => {
      const outcome = await api.searchConversation!(sessionId, request);
      return outcome.status === "complete" && session.incarnationId && outcome.incarnationId !== session.incarnationId ? { status: "invalidated" } : outcome;
    } : undefined,
    cancelConversationQuery: api?.cancelConversationQuery,
    conversationQueryOwner: pageOwner,
    conversationQueryRevision: `${totalCount}:${session.updatedAt ?? ""}`,
    searchTailMessages: searchTailMessages,
    searchMessageIndexes,
    onLoadMessagePage: async (messageIndex) => {
      if (messageIndex >= totalCount) { followLatest(); return; }
      following.pauseMessageListFollowing();
      if (!messages.some((message, index) => getMessageHistoryIndex(message, index) === messageIndex)) {
        await loadPage(Math.max(0, messageIndex - 30));
      } else {
        ++pageRevision.current;
        requestedPageStart.current = conversation.pageStart;
        setPageLoading(false);
        setPageError("");
      }
    },
    onToggleMessageBookmark: baseProps.onToggleMessageBookmark ? async (target) => {
      ++bookmarkRevision.current;
      await baseProps.onToggleMessageBookmark!(target);
      ++bookmarkRevision.current;
      if (activePageOwner.current !== pageOwner) return;
      setBrowsePage((page) => page?.sessionId === sessionId ? { ...page, messages: page.messages.map((message, index) => getMessageHistoryIndex(message, index) === target.source.messageIndex ? setMessageBookmarked(message, !target.isBookmarked) : message) } : page);
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
      <StableSessionMessageColumn {...columnProps} />
    </div>
  ) : null;
}

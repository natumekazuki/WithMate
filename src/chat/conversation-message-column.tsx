import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from "react";

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
import { CONVERSATION_PAGE_SIZE, getMessageHistoryIndex, type ConversationPage } from "../../src-shared/session/conversation-page.js";
import { setMessageBookmarked } from "../../src-shared/session/session-state.js";

export type ConversationColumnSession = Pick<Session, "id"> & Partial<Pick<Session,
  "messages" | "messageCount" | "incarnationId" | "runState" | "threadId" | "characterId" | "character" | "characterIconPath" | "characterThemeColors"
>>;

export type ConversationMessageColumnApi = Partial<Pick<WithMateWindowApi,
  "subscribeLiveSessionRun" | "getLiveSessionRun" | "resolveLiveApproval" | "resolveLiveElicitation" | "getSessionMessageArtifact" | "getConversationPage" | "searchConversation" | "listConversationNavigator"
>>;

export type ConversationColumnCache = {
  incarnationId?: string;
  scrollState: { scrollTop: number; isFollowing: boolean } | null;
  collapsedMessageKeys: Set<string>;
  liveRun: LiveSessionRunState | null;
  bridge: Omit<LiveAssistantProjection, "text"> | null;
  approvalRequestId: string | null;
  elicitationRequestId: string | null;
  error: string;
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
};

export type ConversationColumnControls = {
  sessionId: string;
  messageCollapseTargetKeys: readonly string[];
  collapsedMessageKeys: ReadonlySet<string>;
  allMessagesCollapsed: boolean;
  isMessageListFollowing: boolean;
  handleMessageListSend: (scrollToLatestOnSend: boolean) => void;
  onToggleAllMessageCollapse: () => void;
  followLatest: () => void;
  messageNavigatorEntries: readonly MessageNavigatorEntry[];
  onJumpToMessage: (key: string) => void;
};

export function useConversationMessageColumn({
  session, baseProps, messageSourceKind = "session", enabled, navigatorActive = false, api, liveRun: liveRunOverride, stateCache, onColumnControls,
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
  const [, rerender] = useState(0);
  const displayedId = useRef(sessionId);
  displayedId.current = sessionId;
  const mounted = useRef(true);
  const displayedBridge = useRef<{ owner: string; projection: LiveAssistantProjection } | null>(null);
  const [browsePage, setBrowsePage] = useState<ConversationPage | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState("");
  const [navigatorEntries, setNavigatorEntries] = useState<readonly MessageNavigatorEntry[] | null>(null);
  const [navigatorRevision, setNavigatorRevision] = useState(0);
  const pageRevision = useRef(0);
  const requestedPageStart = useRef<number | undefined>(undefined);
  const bookmarkRevision = useRef(0);
  const pageOwner = `${sessionId}:${session?.incarnationId ?? ""}`;
  const activePageOwner = useRef(pageOwner);
  activePageOwner.current = pageOwner;
  const displayEnabled = useRef(enabled);
  displayEnabled.current = enabled;
  const tailMessages = session?.messages ?? baseProps.messages;
  const totalCount = session?.messageCount ?? tailMessages.length;
  const currentPage = browsePage?.sessionId === sessionId && (!session?.incarnationId || browsePage.incarnationId === session.incarnationId) ? browsePage : null;
  const isBrowsing = conversation.pageStart !== undefined;
  const messages = isBrowsing && currentPage ? currentPage.messages : tailMessages;
  const pageStart = messages[0] ? getMessageHistoryIndex(messages[0], 0) : 0;
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
  useEffect(() => {
    setNavigatorEntries(null);
    if (!enabled || !navigatorActive || session?.messageCount === undefined || !api?.listConversationNavigator) return;
    let active = true;
    void api.listConversationNavigator(sessionId).then((entries) => {
      if (!active) return;
      setNavigatorEntries(entries.map((entry) => ({ ...entry, key: `session-${sessionId}-${entry.messageIndex}`, sourceKind: messageSourceKind, isCollapsed: conversation.collapsedMessageKeys.has(`session-${sessionId}-${entry.messageIndex}`) })));
    }).catch(() => { if (active) setPageError("Could Not Load Messages Navigator"); });
    return () => { active = false; };
  }, [api, enabled, navigatorActive, pageOwner, totalCount, navigatorRevision]);
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
    let active = true;
    let receivedEvent = false;
    const unsubscribe = api.subscribeLiveSessionRun((id, state) => {
      if (!active || id !== sessionId) return;
      receivedEvent = true;
      liveRunEventRevision.current += 1;
      conversation.liveRun = state;
      refresh();
    });
    void api.getLiveSessionRun(sessionId).then((state) => {
      if (!active || receivedEvent) return;
      conversation.liveRun = state;
      refresh();
    }).catch((error: unknown) => {
      if (!active) return;
      conversation.error = error instanceof Error ? error.message : String(error);
      refresh();
    });
    return () => { active = false; unsubscribe(); };
  }, [api, enabled, liveRunOverride, pageOwner, sessionId, refresh]);

  const liveRun = liveRunOverride !== undefined ? liveRunOverride : conversation.liveRun;
  const assistantText = api ? liveRun?.assistantText ?? "" : baseProps.liveRunAssistantText;
  const currentBridge = assistantText ? {
    sessionId,
    threadId: liveRun?.threadId ?? session?.threadId ?? null,
    messageIndex: resolveLiveAssistantMessageIndex(tailMessages, [], sessionId, sessionId, assistantText),
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
  const bridge = currentBridge ?? (
    cachedBridge && (hasSavedBridge || session?.runState === "running")
      ? cachedBridge : null
  );
  const latestUserMessageIndex = useMemo(() => {
    for (let index = tailMessages.length - 1; index >= 0; index -= 1) {
      if (tailMessages[index].role === "user") return getMessageHistoryIndex(tailMessages[index], index);
    }
    return -1;
  }, [tailMessages]);
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
  const projection = useMemo(() => hasSavedBridge
    ? keyedHistory
    : projectLiveAssistantOnSessionHistory(historyProjection, messages, sessionId, isBrowsing ? null : bridge),
  [historyProjection, keyedHistory, messages, sessionId, hasSavedBridge, bridgeKey, bridge?.text, isBrowsing]);
  // 保存済みbridgeのkeyは終了後も維持するが、後続promptの待機表示には使わない。
  const pendingResponseMessageKey = bridge && latestUserMessageIndex <= bridge.messageIndex
    ? buildLiveAssistantProjectionKey(bridge.sessionId, bridge.threadId, bridge.messageIndex)
    : null;
  const historyScrollSignature = useMemo(
    () => `${keyedHistory.keys.join("\u001f")}:${keyedHistory.messages.map((message) => message.text.length).join(",")}`,
    [keyedHistory],
  );
  const messageScrollSignature = projection.messages.length === keyedHistory.messages.length
    ? historyScrollSignature
    : `${historyScrollSignature}\u001f${bridgeKey}:${bridge?.text.length ?? 0}`;
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
  const collapsedMessageKeys = useMemo(() => new Set(conversation.collapsedMessageKeys), [conversation.collapsedMessageKeys]);
  previousTargets.current = collapseTargets;
  const following = useSessionMessageListFollowing({
    ownerKey: pageOwner,
    scrollSignature: messageScrollSignature,
    enabled: enabled && session !== null && !isBrowsing,
    savedScrollState: conversation.scrollState,
    onScrollStateChange: (state) => { conversation.scrollState = state; },
  });
  const followingRef = useRef(following.isMessageListFollowing);
  followingRef.current = following.isMessageListFollowing;
  useLayoutEffect(() => {
    const element = following.messageListRef.current;
    return () => {
      if (element) conversation.scrollState = { scrollTop: element.scrollTop, isFollowing: followingRef.current };
    };
  }, [sessionId]);
  const onMessageListScroll = useCallback((_event: UIEvent<HTMLDivElement>) => {
    if (!isBrowsing) following.handleMessageListScroll();
    const element = following.messageListRef.current;
    const row = element ? Array.from(element.querySelectorAll<HTMLElement>(".session-message-virtual-row")).find((row) => row.getBoundingClientRect().bottom > element.getBoundingClientRect().top) : null;
    if (element && row) {
      const key = projection.keys[Number(row.dataset.index)];
      if (key) conversation.anchor = { key, offset: row.getBoundingClientRect().top - element.getBoundingClientRect().top };
    }
  }, [conversation, following.handleMessageListScroll, isBrowsing, projection.keys]);
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
  const handleMessageListSend = useCallback((scrollToLatestOnSend: boolean) => {
    if (scrollToLatestOnSend && isBrowsing) followLatest();
    following.handleMessageListSend(scrollToLatestOnSend);
  }, [isBrowsing, followLatest, following.handleMessageListSend]);
  const changePage = useCallback(async (startIndex: number) => {
    const anchor = conversation.anchor;
    const revision = await loadPage(startIndex);
    if (revision !== undefined && revision === pageRevision.current && anchor && mounted.current && activePageOwner.current === pageOwner) {
      conversation.messageJumpRequest = { sessionId, ...anchor, requestId: ++conversation.messageJumpRequestId };
      refresh();
    }
  }, [conversation, loadPage, pageOwner, refresh, sessionId]);
  const onToggleMessageCollapse = (key: string) => {
    conversation.collapsedMessageKeys = new Set(conversation.collapsedMessageKeys);
    if (conversation.collapsedMessageKeys.has(key)) conversation.collapsedMessageKeys.delete(key);
    else conversation.collapsedMessageKeys.add(key);
    refresh();
  };
  const onToggleAllMessageCollapse = () => {
    const keys = navigatorEntries?.map((entry) => collapseTargets.find((target) => target.source.messageIndex === Number(entry.key.slice(`session-${sessionId}-`.length)))?.key ?? entry.key) ?? collapseTargets.map((target) => target.key);
    const allCollapsed = keys.every((key) => conversation.collapsedMessageKeys.has(key));
    conversation.collapsedMessageKeys = allCollapsed ? new Set() : new Set(keys);
    refresh();
  };
  const collapseKeys = navigatorEntries?.map((entry) => collapseTargets.find((target) => target.source.messageIndex === Number(entry.key.slice(`session-${sessionId}-`.length)))?.key ?? entry.key) ?? collapseTargets.map((target) => target.key);
  const allMessagesCollapsed = collapseKeys.length > 0
    && collapseKeys.every((key) => conversation.collapsedMessageKeys.has(key));
  const loadedNavigatorEntries = useMemo(
    () => buildMessageNavigatorEntries(collapseTargets, new Map(
      collapseTargets
        .filter((target) => conversation.collapsedMessageKeys.has(target.key))
        .map((target) => [target.key, {
          sourceIdentity: target.sourceIdentity,
          role: target.role,
          text: target.text,
        } satisfies MessageCollapseStateEntry]),
    )),
    [collapseTargets, conversation.collapsedMessageKeys],
  );
  const messageNavigatorEntries = useMemo(() => {
    if (!navigatorEntries) return loadedNavigatorEntries;
    const entries = navigatorEntries.map((entry) => {
    const key = collapseTargets.find((target) => target.source.messageIndex === Number(entry.key.slice(`session-${sessionId}-`.length)))?.key ?? entry.key;
    const loaded = loadedNavigatorEntries.find((target) => target.key === key);
    return loaded ?? { ...entry, isCollapsed: conversation.collapsedMessageKeys.has(entry.key) };
    });
    return [...entries, ...loadedNavigatorEntries.filter((entry) => !entries.some((known) => known.key === entry.key))];
  }, [navigatorEntries, loadedNavigatorEntries, conversation.collapsedMessageKeys, collapseTargets, sessionId]);
  const onJumpToMessage = useCallback(async (key: string) => {
    if (!projection.keys.includes(key)) {
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
  }, [conversation, refresh, sessionId, projection.keys, loadPage, pageOwner]);
  useEffect(() => {
    onColumnControls?.({
      sessionId,
      messageCollapseTargetKeys: collapseTargets.map((target) => target.key),
      collapsedMessageKeys: new Set(conversation.collapsedMessageKeys),
      allMessagesCollapsed,
      isMessageListFollowing: !isBrowsing && following.isMessageListFollowing,
      handleMessageListSend,
      onToggleAllMessageCollapse,
      followLatest,
      messageNavigatorEntries,
      onJumpToMessage,
    });
  }, [allMessagesCollapsed, collapseTargets, conversation.collapsedMessageKeys, followLatest, handleMessageListSend, following.isMessageListFollowing, messageNavigatorEntries, onColumnControls, onJumpToMessage, sessionId]);
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
      refresh();
    }
  };
  const onResolveLiveElicitation: SessionMessageColumnProps["onResolveLiveElicitation"] = async (request, response) => {
    if (!api?.resolveLiveElicitation) return baseProps.onResolveLiveElicitation(request, response);
    if (conversation.elicitationRequestId === request.requestId) return;
    conversation.elicitationRequestId = request.requestId;
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
      refresh();
    }
  };
  if (!session) return null;
  return {
    ...baseProps,
    sessionId,
    character: columnCharacter,
    messages: projection.messages,
    messageKeys: projection.keys,
    pendingResponseMessageKey,
    messageGroups: projection.groups,
    messageCollapseTargets: collapseTargets,
    collapsedMessageKeys,
    messageJumpRequest: conversation.messageJumpRequest,
    isRunning: !isBrowsing && (session.runState === "running" || !!liveRun),
    pendingRunIndicatorAnnouncement: messageSourceKind === "session"
      ? baseProps.pendingRunIndicatorAnnouncement
      : "Running",
    liveRunAssistantText: assistantText,
    hasLiveRunAssistantText: assistantText.length > 0,
    liveApprovalRequest: api ? liveRun?.approvalRequest ?? null : baseProps.liveApprovalRequest,
    liveElicitationRequest: api ? liveRun?.elicitationRequest ?? null : baseProps.liveElicitationRequest,
    approvalActionRequestId: conversation.approvalRequestId,
    elicitationActionRequestId: conversation.elicitationRequestId,
    liveRunErrorMessage: conversation.error || (api ? liveRun?.errorMessage ?? "" : baseProps.liveRunErrorMessage),
    pendingMessageGroupId: null,
    messageListRef: following.messageListRef,
    isMessageListFollowing: !isBrowsing && following.isMessageListFollowing,
    onMessageListScroll,
    onJumpToBottom: followLatest,
    conversationPaging: session.messageCount !== undefined && api?.getConversationPage ? {
      startIndex: pageStart, endIndex: pageStart + messages.length, totalCount, loading: pageLoading, error: pageError,
      onEarlier: pageStart > 0 ? () => void changePage(Math.max(0, pageStart - 30)) : undefined,
      onLater: isBrowsing && pageStart + messages.length < totalCount ? () => void changePage(Math.min(Math.max(0, totalCount - CONVERSATION_PAGE_SIZE), pageStart + 30)) : undefined,
      onRetry: () => { setNavigatorRevision((revision) => revision + 1); void loadPage(requestedPageStart.current); },
    } : undefined,
    searchConversation: api?.searchConversation && session.messageCount !== undefined ? (query, mode) => api.searchConversation!(sessionId, { query, mode }) : undefined,
    onLoadMessagePage: async (messageIndex) => {
      if (!messages.some((message, index) => getMessageHistoryIndex(message, index) === messageIndex)) await loadPage(Math.max(0, messageIndex - 30));
    },
    onToggleMessageBookmark: baseProps.onToggleMessageBookmark ? async (target) => {
      ++bookmarkRevision.current;
      await baseProps.onToggleMessageBookmark!(target);
      ++bookmarkRevision.current;
      if (activePageOwner.current !== pageOwner) return;
      setBrowsePage((page) => page?.sessionId === sessionId ? { ...page, messages: page.messages.map((message, index) => getMessageHistoryIndex(message, index) === target.source.messageIndex ? setMessageBookmarked(message, !target.isBookmarked) : message) } : page);
      setNavigatorEntries((entries) => entries?.map((entry) => entry.key === `session-${sessionId}-${target.source.messageIndex}` ? { ...entry, isBookmarked: !target.isBookmarked } : entry) ?? null);
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

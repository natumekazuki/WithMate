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

export type ConversationColumnSession = Pick<Session, "id"> & Partial<Pick<Session,
  "messages" | "runState" | "threadId" | "characterId" | "character" | "characterIconPath" | "characterThemeColors"
>>;

export type ConversationMessageColumnApi = Partial<Pick<WithMateWindowApi,
  "subscribeLiveSessionRun" | "getLiveSessionRun" | "resolveLiveApproval" | "resolveLiveElicitation" | "getSessionMessageArtifact"
>>;

export type ConversationColumnCache = {
  scrollState: { scrollTop: number; isFollowing: boolean } | null;
  collapsedMessageKeys: Set<string>;
  liveRun: LiveSessionRunState | null;
  bridge: LiveAssistantProjection | null;
  approvalRequestId: string | null;
  elicitationRequestId: string | null;
  error: string;
  messageJumpRequest: MessageJumpRequest | null;
  messageJumpRequestId: number;
};

export type UseConversationMessageColumnInput = {
  session: ConversationColumnSession | null;
  baseProps: SessionMessageColumnProps;
  messageSourceKind?: "session" | "auxiliary";
  enabled: boolean;
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
  session, baseProps, messageSourceKind = "session", enabled, api, liveRun: liveRunOverride, stateCache, onColumnControls,
}: UseConversationMessageColumnInput): SessionMessageColumnProps | null {
  const localCache = useRef(new Map<string, ConversationColumnCache>());
  const caches = stateCache ?? localCache.current;
  const sessionId = session?.id ?? baseProps.sessionId;
  let cache = caches.get(sessionId);
  if (!cache) {
    cache = { scrollState: null, collapsedMessageKeys: new Set(), liveRun: null, bridge: null, approvalRequestId: null, elicitationRequestId: null, error: "", messageJumpRequest: null, messageJumpRequestId: 0 };
    caches.set(sessionId, cache);
  }
  const conversation = cache;
  const liveRunEventRevision = useRef(0);
  const [, rerender] = useState(0);
  const displayedId = useRef(sessionId);
  displayedId.current = sessionId;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const refresh = useCallback(() => {
    if (mounted.current && displayedId.current === sessionId) rerender((revision) => revision + 1);
  }, [sessionId]);
  useEffect(() => {
    if (liveRunOverride !== undefined) {
      conversation.liveRun = liveRunOverride;
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
  }, [api, enabled, liveRunOverride, sessionId, refresh]);

  const messages = session?.messages ?? baseProps.messages;
  const liveRun = liveRunOverride !== undefined ? liveRunOverride : conversation.liveRun;
  const assistantText = api ? liveRun?.assistantText ?? "" : baseProps.liveRunAssistantText;
  const currentBridge = assistantText ? {
    sessionId,
    threadId: liveRun?.threadId ?? session?.threadId ?? null,
    messageIndex: resolveLiveAssistantMessageIndex(messages, [], sessionId, sessionId, assistantText),
    text: assistantText,
  } : null;
  if (currentBridge) conversation.bridge = currentBridge;
  const hasSavedBridge = hasPersistedLiveAssistantMessage(messages, [], conversation.bridge, sessionId);
  const bridge = currentBridge ?? (
    conversation.bridge && (hasSavedBridge || session?.runState === "running")
      ? conversation.bridge : null
  );
  const latestUserMessageIndex = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "user") return index;
    }
    return -1;
  }, [messages]);
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
    : projectLiveAssistantOnSessionHistory(historyProjection, messages, sessionId, bridge),
  [historyProjection, keyedHistory, messages, sessionId, hasSavedBridge, bridgeKey, bridge?.text]);
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
    ownerKey: sessionId,
    scrollSignature: messageScrollSignature,
    enabled: enabled && session !== null,
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
    following.handleMessageListScroll();
  }, [following.handleMessageListScroll]);
  const onToggleMessageCollapse = (key: string) => {
    conversation.collapsedMessageKeys = new Set(conversation.collapsedMessageKeys);
    if (conversation.collapsedMessageKeys.has(key)) conversation.collapsedMessageKeys.delete(key);
    else conversation.collapsedMessageKeys.add(key);
    refresh();
  };
  const onToggleAllMessageCollapse = () => {
    const allCollapsed = collapseTargets.every((target) => conversation.collapsedMessageKeys.has(target.key));
    conversation.collapsedMessageKeys = allCollapsed ? new Set() : new Set(collapseTargets.map((target) => target.key));
    refresh();
  };
  const allMessagesCollapsed = collapseTargets.length > 0
    && collapseTargets.every((target) => conversation.collapsedMessageKeys.has(target.key));
  const messageNavigatorEntries = useMemo(
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
  const onJumpToMessage = useCallback((key: string) => {
    conversation.messageJumpRequestId += 1;
    conversation.messageJumpRequest = { sessionId, key, requestId: conversation.messageJumpRequestId };
    refresh();
  }, [conversation, refresh, sessionId]);
  useEffect(() => {
    onColumnControls?.({
      sessionId,
      messageCollapseTargetKeys: collapseTargets.map((target) => target.key),
      collapsedMessageKeys: new Set(conversation.collapsedMessageKeys),
      allMessagesCollapsed,
      isMessageListFollowing: following.isMessageListFollowing,
      handleMessageListSend: following.handleMessageListSend,
      onToggleAllMessageCollapse,
      followLatest: following.followMessageListLatest,
      messageNavigatorEntries,
      onJumpToMessage,
    });
  }, [allMessagesCollapsed, collapseTargets, conversation.collapsedMessageKeys, following.followMessageListLatest, following.handleMessageListSend, following.isMessageListFollowing, messageNavigatorEntries, onColumnControls, onJumpToMessage, sessionId]);
  const reloadLiveRun = async (requestId: string, requestKind: "approval" | "elicitation", eventRevision: number) => {
    if (!api?.getLiveSessionRun) return;
    const latestLiveRun = await api.getLiveSessionRun(sessionId);
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
    isRunning: session.runState === "running" || !!liveRun,
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
    isMessageListFollowing: following.isMessageListFollowing,
    onMessageListScroll,
    onJumpToBottom: following.followMessageListLatest,
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

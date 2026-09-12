import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from "react";

import { SessionMessageColumn, type SessionMessageColumnProps } from "../session-components.js";
import { useSessionMessageListFollowing } from "../session-chat-layout-hooks.js";
import { buildMessageListProjection, hasPersistedLiveAssistantMessage, resolveLiveAssistantMessageIndex, type LiveAssistantProjection } from "../auxiliary-session-message-projection.js";
import { buildMessageCollapseTargets } from "../session-message-collapse.js";
import { DEFAULT_CHARACTER_SESSION_COPY } from "../character-state.js";
import type { LiveSessionRunState } from "../runtime-state.js";
import type { Session } from "../session-state.js";
import type { WithMateWindowApi } from "../withmate-window-api.js";
import { buildCharacterThemeStyle } from "../theme-utils.js";

export type ConversationColumnSession = Pick<Session, "id"> & Partial<Pick<Session,
  "messages" | "runState" | "threadId" | "characterId" | "character" | "characterIconPath" | "characterThemeColors"
>>;

export type ConversationMessageColumnApi = Partial<Pick<WithMateWindowApi,
  "subscribeLiveSessionRun" | "getLiveSessionRun" | "resolveLiveApproval" | "resolveLiveElicitation"
>>;

export type ConversationColumnCache = {
  scrollState: { scrollTop: number; isFollowing: boolean } | null;
  collapsedMessageKeys: Set<string>;
  liveRun: LiveSessionRunState | null;
  bridge: LiveAssistantProjection | null;
  approvalRequestId: string | null;
  elicitationRequestId: string | null;
  error: string;
};

export type UseConversationMessageColumnInput = {
  session: ConversationColumnSession | null;
  baseProps: SessionMessageColumnProps;
  enabled: boolean;
  api?: ConversationMessageColumnApi;
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
};

export function useConversationMessageColumn({
  session, baseProps, enabled, api, stateCache, onColumnControls,
}: UseConversationMessageColumnInput): SessionMessageColumnProps | null {
  const localCache = useRef(new Map<string, ConversationColumnCache>());
  const caches = stateCache ?? localCache.current;
  const sessionId = session?.id ?? baseProps.sessionId;
  let cache = caches.get(sessionId);
  if (!cache) {
    cache = { scrollState: null, collapsedMessageKeys: new Set(), liveRun: null, bridge: null, approvalRequestId: null, elicitationRequestId: null, error: "" };
    caches.set(sessionId, cache);
  }
  const conversation = cache;
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
    if (!session || !enabled || !api?.getLiveSessionRun || !api.subscribeLiveSessionRun) return;
    let active = true;
    let receivedEvent = false;
    const unsubscribe = api.subscribeLiveSessionRun((id, state) => {
      if (!active || id !== sessionId) return;
      receivedEvent = true;
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
  }, [api, enabled, sessionId, refresh]);

  const messages = session?.messages ?? baseProps.messages;
  const liveRun = conversation.liveRun;
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
  const projection = useMemo(() => buildMessageListProjection(messages, [], sessionId, { liveAssistant: bridge }),
    [messages, sessionId, bridge?.threadId, bridge?.messageIndex, bridge?.text]);
  const previousTargets = useRef<SessionMessageColumnProps["messageCollapseTargets"]>([]);
  const collapseTargets = useMemo(() => buildMessageCollapseTargets(projection.messages, projection.sources, projection.keys, previousTargets.current),
    [projection]);
  previousTargets.current = collapseTargets;
  const following = useSessionMessageListFollowing({
    ownerKey: sessionId,
    scrollSignature: `${projection.keys.join("\u001f")}:${projection.messages.map((message) => message.text.length).join(",")}`,
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
    });
  }, [allMessagesCollapsed, collapseTargets, conversation.collapsedMessageKeys, following.followMessageListLatest, following.handleMessageListSend, following.isMessageListFollowing, onColumnControls, sessionId]);
  const reloadLiveRun = async () => {
    if (api?.getLiveSessionRun) conversation.liveRun = await api.getLiveSessionRun(sessionId);
  };
  const onResolveLiveApproval: SessionMessageColumnProps["onResolveLiveApproval"] = async (request, decision) => {
    if (!api?.resolveLiveApproval) return baseProps.onResolveLiveApproval(request, decision);
    if (conversation.approvalRequestId === request.requestId) return;
    conversation.approvalRequestId = request.requestId;
    conversation.error = "";
    refresh();
    try {
      await api.resolveLiveApproval(sessionId, request.requestId, decision);
      await reloadLiveRun();
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
    try {
      await api.resolveLiveElicitation(sessionId, request.requestId, response);
      await reloadLiveRun();
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
    character: session.characterId ? {
      id: session.characterId, name: session.character ?? "", iconPath: session.characterIconPath ?? "",
      description: "", roleMarkdown: "", notesMarkdown: "", updatedAt: "",
      themeColors: session.characterThemeColors ?? baseProps.character.themeColors,
      sessionCopy: DEFAULT_CHARACTER_SESSION_COPY,
    } : baseProps.character,
    messages: projection.messages,
    messageKeys: projection.keys,
    messageGroups: projection.groups,
    messageCollapseTargets: collapseTargets,
    collapsedMessageKeys: new Set(conversation.collapsedMessageKeys),
    messageJumpRequest: baseProps.messageJumpRequest?.sessionId === sessionId ? baseProps.messageJumpRequest : null,
    isRunning: session.runState === "running" || !!liveRun,
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
      <SessionMessageColumn {...columnProps} />
    </div>
  ) : null;
}

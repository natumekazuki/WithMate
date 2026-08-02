export type PreviewChatActivityState = {
  ownerSessionId: string | null;
  observedMessageCount: number;
  hasUnreadMessages: boolean;
};

export function endPreviewChatActivity(): PreviewChatActivityState {
  return {
    ownerSessionId: null,
    observedMessageCount: 0,
    hasUnreadMessages: false,
  };
}

export function beginPreviewChatActivity(
  ownerSessionId: string,
  messageCount: number,
): PreviewChatActivityState {
  return {
    ownerSessionId,
    observedMessageCount: messageCount,
    hasUnreadMessages: false,
  };
}

export function acknowledgePreviewChatMessageCount(
  state: PreviewChatActivityState,
  ownerSessionId: string,
  messageCount: number,
): PreviewChatActivityState {
  if (state.ownerSessionId !== ownerSessionId) {
    return beginPreviewChatActivity(ownerSessionId, messageCount);
  }

  return {
    ...state,
    observedMessageCount: messageCount,
  };
}

export function observePreviewChatMessageCount(
  state: PreviewChatActivityState,
  ownerSessionId: string,
  messageCount: number,
): PreviewChatActivityState {
  if (state.ownerSessionId !== ownerSessionId) {
    return beginPreviewChatActivity(ownerSessionId, messageCount);
  }

  return {
    ownerSessionId,
    observedMessageCount: messageCount,
    hasUnreadMessages: state.hasUnreadMessages || messageCount > state.observedMessageCount,
  };
}

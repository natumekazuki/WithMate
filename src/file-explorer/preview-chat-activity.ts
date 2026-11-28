/** プレビュー表示中に追跡する Session、比較元のメッセージ件数、未読の発生有無。 */
export type PreviewChatActivityState = {
  ownerSessionId: string | null;
  observedMessageCount: number;
  hasUnreadMessages: boolean;
};

/** プレビューを離れた時点で、所有元と件数・未読の追跡をすべて初期化する。 */
export function endPreviewChatActivity(): PreviewChatActivityState {
  return {
    ownerSessionId: null,
    observedMessageCount: 0,
    hasUnreadMessages: false,
  };
}

/** 現在の件数を比較元として追跡を始め、既存メッセージは未読とみなさない。 */
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

/** 同じ所有元なら未読フラグを変えず基準件数だけを更新し、別 Session なら追跡を開始し直す。 */
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

/** 同じ Session 内の件数増加を未読として記録し、一度立ったフラグは件数が減っても保つ。 */
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
    hasUnreadMessages:
      state.hasUnreadMessages || messageCount > state.observedMessageCount,
  };
}

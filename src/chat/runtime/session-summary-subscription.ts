import type { SessionSummaryInvalidation } from "../../../src-shared/session/session-state.js";

/** Session 要約の取得中、取得済み、取得失敗を区別する状態。 */
export type SessionSummariesLoadStatus = "loading" | "loaded" | "error";

/** Session の投影を読み直す契機となる変更通知を購読する API。 */
export type SessionSummaryInvalidationSubscriptionApi = {
  subscribeSessionInvalidation: (
    listener: (payload: SessionSummaryInvalidation) => void,
  ) => () => void;
};

/** 変更通知を購読し、停止した購読から遅れて届く通知は呼び出し元へ渡さない。 */
export function startSessionSummaryInvalidationSubscription(input: {
  api: SessionSummaryInvalidationSubscriptionApi | null;
  onInvalidation: (payload: SessionSummaryInvalidation) => void;
}): () => void {
  if (!input.api) {
    return () => undefined;
  }

  let active = true;
  const unsubscribe = input.api.subscribeSessionInvalidation((payload) => {
    if (active) {
      input.onInvalidation(payload);
    }
  });

  return () => {
    active = false;
    unsubscribe();
  };
}

/** 所有元に関係する詳細の無効化に絞って会話の再読み込みを通知する。 */
export function startConversationDetailSubscription(input: {
  api: Partial<SessionSummaryInvalidationSubscriptionApi> | null;
  ownerSessionId: string;
  onChange: () => void;
}): () => void {
  if (!input.api?.subscribeSessionInvalidation) return () => undefined;
  return startSessionSummaryInvalidationSubscription({
    api: {
      subscribeSessionInvalidation: input.api.subscribeSessionInvalidation.bind(
        input.api,
      ),
    },
    /** 要約だけの更新と、別 Session の個別更新では会話を読み直さない。 */
    onInvalidation: (payload) => {
      if (
        payload.detailChanged === false ||
        (payload.scope === "ids" &&
          !payload.sessionIds.includes(input.ownerSessionId))
      )
        return;
      input.onChange();
    },
  });
}

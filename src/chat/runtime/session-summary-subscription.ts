import type { SessionSummaryInvalidation } from "../../../src-shared/session/session-state.js";

export type SessionSummariesLoadStatus = "loading" | "loaded" | "error";

export type SessionSummaryInvalidationSubscriptionApi = {
  subscribeSessionInvalidation: (listener: (payload: SessionSummaryInvalidation) => void) => () => void;
};

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

export function startConversationDetailSubscription(input: {
  api: Partial<SessionSummaryInvalidationSubscriptionApi> | null;
  ownerSessionId: string;
  onChange: () => void;
}): () => void {
  if (!input.api?.subscribeSessionInvalidation) return () => undefined;
  return startSessionSummaryInvalidationSubscription({
    api: { subscribeSessionInvalidation: input.api.subscribeSessionInvalidation.bind(input.api) },
    onInvalidation: (payload) => {
      if (payload.detailChanged === false
        || (payload.scope === "ids" && !payload.sessionIds.includes(input.ownerSessionId))) return;
      input.onChange();
    },
  });
}

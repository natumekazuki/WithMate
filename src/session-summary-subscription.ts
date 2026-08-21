import type { SessionSummaryInvalidation } from "./session-state.js";

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

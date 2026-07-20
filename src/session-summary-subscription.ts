import type { SessionSummary } from "./session-state.js";

export type SessionSummariesLoadStatus = "loading" | "loaded" | "error";

export type SessionSummariesSubscriptionApi = {
  listSessionSummaries: () => Promise<SessionSummary[]>;
  subscribeSessionSummaries: (
    listener: (summaries: SessionSummary[]) => void,
  ) => () => void;
};

export function startSessionSummariesSubscription(input: {
  api: SessionSummariesSubscriptionApi | null;
  applySummaries: (summaries: SessionSummary[]) => void;
  onInitialLoadError?: (error: unknown) => void;
}): () => void {
  let active = true;
  let receivedSubscriptionUpdate = false;

  if (!input.api) {
    return () => {
      active = false;
    };
  }

  void input.api.listSessionSummaries().then((summaries) => {
    if (active && !receivedSubscriptionUpdate) {
      input.applySummaries(summaries);
    }
  }).catch((error: unknown) => {
    if (active && !receivedSubscriptionUpdate) {
      input.onInitialLoadError?.(error);
    }
  });

  const unsubscribe = input.api.subscribeSessionSummaries((summaries) => {
    receivedSubscriptionUpdate = true;
    if (active) {
      input.applySummaries(summaries);
    }
  });

  return () => {
    active = false;
    unsubscribe();
  };
}

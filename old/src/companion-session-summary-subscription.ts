import type { CompanionSessionSummary } from "./companion-state.js";

export type CompanionSessionSummariesSubscriptionApi = {
  listCompanionSessionSummaries: () => Promise<CompanionSessionSummary[]>;
  subscribeCompanionSessionSummaries: (
    listener: (summaries: CompanionSessionSummary[]) => void,
  ) => () => void;
};

export function startCompanionSessionSummariesSubscription(input: {
  api: CompanionSessionSummariesSubscriptionApi | null;
  applySummaries: (summaries: CompanionSessionSummary[]) => void;
  onInitialLoadError?: (error: unknown) => void;
}): () => void {
  let active = true;
  let receivedSubscriptionUpdate = false;
  if (!input.api) {
    return () => {
      active = false;
    };
  }

  void input.api.listCompanionSessionSummaries().then((summaries) => {
    if (active && !receivedSubscriptionUpdate) {
      input.applySummaries(summaries);
    }
  }).catch((error: unknown) => {
    if (active && !receivedSubscriptionUpdate) {
      input.onInitialLoadError?.(error);
    }
  });

  const unsubscribe = input.api.subscribeCompanionSessionSummaries((summaries) => {
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

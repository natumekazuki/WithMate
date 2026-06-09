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
}): () => void {
  let active = true;
  if (!input.api) {
    return () => {
      active = false;
    };
  }

  void input.api.listCompanionSessionSummaries().then((summaries) => {
    if (active) {
      input.applySummaries(summaries);
    }
  });

  const unsubscribe = input.api.subscribeCompanionSessionSummaries((summaries) => {
    if (active) {
      input.applySummaries(summaries);
    }
  });

  return () => {
    active = false;
    unsubscribe();
  };
}

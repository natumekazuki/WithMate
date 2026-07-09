export type OpenCompanionReviewWindowIdsSubscriptionApi = {
  listOpenCompanionReviewWindowIds: () => Promise<string[]>;
  subscribeOpenCompanionReviewWindowIds: (
    listener: (sessionIds: string[]) => void,
  ) => () => void;
};

export function startOpenCompanionReviewWindowIdsSubscription(input: {
  api: OpenCompanionReviewWindowIdsSubscriptionApi | null;
  applyOpenWindowIds: (sessionIds: string[]) => void;
}): () => void {
  let active = true;
  let receivedSubscriptionUpdate = false;

  if (!input.api) {
    return () => {
      active = false;
    };
  }

  const unsubscribe = input.api.subscribeOpenCompanionReviewWindowIds((nextSessionIds) => {
    if (!active) {
      return;
    }

    receivedSubscriptionUpdate = true;
    input.applyOpenWindowIds(nextSessionIds);
  });

  void input.api.listOpenCompanionReviewWindowIds().then((nextSessionIds) => {
    if (!active || receivedSubscriptionUpdate) {
      return;
    }

    input.applyOpenWindowIds(nextSessionIds);
  });

  return () => {
    active = false;
    unsubscribe();
  };
}

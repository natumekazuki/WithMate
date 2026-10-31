export type OpenSessionWindowIdsLoadStatus = "loading" | "loaded" | "error";

export type OpenSessionWindowIdsState = {
  status: OpenSessionWindowIdsLoadStatus;
  sessionIds: string[];
};

export type OpenSessionWindowIdsSubscriptionApi = {
  listOpenSessionWindowIds: () => Promise<string[]>;
  subscribeOpenSessionWindowIds: (
    listener: (sessionIds: string[]) => void,
  ) => () => void;
};

export function startOpenSessionWindowIdsSubscription(input: {
  api: OpenSessionWindowIdsSubscriptionApi | null;
  applyState: (state: OpenSessionWindowIdsState) => void;
}): () => void {
  let active = true;
  let receivedSubscriptionUpdate = false;

  if (!input.api) {
    return () => {
      active = false;
    };
  }

  const applyLoadedState = (sessionIds: string[]) => {
    input.applyState({ status: "loaded", sessionIds });
  };
  const unsubscribe = input.api.subscribeOpenSessionWindowIds((nextSessionIds) => {
    if (!active) {
      return;
    }

    receivedSubscriptionUpdate = true;
    applyLoadedState(nextSessionIds);
  });

  void input.api.listOpenSessionWindowIds().then((nextSessionIds) => {
    if (!active || receivedSubscriptionUpdate) {
      return;
    }

    applyLoadedState(nextSessionIds);
  }).catch(() => {
    if (!active || receivedSubscriptionUpdate) {
      return;
    }

    input.applyState({ status: "error", sessionIds: [] });
  });

  return () => {
    active = false;
    unsubscribe();
  };
}

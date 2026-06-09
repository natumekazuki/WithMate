import type { LiveSessionRunState } from "./app-state.js";

export type LiveSessionRunSubscriptionApi = {
  getLiveSessionRun: (sessionId: string) => Promise<LiveSessionRunState | null>;
  subscribeLiveSessionRun: (
    listener: (sessionId: string, state: LiveSessionRunState | null) => void,
  ) => () => void;
};

export type LiveSessionRunStateUpdate = {
  ownerSessionId: string;
  state: LiveSessionRunState | null;
};

export function startLiveSessionRunSubscription(input: {
  sessionId: string;
  api: LiveSessionRunSubscriptionApi;
  applyLiveRunState: (update: LiveSessionRunStateUpdate) => void;
  onSessionRunUpdated?: (sessionId: string) => void;
}): () => void {
  let active = true;

  input.applyLiveRunState({ ownerSessionId: input.sessionId, state: null });
  void input.api.getLiveSessionRun(input.sessionId).then((state) => {
    if (active) {
      input.applyLiveRunState({ ownerSessionId: input.sessionId, state });
      input.onSessionRunUpdated?.(input.sessionId);
    }
  });

  const unsubscribe = input.api.subscribeLiveSessionRun((sessionId, state) => {
    if (!active || sessionId !== input.sessionId) {
      return;
    }

    input.applyLiveRunState({ ownerSessionId: sessionId, state });
    input.onSessionRunUpdated?.(sessionId);
  });

  return () => {
    active = false;
    unsubscribe();
  };
}

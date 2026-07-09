import type { LiveSessionRunState } from "./app-state.js";

const SESSION_RUN_STUCK_INVESTIGATION_LOG = "[investigate:session-run-stuck]";

function logSessionRunStuckInvestigation(
  event: string,
  details: Record<string, unknown>,
): void {
  console.info(SESSION_RUN_STUCK_INVESTIGATION_LOG, event, details);
}

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
  let receivedSubscriptionUpdate = false;

  input.applyLiveRunState({ ownerSessionId: input.sessionId, state: null });
  logSessionRunStuckInvestigation("renderer.live-run-subscription.start", {
    sessionId: input.sessionId,
  });
  void input.api.getLiveSessionRun(input.sessionId)
    .then((state) => {
      logSessionRunStuckInvestigation("renderer.live-run-initial-get.done", {
        sessionId: input.sessionId,
        active,
        receivedSubscriptionUpdate,
        state: state ? "present" : "null",
        assistantChars: state?.assistantText.length ?? 0,
        stepCount: state?.steps.length ?? 0,
        backgroundTaskCount: state?.backgroundTasks.length ?? 0,
      });
      if (active && !receivedSubscriptionUpdate) {
        input.applyLiveRunState({ ownerSessionId: input.sessionId, state });
        input.onSessionRunUpdated?.(input.sessionId);
      }
    })
    .catch((error) => {
      logSessionRunStuckInvestigation("renderer.live-run-initial-get.failed", {
        sessionId: input.sessionId,
        active,
        receivedSubscriptionUpdate,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });

  const unsubscribe = input.api.subscribeLiveSessionRun((sessionId, state) => {
    if (!active || sessionId !== input.sessionId) {
      return;
    }

    receivedSubscriptionUpdate = true;
    logSessionRunStuckInvestigation("renderer.live-run-subscription.event", {
      sessionId,
      state: state ? "present" : "null",
      assistantChars: state?.assistantText.length ?? 0,
      stepCount: state?.steps.length ?? 0,
      backgroundTaskCount: state?.backgroundTasks.length ?? 0,
      errorChars: state?.errorMessage.length ?? 0,
    });
    input.applyLiveRunState({ ownerSessionId: sessionId, state });
    input.onSessionRunUpdated?.(sessionId);
  });

  return () => {
    active = false;
    unsubscribe();
  };
}

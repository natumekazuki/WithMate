import type { SessionSummaryInvalidation } from "./session-state.js";
import type { WithMateWindowApi } from "./withmate-window-api.js";

export type RelatedSessionDetails = {
  sessionId: string;
  taskTitle: string;
};

type RelatedSessionDetailsApi = Pick<WithMateWindowApi, "getSession" | "subscribeSessionInvalidation">;

export function startRelatedSessionDetailsSubscription(input: {
  api: RelatedSessionDetailsApi | null;
  sessionIds: readonly string[];
  applyDetails: (details: RelatedSessionDetails[]) => void;
  onError?: (error: unknown) => void;
}): () => void {
  const sessionIds = [...new Set(input.sessionIds.filter(Boolean))];
  input.applyDetails([]);
  if (!input.api || sessionIds.length === 0) return () => undefined;

  let active = true;
  let refreshRevision = 0;
  const targetIds = new Set(sessionIds);
  const refresh = async () => {
    const revision = ++refreshRevision;
    try {
      const sessions = await Promise.all(sessionIds.map((sessionId) => input.api!.getSession(sessionId)));
      if (!active || revision !== refreshRevision) return;
      input.applyDetails(sessions.flatMap((session) => session
        ? [{ sessionId: session.id, taskTitle: session.taskTitle }]
        : []));
    } catch (error) {
      if (active && revision === refreshRevision) input.onError?.(error);
    }
  };
  const shouldRefresh = (payload: SessionSummaryInvalidation) => (
    payload.scope === "all" || payload.sessionIds.some((sessionId) => targetIds.has(sessionId))
  );
  const unsubscribe = input.api.subscribeSessionInvalidation((payload) => {
    if (active && shouldRefresh(payload)) void refresh();
  });
  void refresh();

  return () => {
    active = false;
    refreshRevision += 1;
    unsubscribe();
  };
}

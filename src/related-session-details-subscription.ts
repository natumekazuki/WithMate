import type { SessionSummaryInvalidation } from "./session-state.js";
import type { RelatedSessionDetails } from "./related-session-details.js";
import type { WithMateWindowApi } from "./withmate-window-api.js";

type RelatedSessionDetailsApi = Pick<
  WithMateWindowApi,
  "listRelatedSessionSummaries" | "subscribeSessionInvalidation"
>;

type RelatedSessionDetailsUpdater = (
  update: (current: RelatedSessionDetails[]) => RelatedSessionDetails[],
) => void;

export function startRelatedSessionDetailsSubscription(input: {
  api: RelatedSessionDetailsApi | null;
  sessionIds: readonly string[];
  applyDetails: RelatedSessionDetailsUpdater;
  onError?: (error: unknown) => void;
}): () => void {
  const sessionIds = [...new Set(input.sessionIds.filter(Boolean))];
  const targetIds = new Set(sessionIds);
  input.applyDetails((current) => {
    const currentById = new Map(current.map((details) => [details.sessionId, details]));
    return sessionIds.map((sessionId) => currentById.get(sessionId) ?? { sessionId, status: "loading" });
  });
  if (sessionIds.length === 0) return () => undefined;
  if (!input.api) {
    input.applyDetails((current) => current.map((details): RelatedSessionDetails => (
      details.status === "found" || (details.status === "error" && details.taskTitle)
        ? { sessionId: details.sessionId, status: "error", taskTitle: details.taskTitle }
        : { sessionId: details.sessionId, status: "error" }
    )));
    return () => undefined;
  }
  const api = input.api;

  let active = true;
  let refreshRevision = 0;
  const refresh = async () => {
    const revision = ++refreshRevision;
    try {
      const summaries = await api.listRelatedSessionSummaries(sessionIds);
      if (!active || revision !== refreshRevision) return;
      const summariesById = new Map(summaries.map((summary) => [summary.sessionId, summary]));
      input.applyDetails(() => sessionIds.map((sessionId): RelatedSessionDetails => {
        const summary = summariesById.get(sessionId);
        return summary
          ? { sessionId, status: "found", taskTitle: summary.taskTitle }
          : { sessionId, status: "missing" };
      }));
    } catch (error) {
      if (active && revision === refreshRevision) {
        input.applyDetails((current) => current.map((details): RelatedSessionDetails => (
          details.status === "found" || (details.status === "error" && details.taskTitle)
            ? { sessionId: details.sessionId, status: "error", taskTitle: details.taskTitle }
            : { sessionId: details.sessionId, status: "error" }
        )));
        input.onError?.(error);
      }
    }
  };
  const shouldRefresh = (payload: SessionSummaryInvalidation) => (
    payload.scope === "all" || payload.sessionIds.some((sessionId) => targetIds.has(sessionId))
  );
  const unsubscribe = api.subscribeSessionInvalidation((payload) => {
    if (active && shouldRefresh(payload)) void refresh();
  });
  void refresh();

  return () => {
    active = false;
    refreshRevision += 1;
    unsubscribe();
  };
}

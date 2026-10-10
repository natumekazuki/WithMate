import type { SessionSummaryInvalidation } from "../../src-shared/session/session-state.js";
import { HOME_SESSION_SUMMARY_OPEN_ID_CHUNK_SIZE } from "./home-session-summary-query.js";

export type HomeSessionSummaryRefreshRequest = {
  mode: "replace" | "preserve";
  invalidation: SessionSummaryInvalidation;
};

export type HomeSessionSummaryRefresher = {
  refresh(request: HomeSessionSummaryRefreshRequest): Promise<void>;
  invalidate(): void;
  dispose(): void;
};

function mergeRequests(
  pending: HomeSessionSummaryRefreshRequest | null,
  next: HomeSessionSummaryRefreshRequest,
): HomeSessionSummaryRefreshRequest {
  const mode = pending?.mode === "replace" || next.mode === "replace" ? "replace" : "preserve";
  if (pending?.invalidation.scope === "all" || next.invalidation.scope === "all") {
    return { mode, invalidation: { scope: "all" } };
  }
  const sessionIds = new Set<string>();
  for (const ids of [pending?.invalidation.sessionIds ?? [], next.invalidation.sessionIds]) {
    for (const id of ids) {
      sessionIds.add(id);
      if (sessionIds.size > HOME_SESSION_SUMMARY_OPEN_ID_CHUNK_SIZE) {
        return { mode, invalidation: { scope: "all" } };
      }
    }
  }
  return { mode, invalidation: { scope: "ids", sessionIds: [...sessionIds] } };
}

export function createHomeSessionSummaryRefresher(
  run: (request: HomeSessionSummaryRefreshRequest, isCurrent: () => boolean) => Promise<void>,
): HomeSessionSummaryRefresher {
  let active = true;
  let generation = 0;
  let pending: HomeSessionSummaryRefreshRequest | null = null;
  let running: HomeSessionSummaryRefreshRequest | null = null;
  let inFlight: Promise<void> | null = null;

  const drain = (): Promise<void> => {
    inFlight = Promise.resolve().then(async () => {
      while (active && pending) {
        const request = pending;
        const requestGeneration = generation;
        pending = null;
        running = request;
        try {
          await run(request, () => active && generation === requestGeneration);
        } finally {
          running = null;
        }
      }
    }).finally(() => {
      inFlight = null;
      if (active && pending) return drain();
    });
    return inFlight;
  };

  return {
    refresh(request) {
      if (!active) return Promise.resolve();
      generation += 1;
      pending = mergeRequests(pending ?? running, request);
      return inFlight ?? drain();
    },
    invalidate() {
      generation += 1;
    },
    dispose() {
      active = false;
      generation += 1;
      pending = null;
    },
  };
}

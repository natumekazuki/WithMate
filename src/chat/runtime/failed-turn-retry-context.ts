import { createContext, useContext } from "react";
import type { RetryFailedSessionTurnRequest, SessionTurnQueueReceipt } from "../../../src-shared/session/session-turn-queue.js";

export type FailedTurnRetryContext = {
  submit(request: Omit<RetryFailedSessionTurnRequest, "executionOptions">): Promise<SessionTurnQueueReceipt>;
  blocked(sessionId: string): boolean;
};

export const FailedTurnRetryContext = createContext<FailedTurnRetryContext | null>(null);
export const useFailedTurnRetry = () => useContext(FailedTurnRetryContext);

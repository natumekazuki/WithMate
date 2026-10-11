import type { ComposerAttachment, RunSessionTurnRequest } from "./runtime-state.js";

export type SessionTurnQueueOwner = { sessionId: string; incarnationId: string };
export type SessionTurnQueueCapturedInput = {
  request: RunSessionTurnRequest & { clientRequestId: string };
  attachments: ComposerAttachment[];
  provider: string;
  workspacePath: string;
};
export type SessionTurnQueueState = "queued" | "starting" | "running" | "completed" | "failed" | "canceled" | "interrupted";
export type SessionTurnQueueReceipt = SessionTurnQueueOwner & {
  id: string;
  requestId: string;
  sequence: number;
  state: SessionTurnQueueState;
  captured: SessionTurnQueueCapturedInput;
  turnId: string | null;
  inputTurnId?: string | null;
  userMessageSeq: number | null;
  reason: string | null;
  releasedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type SessionTurnQueueReceiptPage = { receipts: SessionTurnQueueReceipt[]; nextCursor: number | null };
export type SessionTurnQueueAcceptanceResult = SessionTurnQueueReceipt | {
  state: "rejected";
  reason: string;
};
export type SessionTurnQueueStore = {
  enqueue(owner: SessionTurnQueueOwner, captured: SessionTurnQueueCapturedInput): Promise<SessionTurnQueueReceipt>;
  getReceipt(owner: SessionTurnQueueOwner, requestId: string): Promise<SessionTurnQueueReceipt | null>;
  listActive(owner: SessionTurnQueueOwner): Promise<SessionTurnQueueReceipt[]>;
  listReceipts(owner: SessionTurnQueueOwner, options?: { cursor?: number; limit?: number }): Promise<SessionTurnQueueReceiptPage>;
  listPendingOwners(): Promise<SessionTurnQueueOwner[]>;
  claimNext(owner: SessionTurnQueueOwner): Promise<SessionTurnQueueReceipt | null>;
  claimForInput(owner: SessionTurnQueueOwner, id: string, expectedTurnId: string): Promise<SessionTurnQueueReceipt>;
  restoreQueuedInput(owner: SessionTurnQueueOwner, id: string, expectedTurnId: string): Promise<SessionTurnQueueReceipt>;
  markStarted(owner: SessionTurnQueueOwner, id: string, input: { turnId: string; userMessageSeq: number }): Promise<SessionTurnQueueReceipt>;
  settle(owner: SessionTurnQueueOwner, id: string, state: Extract<SessionTurnQueueState, "completed" | "failed" | "canceled" | "interrupted">, reason?: string): Promise<SessionTurnQueueReceipt>;
  cancelQueued(owner: SessionTurnQueueOwner, id: string): Promise<SessionTurnQueueReceipt>;
  recoverInterrupted(): Promise<number>;
  releaseInterrupted(owner: SessionTurnQueueOwner, id: string, options?: { runReleased: boolean }): Promise<SessionTurnQueueReceipt>;
};

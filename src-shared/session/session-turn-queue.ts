import type { ComposerAttachment, RunSessionTurnRequest } from "./runtime-state.js";

export type SessionTurnQueueOwner = { sessionId: string; incarnationId: string };
export type SessionTurnQueueOrigin = {
  kind: "gui" | "session";
  actorSessionId?: string;
  actorKind?: "main" | "auxiliary";
  actorIncarnationId?: string;
  actorTurnId?: string;
  operation: "send";
  targetSessionId: string;
  targetIncarnationId: string;
};
export type SessionTurnQueueCapturedInput = {
  coordination?: { id: string; operation: string; actor: import("../coordination/coordination-contract.js").CoordinationActor; answerId?: string; answerRevision?: number };
  request: RunSessionTurnRequest & { clientRequestId: string };
  attachments: ComposerAttachment[];
  provider: string;
  workspacePath: string;
  origin?: SessionTurnQueueOrigin;
};
export type SessionTurnQueueState = "queued" | "starting" | "running" | "completed" | "failed" | "canceled" | "interrupted";
export type SessionTurnQueueReceipt = SessionTurnQueueOwner & {
  id: string;
  requestId: string;
  sequence: number;
  queuePosition: number;
  state: SessionTurnQueueState;
  captured: SessionTurnQueueCapturedInput;
  /** Immutable acceptance input; absent/null means the original was not recorded. */
  accepted?: SessionTurnQueueCapturedInput | null;
  /** Input frozen by the dispatch claim, not proof of Provider delivery. */
  dispatched?: SessionTurnQueueCapturedInput | null;
  turnId: string | null;
  inputTurnId?: string | null;
  userMessageSeq: number | null;
  reason: string | null;
  releasedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type SessionTurnQueueReceiptPage = { receipts: SessionTurnQueueReceipt[]; nextCursor: number | null };
export type ReorderQueuedSessionTurnsRequest = { incarnationId: string; expectedQueuedIds: string[]; queuedIds: string[] };
export type QueuedSessionTurnEditRequest = { incarnationId: string; id: string };
export type UpdateQueuedSessionTurnRequest = QueuedSessionTurnEditRequest & { userMessage: string };
export type SessionTurnQueueReorderResult = { outcome: "reordered" | "conflict"; receipts: SessionTurnQueueReceipt[] };
export type SessionTurnQueueAcceptanceResult = SessionTurnQueueReceipt | {
  state: "rejected";
  reason: string;
};
export type SessionTurnQueueStore = {
  enqueue(owner: SessionTurnQueueOwner, captured: SessionTurnQueueCapturedInput): Promise<SessionTurnQueueReceipt>;
  getReceipt(owner: SessionTurnQueueOwner, requestId: string): Promise<SessionTurnQueueReceipt | null>;
  getReceiptById(owner: SessionTurnQueueOwner, id: string): Promise<SessionTurnQueueReceipt | null>;
  listActive(owner: SessionTurnQueueOwner): Promise<SessionTurnQueueReceipt[]>;
  listReceipts(owner: SessionTurnQueueOwner, options?: { cursor?: number; limit?: number }): Promise<SessionTurnQueueReceiptPage>;
  listPendingOwners(): Promise<SessionTurnQueueOwner[]>;
  claimNext(owner: SessionTurnQueueOwner): Promise<SessionTurnQueueReceipt | null>;
  claimForInput(owner: SessionTurnQueueOwner, id: string, expectedTurnId: string): Promise<SessionTurnQueueReceipt>;
  restoreQueuedInput(owner: SessionTurnQueueOwner, id: string, expectedTurnId: string): Promise<SessionTurnQueueReceipt>;
  markStarted(owner: SessionTurnQueueOwner, id: string, input: { turnId: string; userMessageSeq: number }): Promise<SessionTurnQueueReceipt>;
  settle(owner: SessionTurnQueueOwner, id: string, state: Extract<SessionTurnQueueState, "completed" | "failed" | "canceled" | "interrupted">, reason?: string): Promise<SessionTurnQueueReceipt>;
  cancelQueued(owner: SessionTurnQueueOwner, id: string): Promise<SessionTurnQueueReceipt>;
  updateQueued(owner: SessionTurnQueueOwner, id: string, input: { userMessage: string; attachments: ComposerAttachment[] }): Promise<SessionTurnQueueReceipt>;
  reorderQueued(owner: SessionTurnQueueOwner, expectedQueuedIds: string[], queuedIds: string[]): Promise<SessionTurnQueueReorderResult>;
  recoverInterrupted(): Promise<number>;
  releaseInterrupted(owner: SessionTurnQueueOwner, id: string, options?: { runReleased: boolean }): Promise<SessionTurnQueueReceipt>;
};

import type { SessionTurnQueueReceipt } from "../../../src-shared/session/session-turn-queue.js";

export type SessionTurnSubmission = {
  sessionId: string;
  incarnationId: string;
  requestId: string;
  userMessage: string;
  historyMessageCount: number;
  queuedBehindRun: boolean;
  error: string;
  uncertain?: boolean;
  receipt?: SessionTurnQueueReceipt;
};

/** Window-local presentation only; receipts and runtime remain authoritative. */
export class SessionTurnSubmissions {
  private snapshot: readonly SessionTurnSubmission[] = [];
  private readonly listeners = new Set<() => void>();
  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(next: readonly SessionTurnSubmission[]) {
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }
  start(submission: SessionTurnSubmission) {
    this.publish([...this.snapshot.filter((current) => current.sessionId !== submission.sessionId
      || current.incarnationId !== submission.incarnationId || !current.error || current.receipt), submission]);
  }
  fail(requestId: string, error: string, uncertain = false) {
    this.publish(this.snapshot.map((current) => current.requestId === requestId ? { ...current, error, uncertain } : current));
  }
  accept(receipt: SessionTurnQueueReceipt) {
    this.publish(this.snapshot.map((current) => current.requestId === receipt.requestId
      && current.sessionId === receipt.sessionId && current.incarnationId === receipt.incarnationId
      ? { ...current, receipt, error: "", uncertain: false } : current));
  }
  forget(requestIds: readonly string[]) {
    const next = this.snapshot.filter((current) => !requestIds.includes(current.requestId));
    if (next.length !== this.snapshot.length) this.publish(next);
  }
}

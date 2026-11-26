import type { LiveApprovalDecision, LiveApprovalRequest, LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { PendingApprovalReview } from "./withmate-approval-review.js";

type PendingApprovalRequest = {
  request: LiveApprovalRequest;
  decision: Promise<LiveApprovalDecision>;
  signals: Set<AbortSignal>;
  handleAbort: () => void;
  lifetime: AbortController;
  /** If present, manual resolution is unavailable until this head's attempt falls back. */
  review?: PendingApprovalReview;
  finish: (decision: LiveApprovalDecision) => void;
};

type SessionApprovalServiceOptions = {
  notifyApproval?: (sessionId: string, requestId: string, signal: AbortSignal) => void;
  updateLiveSessionRun: (
    sessionId: string,
    recipe: (current: LiveSessionRunState) => LiveSessionRunState,
  ) => LiveSessionRunState | null;
};

export class SessionApprovalService {
  private readonly pendingRequests = new Map<string, PendingApprovalRequest[]>();
  private readonly stoppingReviews = new Map<string, Promise<void>>();

  public constructor(private readonly options: SessionApprovalServiceOptions) {}

  public reset(): void {
    for (const sessionId of this.pendingRequests.keys()) this.cancelSession(sessionId);
  }

  public cancelSession(sessionId: string): void {
    const queue = this.pendingRequests.get(sessionId);
    if (!queue) return;
    this.pendingRequests.delete(sessionId);
    for (const pending of queue) pending.finish("deny");
    this.clearPublishedRequest(sessionId, queue[0]?.request.requestId);
  }

  public resolveLiveApproval(sessionId: string, requestId: string, decision: LiveApprovalDecision): void {
    const pendingRequest = this.pendingRequests.get(sessionId)?.[0];
    if (!pendingRequest || pendingRequest.request.requestId !== requestId || pendingRequest.review
      || [...pendingRequest.signals].some((signal) => signal.aborted)) {
      throw new Error("The approval request no longer exists.");
    }

    this.settle(sessionId, pendingRequest, decision);
  }

  public waitForLiveApprovalDecision(
    sessionId: string,
    request: LiveApprovalRequest,
    signal: AbortSignal,
    review?: PendingApprovalReview,
  ): Promise<LiveApprovalDecision> {
    const queue = this.pendingRequests.get(sessionId) ?? [];
    const existing = queue.find((pending) => pending.request.requestId === request.requestId);
    if (signal.aborted) {
      if (existing) {
        this.settle(sessionId, existing, "deny");
        return existing.decision;
      }
      return Promise.resolve("deny");
    }

    if (existing) {
      existing.signals.add(signal);
      signal.addEventListener("abort", existing.handleAbort, { once: true });
      return existing.decision;
    }

    let resolveDecision!: (decision: LiveApprovalDecision) => void;
    const decision = new Promise<LiveApprovalDecision>((resolve) => { resolveDecision = resolve; });
    const pending: PendingApprovalRequest = {
      request,
      decision,
      signals: new Set([signal]),
      handleAbort: () => this.settle(sessionId, pending, "deny"),
      lifetime: new AbortController(),
      review,
      finish: (value) => {
        for (const trackedSignal of pending.signals) trackedSignal.removeEventListener("abort", pending.handleAbort);
        pending.signals.clear();
        pending.lifetime.abort();
        resolveDecision(value);
      },
    };
    queue.push(pending);
    this.pendingRequests.set(sessionId, queue);
    signal.addEventListener("abort", pending.handleAbort, { once: true });
    if (queue.length === 1) {
      this.advanceHead(sessionId, queue);
    }
    return decision;
  }

  private async reviewHead(sessionId: string, pending: PendingApprovalRequest, review: PendingApprovalReview): Promise<void> {
    const signal = pending.lifetime.signal;
    const isCurrentHead = () => this.isCurrentHead(sessionId, pending);
    const isCurrent = () => isCurrentHead() && review.isCurrent();
    // Defer the reviewer, while keeping the head unavailable for manual resolution.
    await Promise.resolve();
    let decision: LiveApprovalDecision | null = null;
    try {
      if (isCurrent()) {
        const value = await review.decide(signal, {
          isCurrentHead,
          previousStop: this.stoppingReviews.get(sessionId),
          onStopping: (stopped) => {
            // Keep the stop fence even if the source turn and its approval queue are gone.
            this.stoppingReviews.set(sessionId, stopped);
            void stopped.then(() => {
              if (this.stoppingReviews.get(sessionId) === stopped) this.stoppingReviews.delete(sessionId);
            }, () => { /* A failed close is not confirmation of stop. */ });
          },
        });
        if ((value === "approve" || value === "deny") && isCurrent()) decision = value;
      }
    } catch {
      // An unavailable or failed review has no authority to decide.
    }
    if (!isCurrentHead()) return;
    if (decision !== null) {
      this.settle(sessionId, pending, decision);
    } else {
      // A failed, stale or inconclusive attempt never retries this head.
      pending.review = undefined;
      this.publishManualHead(sessionId, pending);
    }
  }

  private settle(sessionId: string, pending: PendingApprovalRequest, decision: LiveApprovalDecision): void {
    const queue = this.pendingRequests.get(sessionId);
    const index = queue?.indexOf(pending) ?? -1;
    if (!queue || index < 0) return;
    queue.splice(index, 1);
    pending.finish(decision);
    if (index === 0) this.advanceHead(sessionId, queue, pending.request.requestId);
  }

  private advanceHead(sessionId: string, queue: PendingApprovalRequest[], previousRequestId?: string): void {
    // A shared turn signal is already aborted before its individual listeners run.
    while (queue[0] && [...queue[0].signals].some((signal) => signal.aborted)) {
      queue.shift()!.finish("deny");
    }
    const pending = queue[0];
    if (!pending) {
      this.pendingRequests.delete(sessionId);
      this.clearPublishedRequest(sessionId, previousRequestId);
      return;
    }
    if (pending.review) {
      this.clearPublishedRequest(sessionId, previousRequestId);
      void this.reviewHead(sessionId, pending, pending.review);
    } else {
      this.publishManualHead(sessionId, pending);
    }
  }

  private isCurrentHead(sessionId: string, pending: PendingApprovalRequest): boolean {
    return this.pendingRequests.get(sessionId)?.[0] === pending && !pending.lifetime.signal.aborted
      && ![...pending.signals].some((signal) => signal.aborted);
  }

  private publishManualHead(sessionId: string, pending: PendingApprovalRequest): void {
    if (!this.isCurrentHead(sessionId, pending)) return;
    const published = this.options.updateLiveSessionRun(sessionId, (current) => ({
      ...current,
      approvalRequest: pending.request,
    }));
    if (published?.approvalRequest?.requestId === pending.request.requestId
      && this.isCurrentHead(sessionId, pending)) {
      try {
        this.options.notifyApproval?.(sessionId, pending.request.requestId, pending.lifetime.signal);
      } catch {
        // Attention delivery must not interrupt the pending approval decision.
      }
    }
  }

  private clearPublishedRequest(sessionId: string, requestId?: string): void {
    if (requestId === undefined) return;
    this.options.updateLiveSessionRun(sessionId, (current) =>
      current.approvalRequest?.requestId === requestId
        ? { ...current, approvalRequest: null }
        : current,
    );
  }
}

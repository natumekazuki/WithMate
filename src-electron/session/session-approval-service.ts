import type { LiveApprovalDecision, LiveApprovalRequest, LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import { reportApprovalDecisionSource, type ApprovalDecisionSource, type ApprovalDecisionSourceObserver } from "../providers/provider-runtime.js";
import type { PendingApprovalReview } from "./withmate-approval-review.js";

type PendingApprovalRequest = {
  request: LiveApprovalRequest;
  decision: Promise<LiveApprovalDecision>;
  signals: Set<AbortSignal>;
  handleAbort: () => void;
  lifetime: AbortController;
  /** Undefined is the existing manual path; null is a selected but unavailable review route. */
  review?: PendingApprovalReview | null;
  manual?: "published" | "legacy-unpublished";
  observers: Set<ApprovalDecisionSourceObserver>;
  finish: (decision: LiveApprovalDecision, source: ApprovalDecisionSource) => void;
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
    for (const pending of queue) pending.finish("deny", "blocked");
    if (queue[0]?.manual === "published") this.clearPublishedRequest(sessionId, queue[0].request.requestId);
  }

  public resolveLiveApproval(sessionId: string, requestId: string, decision: LiveApprovalDecision): void {
    const pendingRequest = this.pendingRequests.get(sessionId)?.[0];
    if (!pendingRequest || pendingRequest.request.requestId !== requestId || !pendingRequest.manual
      || !this.isCurrentHead(sessionId, pendingRequest)) {
      throw new Error("The approval request no longer exists.");
    }

    this.settle(sessionId, pendingRequest, decision, pendingRequest.manual === "published" ? "manual" : "blocked");
  }

  public waitForLiveApprovalDecision(
    sessionId: string,
    request: LiveApprovalRequest,
    signal: AbortSignal,
    review?: PendingApprovalReview | null,
    onDecisionSource?: ApprovalDecisionSourceObserver,
  ): Promise<LiveApprovalDecision> {
    const queue = this.pendingRequests.get(sessionId) ?? [];
    const existing = queue.find((pending) => pending.request.requestId === request.requestId);
    if (existing && onDecisionSource) existing.observers.add(onDecisionSource);
    if (signal.aborted) {
      if (existing) {
        this.settle(sessionId, existing, "deny", "blocked");
        return existing.decision;
      }
      reportApprovalDecisionSource(onDecisionSource, "blocked");
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
      handleAbort: () => this.settle(sessionId, pending, "deny", "blocked"),
      lifetime: new AbortController(),
      review,
      observers: new Set(onDecisionSource ? [onDecisionSource] : []),
      finish: (value, source) => {
        for (const trackedSignal of pending.signals) trackedSignal.removeEventListener("abort", pending.handleAbort);
        pending.signals.clear();
        pending.lifetime.abort();
        if (pending.observers.size) {
          // Publish provenance after the queue transition, before decision consumers resume.
          queueMicrotask(() => {
            for (const observer of pending.observers) reportApprovalDecisionSource(observer, source);
            pending.observers.clear();
          });
        }
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
    let verdict: Awaited<ReturnType<PendingApprovalReview["decide"]>> = null;
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
        if (isCurrent()) verdict = value;
      }
    } catch {
      // An unavailable or failed review has no authority to decide.
    }
    if (!isCurrentHead()) return;
    if (verdict === "allow_once" || verdict === "deny") {
      this.settle(sessionId, pending, verdict === "allow_once" ? "approve" : "deny", "reviewer");
    } else if (verdict === "ask_user") {
      this.publishManualHead(sessionId, pending);
    } else {
      this.settle(sessionId, pending, "deny", "blocked");
    }
  }

  private settle(sessionId: string, pending: PendingApprovalRequest, decision: LiveApprovalDecision, source: ApprovalDecisionSource): void {
    const queue = this.pendingRequests.get(sessionId);
    const index = queue?.indexOf(pending) ?? -1;
    if (!queue || index < 0) return;
    queue.splice(index, 1);
    pending.finish(decision, source);
    if (index === 0) this.advanceHead(sessionId, queue, pending.manual === "published" ? pending.request.requestId : undefined);
  }

  private advanceHead(sessionId: string, queue: PendingApprovalRequest[], previousRequestId?: string): void {
    // A shared turn signal is already aborted before its individual listeners run.
    while (queue[0] && (queue[0].review === null || [...queue[0].signals].some((signal) => signal.aborted))) {
      queue.shift()!.finish("deny", "blocked");
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
    let published: LiveSessionRunState | null;
    try {
      published = this.options.updateLiveSessionRun(sessionId, (current) => ({
        ...current,
        approvalRequest: pending.request,
      }));
    } catch (error) {
      if (!pending.review) throw error;
      this.settle(sessionId, pending, "deny", "blocked");
      return;
    }
    if (!this.isCurrentHead(sessionId, pending)) return;
    if (published?.approvalRequest?.requestId !== pending.request.requestId) {
      if (pending.review) this.settle(sessionId, pending, "deny", "blocked");
      else pending.manual = "legacy-unpublished";
      return;
    }
    pending.manual = "published";
    try {
      this.options.notifyApproval?.(sessionId, pending.request.requestId, pending.lifetime.signal);
    } catch {
      // Attention delivery must not interrupt the pending approval decision.
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

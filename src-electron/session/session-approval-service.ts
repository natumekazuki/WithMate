import type { LiveApprovalDecision, LiveApprovalRequest, LiveSessionRunState } from "../../src-shared/session/runtime-state.js";

type PendingApprovalRequest = {
  request: LiveApprovalRequest;
  decision: Promise<LiveApprovalDecision>;
  signals: Set<AbortSignal>;
  handleAbort: () => void;
  notificationController: AbortController;
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
    if (!pendingRequest || pendingRequest.request.requestId !== requestId) {
      throw new Error("The approval request no longer exists.");
    }

    this.settle(sessionId, pendingRequest, decision);
  }

  public waitForLiveApprovalDecision(
    sessionId: string,
    request: LiveApprovalRequest,
    signal: AbortSignal,
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
      notificationController: new AbortController(),
      finish: (value) => {
        for (const trackedSignal of pending.signals) trackedSignal.removeEventListener("abort", pending.handleAbort);
        pending.signals.clear();
        pending.notificationController.abort();
        resolveDecision(value);
      },
    };
    queue.push(pending);
    this.pendingRequests.set(sessionId, queue);
    signal.addEventListener("abort", pending.handleAbort, { once: true });
    if (queue.length === 1) this.publishHead(sessionId, queue);
    return decision;
  }

  private settle(sessionId: string, pending: PendingApprovalRequest, decision: LiveApprovalDecision): void {
    const queue = this.pendingRequests.get(sessionId);
    const index = queue?.indexOf(pending) ?? -1;
    if (!queue || index < 0) return;
    queue.splice(index, 1);
    pending.finish(decision);
    if (index === 0) this.publishHead(sessionId, queue, pending.request.requestId);
  }

  private publishHead(sessionId: string, queue: PendingApprovalRequest[], previousRequestId?: string): void {
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
    const published = this.options.updateLiveSessionRun(sessionId, (current) => ({
      ...current,
      approvalRequest: pending.request,
    }));
    try {
      if (published?.approvalRequest?.requestId === pending.request.requestId
        && this.pendingRequests.get(sessionId)?.[0] === pending
        && !pending.notificationController.signal.aborted) {
        this.options.notifyApproval?.(sessionId, pending.request.requestId, pending.notificationController.signal);
      }
    } catch {
      // Attention delivery must not interrupt the pending approval decision.
    }
  }

  private clearPublishedRequest(sessionId: string, requestId?: string): void {
    this.options.updateLiveSessionRun(sessionId, (current) =>
      current.approvalRequest?.requestId === requestId
        ? { ...current, approvalRequest: null }
        : current,
    );
  }
}

import type { LiveApprovalDecision, LiveApprovalRequest, LiveSessionRunState } from "../src/app-state.js";

type PendingApprovalRequest = {
  requestId: string;
  resolve: (decision: LiveApprovalDecision) => void;
};

type SessionApprovalServiceOptions = {
  updateLiveSessionRun: (
    sessionId: string,
    recipe: (current: LiveSessionRunState) => LiveSessionRunState,
  ) => LiveSessionRunState | null;
};

export class SessionApprovalService {
  private readonly pendingRequests = new Map<string, PendingApprovalRequest>();

  public constructor(private readonly options: SessionApprovalServiceOptions) {}

  public reset(): void {
    for (const [sessionId, pendingRequest] of this.pendingRequests.entries()) {
      pendingRequest.resolve("deny");
      this.pendingRequests.delete(sessionId);
    }
  }

  public resolveLiveApproval(sessionId: string, requestId: string, decision: LiveApprovalDecision): void {
    const pendingRequest = this.pendingRequests.get(sessionId);
    if (!pendingRequest || pendingRequest.requestId !== requestId) {
      throw new Error("対象の承認要求はもう存在しないよ。");
    }

    pendingRequest.resolve(decision);
  }

  public waitForLiveApprovalDecision(
    sessionId: string,
    request: LiveApprovalRequest,
    signal: AbortSignal,
  ): Promise<LiveApprovalDecision> {
    if (signal.aborted) {
      return Promise.resolve("deny");
    }

    return new Promise<LiveApprovalDecision>((resolve) => {
      const handleAbort = () => {
        settle("deny");
      };

      const cleanup = () => {
        signal.removeEventListener("abort", handleAbort);
        const currentPendingRequest = this.pendingRequests.get(sessionId);
        if (currentPendingRequest?.requestId === request.requestId) {
          this.pendingRequests.delete(sessionId);
        }

        this.options.updateLiveSessionRun(sessionId, (current) =>
          current.approvalRequest?.requestId === request.requestId
            ? { ...current, approvalRequest: null }
            : current,
        );
      };

      const settle = (decision: LiveApprovalDecision) => {
        cleanup();
        resolve(decision);
      };

      signal.addEventListener("abort", handleAbort, { once: true });
      this.pendingRequests.set(sessionId, {
        requestId: request.requestId,
        resolve: settle,
      });
      this.options.updateLiveSessionRun(sessionId, (current) => ({
        ...current,
        approvalRequest: request,
      }));
    });
  }
}

import type { LiveElicitationRequest, LiveElicitationResponse, LiveSessionRunState } from "../src/app-state.js";

type PendingElicitationRequest = {
  requestId: string;
  resolve: (response: LiveElicitationResponse) => void;
};

type SessionElicitationServiceOptions = {
  updateLiveSessionRun: (
    sessionId: string,
    recipe: (current: LiveSessionRunState) => LiveSessionRunState,
  ) => LiveSessionRunState | null;
};

export class SessionElicitationService {
  private readonly pendingRequests = new Map<string, PendingElicitationRequest>();

  public constructor(private readonly options: SessionElicitationServiceOptions) {}

  public reset(): void {
    for (const [sessionId, pendingRequest] of this.pendingRequests.entries()) {
      pendingRequest.resolve({ action: "cancel" });
      this.pendingRequests.delete(sessionId);
    }
  }

  public resolveLiveElicitation(sessionId: string, requestId: string, response: LiveElicitationResponse): void {
    const pendingRequest = this.pendingRequests.get(sessionId);
    if (!pendingRequest || pendingRequest.requestId !== requestId) {
      throw new Error("対象の入力要求はもう存在しないよ。");
    }

    pendingRequest.resolve(response);
  }

  public waitForLiveElicitationResponse(
    sessionId: string,
    request: LiveElicitationRequest,
    signal: AbortSignal,
  ): Promise<LiveElicitationResponse> {
    if (signal.aborted) {
      return Promise.resolve({ action: "cancel" });
    }

    return new Promise<LiveElicitationResponse>((resolve) => {
      const handleAbort = () => {
        settle({ action: "cancel" });
      };

      const cleanup = () => {
        signal.removeEventListener("abort", handleAbort);
        const currentPendingRequest = this.pendingRequests.get(sessionId);
        if (currentPendingRequest?.requestId === request.requestId) {
          this.pendingRequests.delete(sessionId);
        }

        this.options.updateLiveSessionRun(sessionId, (current) =>
          current.elicitationRequest?.requestId === request.requestId
            ? { ...current, elicitationRequest: null }
            : current,
        );
      };

      const settle = (response: LiveElicitationResponse) => {
        cleanup();
        resolve(response);
      };

      signal.addEventListener("abort", handleAbort, { once: true });
      this.pendingRequests.set(sessionId, {
        requestId: request.requestId,
        resolve: settle,
      });
      this.options.updateLiveSessionRun(sessionId, (current) => ({
        ...current,
        elicitationRequest: request,
      }));
    });
  }
}

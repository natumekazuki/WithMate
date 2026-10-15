import type { ElicitationRecord, LiveElicitationRequest, LiveElicitationResponse, LiveSessionRunState } from "../../src-shared/session/runtime-state.js";

type PendingElicitationRequest = {
  request: LiveElicitationRequest;
  response: Promise<LiveElicitationResponse>;
  settle: (response: LiveElicitationResponse, status: ElicitationRecord["status"]) => void;
  expire: () => void;
  sending: boolean;
  expired: boolean;
};

type SessionElicitationServiceOptions = {
  notifyQuestion?: (sessionId: string, signal: AbortSignal) => void;
  sendUserMessage?: (sessionId: string, turnId: string, message: string) => Promise<void>;
  updateLiveSessionRun: (
    sessionId: string,
    recipe: (current: LiveSessionRunState) => LiveSessionRunState,
  ) => LiveSessionRunState | null;
};

function questionAnswerMessage(request: LiveElicitationRequest, response: LiveElicitationResponse): string {
  return request.fields.map((field) => {
    const value = response.content?.[field.name];
    if (typeof value !== "string" || !value.trim()) throw new Error("An answer is required for each question.");
    return `${field.title}\n${value.trim()}`;
  }).join("\n\n");
}

export class SessionElicitationService {
  private readonly pendingRequests = new Map<string, Map<string, PendingElicitationRequest>>();

  public constructor(private readonly options: SessionElicitationServiceOptions) {}

  public reset(): void {
    for (const sessionId of this.pendingRequests.keys()) this.cancelSession(sessionId);
  }

  public cancelSession(sessionId: string): void {
    for (const pending of this.pendingRequests.get(sessionId)?.values() ?? []) pending.expire();
  }

  public resolveLiveElicitation(sessionId: string, requestId: string, response: LiveElicitationResponse): void | Promise<void> {
    const pending = this.pendingRequests.get(sessionId)?.get(requestId);
    if (!pending || pending.expired) throw new Error("The input request no longer exists.");
    if (pending.sending) throw new Error("The answer is already being sent.");
    if (response.action !== "accept" && response.action !== "decline" && response.action !== "cancel") {
      throw new Error("Invalid input response.");
    }
    if (pending.request.delivery === "user-message" && response.action === "accept") {
      const { turnId } = pending.request;
      if (!turnId || !this.options.sendUserMessage) throw new Error("Question answering is unavailable.");
      const message = questionAnswerMessage(pending.request, response);
      if (!message) throw new Error("The question has no answer fields.");
      pending.sending = true;
      return Promise.resolve().then(() => {
        if (pending.expired) throw new Error("The input request no longer exists.");
        return this.options.sendUserMessage!(sessionId, turnId, message);
      }).then(() => {
        pending.settle(response, "answered");
      }, (error: unknown) => {
        pending.sending = false;
        if (pending.expired) pending.settle({ action: "cancel" }, "expired");
        throw error;
      });
    }
    pending.settle(response, response.action === "accept" ? "answered" : response.action === "decline" ? "declined" : "canceled");
  }

  public waitForLiveElicitationResponse(
    sessionId: string,
    request: LiveElicitationRequest,
    signal: AbortSignal,
  ): Promise<LiveElicitationResponse> {
    if (signal.aborted) return Promise.resolve({ action: "cancel" });
    const existing = this.pendingRequests.get(sessionId)?.get(request.requestId);
    if (existing) return existing.response;

    const requests = this.pendingRequests.get(sessionId) ?? new Map<string, PendingElicitationRequest>();
    this.pendingRequests.set(sessionId, requests);
    const notificationController = new AbortController();
    let resolveResponse!: (response: LiveElicitationResponse) => void;
    const response = new Promise<LiveElicitationResponse>((resolve) => { resolveResponse = resolve; });
    let settled = false;
    const update = (status?: ElicitationRecord["status"]) => {
      this.options.updateLiveSessionRun(sessionId, (current) => {
        const active = [...requests.values()].filter((item) => !item.expired).map((item) => item.request);
        return {
          ...current,
          elicitationRequest: active[0] ?? null,
          elicitationRequests: active,
          ...(status ? {
            elicitationRecords: current.elicitationRecords?.map((record) =>
              record.requestId === request.requestId ? { ...record, status } : record),
          } : {}),
        };
      });
    };
    const settle = (value: LiveElicitationResponse, status: ElicitationRecord["status"]) => {
      if (settled) return;
      settled = true;
      notificationController.abort();
      signal.removeEventListener("abort", expire);
      requests.delete(request.requestId);
      if (requests.size === 0 && this.pendingRequests.get(sessionId) === requests) this.pendingRequests.delete(sessionId);
      update(status);
      resolveResponse(value);
    };
    const expire = () => {
      pending.expired = true;
      notificationController.abort();
      // A dispatched answer must settle before terminal history is persisted.
      if (pending.sending) update("expired");
      else settle({ action: "cancel" }, "expired");
    };
    const pending: PendingElicitationRequest = { request, response, settle, expire, sending: false, expired: false };
    requests.set(request.requestId, pending);
    signal.addEventListener("abort", expire, { once: true });
    this.options.updateLiveSessionRun(sessionId, (current) => ({
      ...current,
      elicitationRequest: [...requests.values()][0]?.request ?? null,
      elicitationRequests: [...requests.values()].filter((item) => !item.expired).map((item) => item.request),
      ...(request.mode === "form" ? {
        elicitationRecords: [...current.elicitationRecords ?? [], {
          requestId: request.requestId,
          message: request.message,
          fields: request.fields.map((field) => ({
            title: field.title,
            ...(field.description ? { description: field.description } : {}),
            ...(field.type === "select" || field.type === "multi-select"
              ? { options: field.options.map((option) => option.label) } : {}),
          })),
          status: "pending" as const,
        }],
      } : {}),
    }));
    if (request.provider === "codex" && request.kind === "question") {
      this.options.notifyQuestion?.(sessionId, notificationController.signal);
    }
    return response;
  }
}

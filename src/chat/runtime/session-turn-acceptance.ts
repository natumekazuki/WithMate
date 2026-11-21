import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { RunSessionTurnRequest } from "../../../src-shared/session/runtime-state.js";
import type { SessionTurnQueueReceipt } from "../../../src-shared/session/session-turn-queue.js";
import type { ComposerControllerRegistry, ComposerOwner } from "../composer-controller.js";
import type { AuxiliaryDraftPersistenceOwner } from "../auxiliary-draft-persistence-owner.js";
import { SessionTurnSubmissions } from "./session-turn-submissions.js";

type AcceptanceApi = Pick<WithMateWindowApi, "enqueueSessionTurn" | "getSessionTurnQueueReceipt"> & Partial<Pick<WithMateWindowApi, "retryFailedSessionTurn">>;
type Capture = { request: RunSessionTurnRequest & { incarnationId: string }; owner: ComposerOwner; revision: number; clearDraft: boolean; auxiliaryDraftOwner?: AuxiliaryDraftPersistenceOwner };

/** Window-local uncertain requests are retained until the original identity is resolved. */
export class SessionTurnAcceptance {
  readonly submissions = new SessionTurnSubmissions();
  private readonly uncertain = new Map<string, Capture>();
  private readonly uncertainRetries = new Map<string, import("../../../src-shared/session/session-turn-queue.js").RetryFailedSessionTurnRequest>();

  hasUncertain(sessionId: string): boolean { return this.uncertain.has(sessionId) || this.uncertainRetries.has(sessionId); }

  async submitFailedRetry(api: AcceptanceApi, sessionId: string, request: import("../../../src-shared/session/session-turn-queue.js").RetryFailedSessionTurnRequest): Promise<SessionTurnQueueReceipt> {
    if (this.hasUncertain(sessionId)) throw new Error("A previous turn's acceptance is unknown. Check Receipt before sending another turn.");
    if (!api.retryFailedSessionTurn) throw new Error("Failed Turn retry is unavailable.");
    this.uncertainRetries.set(sessionId, request);
    try {
      const result = await api.retryFailedSessionTurn(sessionId, request);
      if (result.state === "rejected") {
        this.uncertainRetries.delete(sessionId);
        throw new Error(result.reason);
      }
      return this.acknowledgeFailedRetry(sessionId, request, result);
    } catch (error) {
      if (!this.uncertainRetries.has(sessionId)) throw error;
      try {
        const receipt = await api.getSessionTurnQueueReceipt(sessionId, request.clientRequestId);
        if (receipt) return this.acknowledgeFailedRetry(sessionId, request, receipt);
      } catch { /* Keep the original request identity until its outcome is known. */ }
      throw new Error("Retry acceptance could not be confirmed. Check Receipt before sending another turn.", { cause: error });
    }
  }

  private acknowledgeFailedRetry(sessionId: string, request: import("../../../src-shared/session/session-turn-queue.js").RetryFailedSessionTurnRequest, receipt: SessionTurnQueueReceipt) {
    if (receipt.sessionId !== sessionId || receipt.incarnationId !== request.target.incarnationId || receipt.requestId !== request.clientRequestId
      || receipt.accepted?.retrySource?.receiptId !== request.receiptId || receipt.accepted.retrySource.turnId !== request.turnId) throw new Error("Queue receipt does not match the failed Turn retry.");
    this.uncertainRetries.delete(sessionId);
    return receipt;
  }

  private acknowledge(sessionId: string, captured: Capture, registry: ComposerControllerRegistry, receipt: SessionTurnQueueReceipt) {
    if (receipt.sessionId !== sessionId || receipt.requestId !== captured.request.clientRequestId || receipt.incarnationId !== captured.request.incarnationId) throw new Error("Queue receipt does not match the submitted request.");
    this.uncertain.delete(sessionId);
    this.submissions.accept(receipt);
    if (captured.clearDraft) registry.clearIfRevision(captured.owner, captured.revision);
    return receipt;
  }

  async submit(api: AcceptanceApi, sessionId: string, captured: Capture, registry: ComposerControllerRegistry): Promise<SessionTurnQueueReceipt> {
    if (this.hasUncertain(sessionId)) throw new Error("A previous turn's acceptance is unknown. Check Receipt before sending another turn.");
    this.uncertain.set(sessionId, captured);
    let result;
    try {
      result = await this.enqueue(api, sessionId, captured);
    } catch (error) {
      try {
        const receipt = await api.getSessionTurnQueueReceipt(sessionId, captured.request.clientRequestId!);
        if (receipt) return this.acknowledge(sessionId, captured, registry, receipt);
        // Absence does not prove a disconnected enqueue cannot still commit.
      } catch {
        throw new Error("Turn acceptance could not be confirmed. Your draft is preserved. Check Receipt before sending another turn.", { cause: error });
      }
      throw new Error("Turn acceptance could not be confirmed. Your draft is preserved. Check Receipt or retry the original turn.", { cause: error });
    }
    if (result.state === "rejected") {
      this.uncertain.delete(sessionId);
      this.submissions.fail(captured.request.clientRequestId!, result.reason);
      throw new Error(result.reason);
    }
    return this.acknowledge(sessionId, captured, registry, result);
  }

  async check(api: AcceptanceApi, sessionId: string, registry: ComposerControllerRegistry): Promise<SessionTurnQueueReceipt | null> {
    const retry = this.uncertainRetries.get(sessionId);
    if (retry) {
      const receipt = await api.getSessionTurnQueueReceipt(sessionId, retry.clientRequestId);
      return receipt ? this.acknowledgeFailedRetry(sessionId, retry, receipt) : null;
    }
    const captured = this.uncertain.get(sessionId);
    if (!captured) return null;
    const receipt = await api.getSessionTurnQueueReceipt(sessionId, captured.request.clientRequestId!);
    if (receipt) return this.acknowledge(sessionId, captured, registry, receipt);
    return null;
  }

  async retry(api: AcceptanceApi, sessionId: string, registry: ComposerControllerRegistry): Promise<SessionTurnQueueReceipt | null> {
    const retry = this.uncertainRetries.get(sessionId);
    if (retry) {
      if (!api.retryFailedSessionTurn) throw new Error("Failed Turn retry is unavailable.");
      const result = await api.retryFailedSessionTurn(sessionId, retry);
      if (result.state === "rejected") {
        this.uncertainRetries.delete(sessionId);
        throw new Error(result.reason);
      }
      return this.acknowledgeFailedRetry(sessionId, retry, result);
    }
    const captured = this.uncertain.get(sessionId);
    if (!captured) return null;
    await captured.auxiliaryDraftOwner?.flush();
    const result = await this.enqueue(api, sessionId, captured);
    if (result.state === "rejected") {
      this.uncertain.delete(sessionId);
      this.submissions.fail(captured.request.clientRequestId!, result.reason);
      throw new Error(result.reason);
    }
    return this.acknowledge(sessionId, captured, registry, result);
  }

  private enqueue(api: AcceptanceApi, sessionId: string, captured: Capture) {
    const enqueue = () => api.enqueueSessionTurn(sessionId, captured.request);
    return captured.auxiliaryDraftOwner ? captured.auxiliaryDraftOwner.withDraftConsumption(enqueue) : enqueue();
  }
}

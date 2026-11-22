import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { RunSessionTurnRequest } from "../../../src-shared/session/runtime-state.js";
import type { RetryFailedSessionTurnRequest, SessionTurnQueueAcceptanceResult, SessionTurnQueueReceipt } from "../../../src-shared/session/session-turn-queue.js";
import type { ComposerControllerRegistry, ComposerOwner } from "../composer-controller.js";
import type { AuxiliaryDraftPersistenceOwner } from "../auxiliary-draft-persistence-owner.js";
import { SessionTurnSubmissions } from "./session-turn-submissions.js";

type AcceptanceApi = Pick<WithMateWindowApi, "enqueueSessionTurn" | "getSessionTurnQueueReceipt"> & Partial<Pick<WithMateWindowApi, "retryFailedSessionTurn">>;
type Capture = { request: RunSessionTurnRequest & { incarnationId: string }; owner: ComposerOwner; revision: number; clearDraft: boolean; auxiliaryDraftOwner?: AuxiliaryDraftPersistenceOwner };
type Submission = { kind: "send"; capture: Capture } | { kind: "resend"; request: RetryFailedSessionTurnRequest };
type Acceptance = Submission & { phase: "pending" | "unknown"; observedReceipt?: SessionTurnQueueReceipt };
type ResendRecoveryRejection = { phase: "rejected"; incarnationId: string; reason: string };

/** Retain the original capture until acceptance or rejection is known. */
export class SessionTurnAcceptance {
  readonly submissions = new SessionTurnSubmissions();
  private readonly requests = new Map<string, Acceptance | ResendRecoveryRejection>();

  hasUncertain(sessionId: string, incarnationId?: string): boolean {
    return this.find(sessionId, incarnationId)?.phase === "unknown";
  }

  resendRecoveryError(sessionId: string, incarnationId: string): string {
    const entry = this.find(sessionId, incarnationId);
    return entry?.phase === "rejected" ? entry.reason : "";
  }

  observeReceipt(receipt: SessionTurnQueueReceipt, registry: ComposerControllerRegistry): boolean {
    const entry = this.find(receipt.sessionId, receipt.incarnationId);
    if (!entry || entry.phase === "rejected" || !this.matchesReceipt(receipt.sessionId, entry, receipt)) return false;
    entry.observedReceipt = receipt;
    if (entry.phase !== "unknown") return false;
    this.settle(receipt.sessionId, entry, receipt, registry);
    return true;
  }

  private find(sessionId: string, incarnationId?: string) {
    const entry = this.requests.get(sessionId);
    return entry && (incarnationId === undefined || (entry.phase === "rejected" ? entry.incarnationId : this.incarnation(entry)) === incarnationId) ? entry : undefined;
  }

  private incarnation(submission: Submission) {
    return submission.kind === "send" ? submission.capture.request.incarnationId : submission.request.target.incarnationId;
  }

  async submitFailedRetry(api: AcceptanceApi, sessionId: string, request: RetryFailedSessionTurnRequest): Promise<SessionTurnQueueReceipt> {
    if (!api.retryFailedSessionTurn) throw new Error("Failed Turn retry is unavailable.");
    return this.submitOriginal(api, sessionId, { kind: "resend", request });
  }

  async submit(api: AcceptanceApi, sessionId: string, capture: Capture, registry: ComposerControllerRegistry): Promise<SessionTurnQueueReceipt> {
    return this.submitOriginal(api, sessionId, { kind: "send", capture }, registry);
  }

  private async submitOriginal(api: AcceptanceApi, sessionId: string, submission: Submission, registry?: ComposerControllerRegistry) {
    const existing = this.find(sessionId, this.incarnation(submission));
    if (existing?.phase === "unknown") throw new Error("A previous turn's acceptance is unknown. Check Receipt before sending another turn.");
    if (existing?.phase === "pending") throw new Error("Another submission is in progress.");
    const entry: Acceptance = { ...submission, phase: "pending" };
    this.requests.set(sessionId, entry);
    let result;
    try {
      result = await this.enqueue(api, sessionId, submission);
      if (result.state !== "rejected") this.validateReceipt(sessionId, submission, result);
    } catch (error) {
      let receipt;
      try {
        receipt = await this.lookup(api, sessionId, submission);
      } catch { /* Absence or failure cannot prove that a disconnected enqueue did not commit. */ }
      const accepted = receipt ?? entry.observedReceipt;
      if (accepted) return this.settle(sessionId, entry, accepted, registry);
      entry.phase = "unknown";
      throw new Error("Turn acceptance could not be confirmed. Your draft is preserved. Check Receipt or retry the original turn.", { cause: error });
    }
    return this.settle(sessionId, entry, result.state === "rejected" ? entry.observedReceipt ?? result : result, registry);
  }

  async check(api: AcceptanceApi, sessionId: string, registry: ComposerControllerRegistry, incarnationId?: string): Promise<SessionTurnQueueReceipt | null> {
    const submission = this.find(sessionId, incarnationId);
    if (submission?.phase !== "unknown") return null;
    const receipt = await this.lookup(api, sessionId, submission).catch((error) => {
      if (submission.observedReceipt) return submission.observedReceipt;
      throw error;
    }) ?? submission.observedReceipt;
    return receipt ? this.settle(sessionId, submission, receipt, registry) : null;
  }

  async retry(api: AcceptanceApi, sessionId: string, registry: ComposerControllerRegistry, incarnationId?: string): Promise<SessionTurnQueueReceipt | null> {
    const submission = this.find(sessionId, incarnationId);
    if (submission?.phase !== "unknown") return null;
    let result: SessionTurnQueueAcceptanceResult;
    try {
      if (submission.kind === "send") await submission.capture.auxiliaryDraftOwner?.flush();
      if (submission.observedReceipt) return submission.observedReceipt;
      result = await this.enqueue(api, sessionId, submission);
      if (result.state === "rejected") {
        // Same-ID retry preflight checks under the intake lock, but an identity conflict
        // is also a rejection. Confirm there is no other receipt before releasing the capture.
        result = await this.lookup(api, sessionId, submission) ?? submission.observedReceipt ?? result;
      } else {
        this.validateReceipt(sessionId, submission, result);
      }
    } catch (error) {
      if (submission.observedReceipt) return submission.observedReceipt;
      throw error;
    }
    return this.settle(sessionId, submission, result, registry, true);
  }

  private async lookup(api: AcceptanceApi, sessionId: string, submission: Submission) {
    const requestId = submission.kind === "send" ? submission.capture.request.clientRequestId! : submission.request.clientRequestId;
    const receipt = await api.getSessionTurnQueueReceipt(sessionId, requestId);
    if (receipt) this.validateReceipt(sessionId, submission, receipt);
    return receipt;
  }

  private validateReceipt(sessionId: string, submission: Submission, receipt: SessionTurnQueueReceipt) {
    if (!this.matchesReceipt(sessionId, submission, receipt)) throw new Error("Queue receipt does not match the submitted request.");
  }

  private matchesReceipt(sessionId: string, submission: Submission, receipt: SessionTurnQueueReceipt) {
    const requestId = submission.kind === "send" ? submission.capture.request.clientRequestId : submission.request.clientRequestId;
    if (receipt.sessionId !== sessionId || receipt.requestId !== requestId || receipt.incarnationId !== this.incarnation(submission)
      || (receipt.accepted?.origin && receipt.accepted.origin.kind !== "gui")) return false;
    if (submission.kind === "resend") {
      const source = receipt.accepted?.retrySource;
      return source?.receiptId === submission.request.receiptId && source.turnId === submission.request.turnId;
    }
    if (!receipt.accepted) return true;
    const original = submission.capture.request;
    const accepted = receipt.accepted.request;
    return !receipt.accepted.retrySource && accepted.userMessage === original.userMessage.trim()
      && accepted.submitSource === original.submitSource
      && accepted.auxiliaryDraftIncarnation === original.auxiliaryDraftIncarnation
      && accepted.auxiliaryDraftDurableRevision === original.auxiliaryDraftDurableRevision;
  }

  private settle(sessionId: string, submission: Acceptance, result: SessionTurnQueueAcceptanceResult, registry?: ComposerControllerRegistry, recovering = false) {
    const isCurrent = this.requests.get(sessionId) === submission;
    if (isCurrent) this.requests.delete(sessionId);
    if (result.state === "rejected") {
      if (isCurrent) {
        if (submission.kind === "send") this.submissions.fail(submission.capture.request.clientRequestId!, result.reason);
        else if (recovering) this.requests.set(sessionId, { phase: "rejected", incarnationId: this.incarnation(submission), reason: result.reason });
      }
      throw new Error(result.reason);
    }
    if (isCurrent && submission.kind === "send") {
      const { owner, revision, clearDraft } = submission.capture;
      this.submissions.accept(result);
      if (clearDraft) registry?.clearIfRevision(owner, revision);
    }
    return result;
  }

  private enqueue(api: AcceptanceApi, sessionId: string, submission: Submission) {
    if (submission.kind === "resend") {
      if (!api.retryFailedSessionTurn) throw new Error("Failed Turn retry is unavailable.");
      return api.retryFailedSessionTurn(sessionId, submission.request);
    }
    const captured = submission.capture;
    const enqueue = () => api.enqueueSessionTurn(sessionId, captured.request);
    return captured.auxiliaryDraftOwner ? captured.auxiliaryDraftOwner.withDraftConsumption(enqueue) : enqueue();
  }
}

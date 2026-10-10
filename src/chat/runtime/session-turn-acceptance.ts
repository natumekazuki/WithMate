import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { RunSessionTurnRequest } from "../../../src-shared/session/runtime-state.js";
import type { SessionTurnQueueReceipt } from "../../../src-shared/session/session-turn-queue.js";
import type { ComposerControllerRegistry, ComposerOwner } from "../composer-controller.js";

type AcceptanceApi = Pick<WithMateWindowApi, "enqueueSessionTurn" | "getSessionTurnQueueReceipt">;
type Capture = { request: RunSessionTurnRequest & { incarnationId: string }; owner: ComposerOwner; revision: number; clearDraft: boolean };

/** Window-local uncertain requests are retained until the original identity is resolved. */
export class SessionTurnAcceptance {
  private readonly uncertain = new Map<string, Capture>();

  hasUncertain(sessionId: string): boolean { return this.uncertain.has(sessionId); }

  private acknowledge(sessionId: string, captured: Capture, registry: ComposerControllerRegistry, receipt: SessionTurnQueueReceipt) {
    if (receipt.requestId !== captured.request.clientRequestId || receipt.incarnationId !== captured.request.incarnationId) throw new Error("Queue receipt does not match the submitted request.");
    this.uncertain.delete(sessionId);
    if (captured.clearDraft) registry.clearIfRevision(captured.owner, captured.revision);
    return receipt;
  }

  async submit(api: AcceptanceApi, sessionId: string, captured: Capture, registry: ComposerControllerRegistry): Promise<SessionTurnQueueReceipt> {
    if (this.uncertain.has(sessionId)) throw new Error("A previous turn's acceptance is unknown. Check Receipt before sending another turn.");
    this.uncertain.set(sessionId, captured);
    let result;
    try {
      result = await api.enqueueSessionTurn(sessionId, captured.request);
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
      throw new Error(result.reason);
    }
    return this.acknowledge(sessionId, captured, registry, result);
  }

  async check(api: AcceptanceApi, sessionId: string, registry: ComposerControllerRegistry): Promise<SessionTurnQueueReceipt | null> {
    const captured = this.uncertain.get(sessionId);
    if (!captured) return null;
    const receipt = await api.getSessionTurnQueueReceipt(sessionId, captured.request.clientRequestId!);
    if (receipt) return this.acknowledge(sessionId, captured, registry, receipt);
    return null;
  }

  async retry(api: AcceptanceApi, sessionId: string, registry: ComposerControllerRegistry): Promise<SessionTurnQueueReceipt | null> {
    const captured = this.uncertain.get(sessionId);
    if (!captured) return null;
    const result = await api.enqueueSessionTurn(sessionId, captured.request);
    if (result.state === "rejected") {
      this.uncertain.delete(sessionId);
      throw new Error(result.reason);
    }
    return this.acknowledge(sessionId, captured, registry, result);
  }
}

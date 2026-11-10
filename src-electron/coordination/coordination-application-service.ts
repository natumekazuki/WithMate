import { coordinationRequestSchema, type CoordinationActor, type CoordinationIdentity, type CoordinationRecord, type CoordinationRequest, type CoordinationResult, type CoordinationStore } from "../../src-shared/coordination/coordination-contract.js";
import type { SessionTurnQueueCapturedInput, SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";
import { assertRuntimeTurnAdmission, runWithoutRuntimeTurnAdmission } from "../platform/memory/runtime-turn-admission.js";
import { CoordinationRejectedError, isCoordinationDeletedError } from "./coordination-errors.js";

export type CoordinationApplicationDeps = {
  getStore(): CoordinationStore;
  prepareDelivery(target: CoordinationIdentity, operationId: string, actor: CoordinationActor): Promise<SessionTurnQueueCapturedInput>;
  onAccepted?(receipt: SessionTurnQueueReceipt): void;
  onNotificationError?(error: unknown): void;
};
export class CoordinationApplicationService {
  private readonly listeners = new Set<(record: CoordinationRecord) => void>();
  constructor(private readonly deps: CoordinationApplicationDeps) {}
  subscribe(listener: (record: CoordinationRecord) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  executeAgent(actor: CoordinationIdentity & { turnId: string }, request: CoordinationRequest, guard: () => boolean = () => true) { return this.execute(actor, request, guard); }
  executeUser(request: CoordinationRequest, guard: () => boolean) { return this.execute({ kind: "user" }, request, guard); }
  read(actor: CoordinationIdentity, request: CoordinationRequest, guard: () => boolean = () => true) {
    if (request.operation !== "list" && request.operation !== "get") throw new Error("Coordination read cannot mutate state.");
    return this.execute({ ...actor, turnId: "" }, request, guard);
  }
  private async execute(actor: CoordinationActor, value: CoordinationRequest, guard: () => boolean): Promise<CoordinationResult> {
    const request = coordinationRequestSchema.parse(value);
    const store = this.deps.getStore();
    const check = () => { assertRuntimeTurnAdmission(); if (!guard() || store !== this.deps.getStore()) throw new Error("Coordination authority changed."); };
    check();
    let target: CoordinationIdentity | null;
    let captured: SessionTurnQueueCapturedInput | null;
    try {
      target = await store.deliveryTarget({ actor, request });
      captured = target && "operationId" in request ? await this.deps.prepareDelivery(target, request.operationId, actor) : null;
    } catch (error) { if (isCoordinationDeletedError(error)) throw error; throw new CoordinationRejectedError(error instanceof Error ? error.message : String(error)); }
    check();
    const stored = await store.execute({ actor, request, ...(target && captured ? { delivery: { target, captured } } : {}) });
    const { queueUpdates = [], ...result } = stored;
    // A saved operation stays saved even if a window notification cannot be delivered.
    for (const receipt of queueUpdates) { try { runWithoutRuntimeTurnAdmission(() => this.deps.onAccepted?.(receipt)); } catch (error) { this.deps.onNotificationError?.(error); } }
    if ("receipt" in result && result.receipt) { try { const receipt = result.receipt; runWithoutRuntimeTurnAdmission(() => this.deps.onAccepted?.(receipt)); } catch (error) { this.deps.onNotificationError?.(error); } }
    if ("record" in result && (request.operation !== "get" || (actor.kind !== "user" && actor.kind === result.record.initiator.kind && actor.sessionId === result.record.initiator.sessionId && actor.incarnationId === result.record.initiator.incarnationId && result.record.answers.length > 0))) for (const listener of this.listeners) { try { listener(result.record); } catch (error) { this.deps.onNotificationError?.(error); } }
    return result;
  }
}

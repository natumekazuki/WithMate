import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { coordinationRequestSchema, type CoordinationActor, type CoordinationIdentity, type CoordinationRecord, type CoordinationResult, type CoordinationStorageInput } from "../../src-shared/coordination/coordination-contract.js";
import { SessionTurnQueueStorageV6 } from "../session/session-turn-queue-storage-v6.js";
import { openAppDatabase } from "../storage/sqlite-connection.js";
import { ensureCoordinationSchemaV7 } from "./coordination-schema-v7.js";
import { assertSessionLifecycleReady } from "../session/session-lifecycle-operation.js";
import { assertRuntimeTurnAdmission } from "../platform/memory/runtime-turn-admission.js";
import { CoordinationDeletedError, CoordinationRejectedError } from "./coordination-errors.js";

const same = (a: { kind: string; sessionId?: string; incarnationId?: string }, b: { kind: string; sessionId?: string; incarnationId?: string }) => a.kind === b.kind && a.sessionId === b.sessionId && a.incarnationId === b.incarnationId;
type Saved = { payload_json: string };

export class CoordinationStorageV7 {
  private readonly db: DatabaseSync;
  private readonly queue: SessionTurnQueueStorageV6;
  constructor(dbPath: string) { this.db = openAppDatabase(dbPath); ensureCoordinationSchemaV7(this.db); this.queue = new SessionTurnQueueStorageV6(this.db); }
  close() { this.db.close(); }
  deliveryTarget(input: Omit<CoordinationStorageInput, "delivery">): CoordinationIdentity | null {
    const request = coordinationRequestSchema.parse(input.request);
    if (input.actor.kind !== "user") this.identity(input.actor);
    if ("operationId" in request && this.db.prepare("SELECT 1 FROM coordination_records_v7, json_each(payload_json,'$.history') AS history WHERE json_extract(history.value,'$.operationId')=? LIMIT 1").get(request.operationId)) return null;
    if (request.operation === "create" && request.deliver) {
      if (input.actor.kind === "user") throw new Error("Only an Agent can originate Coordination.");
      const respondent = request.respondent ?? this.caller(input.actor).caller;
      return respondent?.kind !== "user" ? respondent ?? null : null;
    }
    if (request.operation === "answer" && request.send) return this.get(request.id).initiator;
    if (request.operation === "deliver") { const respondent = this.get(request.id).respondent; return respondent.kind === "user" ? null : respondent; }
    return null;
  }
  execute(input: CoordinationStorageInput): CoordinationResult {
    const request = coordinationRequestSchema.parse(input.request);
    this.db.exec("BEGIN IMMEDIATE");
    let committing = false;
    try {
      assertRuntimeTurnAdmission();
      if (input.actor.kind !== "user") this.identity(input.actor, request.operation !== "list" && request.operation !== "get" ? input.actor.turnId : undefined);
      const result = this.apply({ ...input, request });
      assertRuntimeTurnAdmission();
      committing = true;
      this.db.exec("COMMIT"); return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (committing) throw error;
      if (error instanceof CoordinationDeletedError) throw error;
      throw new CoordinationRejectedError(error instanceof Error ? error.message : String(error));
    }
  }
  private identity(identity: CoordinationIdentity, turnId?: string): { mainId: string; rootId: string } {
    const auxiliary = identity.kind === "auxiliary" ? this.db.prepare("SELECT parent_session_id FROM auxiliary_sessions WHERE id=? AND created_at=?").get(identity.sessionId, identity.incarnationId) as { parent_session_id: string } | undefined : undefined;
    const mainId = auxiliary?.parent_session_id ?? identity.sessionId;
    if (identity.kind === "auxiliary" && !auxiliary) throw new Error("Coordination Auxiliary identity is unavailable.");
    const main = this.db.prepare(`SELECT id,root_session_id FROM sessions_v6 WHERE id=? ${identity.kind === "main" ? "AND incarnation_id=?" : ""}`).get(...(identity.kind === "main" ? [mainId, identity.incarnationId] : [mainId])) as { id: string; root_session_id: string | null } | undefined;
    if (!main) throw new Error("Coordination Session was deleted or replaced.");
    assertSessionLifecycleReady(this.db, mainId);
    if (turnId && !this.db.prepare(`SELECT 1 FROM session_turns_v6 WHERE id=? AND ${identity.kind === "main" ? "session_id=? AND auxiliary_session_id IS NULL" : "auxiliary_session_id=? AND session_id IS NULL"}`).get(turnId, identity.sessionId)) throw new Error("Coordination actor Turn does not belong to this Session.");
    return { mainId, rootId: main.root_session_id ?? main.id };
  }
  private get(id: string): CoordinationRecord {
    const row = this.db.prepare("SELECT payload_json FROM coordination_records_v7 WHERE id=?").get(id) as Saved | undefined;
    if (!row) throw new CoordinationDeletedError("Coordination was deleted or does not exist.");
    return JSON.parse(row.payload_json) as CoordinationRecord;
  }
  private caller(actor: CoordinationIdentity & { turnId: string }): { caller: CoordinationIdentity | null; receiptId: string | null } {
    const origin = this.db.prepare(`SELECT id,accepted_json FROM session_turn_queue_v6 WHERE turn_id=? AND COALESCE(auxiliary_session_id,session_id)=? AND incarnation_id=? ORDER BY sequence LIMIT 1`).get(actor.turnId, actor.sessionId, actor.incarnationId) as { id: string; accepted_json: string | null } | undefined;
    const saved = origin?.accepted_json ? JSON.parse(origin.accepted_json).origin as { kind: string; actorSessionId?: string; actorIncarnationId?: string; actorKind?: "main" | "auxiliary" } | undefined : undefined;
    let caller: CoordinationIdentity | null = null;
    if (saved?.kind === "session" && saved.actorSessionId && saved.actorIncarnationId) {
      if (!saved.actorKind) throw new Error("The original request's exact caller kind is unavailable.");
      const kind = saved.actorKind;
      caller = { kind, sessionId: saved.actorSessionId, incarnationId: saved.actorIncarnationId }; this.identity(caller);
    }
    return { caller, receiptId: origin?.id ?? null };
  }
  private save(record: CoordinationRecord): void {
    this.db.prepare(`INSERT INTO coordination_records_v7 VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET respondent_session_id=excluded.respondent_session_id,respondent_kind=excluded.respondent_kind,state=excluded.state,payload_json=excluded.payload_json`)
      .run(record.id, record.crewRootSessionId, record.initiator.sessionId, record.initiator.kind, record.initiator.incarnationId, record.respondent.kind === "user" ? null : record.respondent.sessionId, record.respondent.kind, record.state, JSON.stringify(record));
  }
  private apply(input: CoordinationStorageInput): CoordinationResult {
    const { actor, request } = input;
    if (request.operation === "list") {
      const clauses: string[] = [], args: (string | number)[] = [];
      const root = request.crewRootSessionId ?? input.defaultCrewRootSessionId ?? (actor.kind === "user" ? undefined : this.identity(actor).rootId);
      if (request.mainSessionId && !this.db.prepare("SELECT 1 FROM sessions_v6 WHERE id=?").get(request.mainSessionId)) throw new CoordinationDeletedError("The Coordination Main Session was deleted or does not exist.");
      if (!request.allCrews && root && !this.db.prepare("SELECT 1 FROM sessions_v6 WHERE id=?").get(root)) throw new CoordinationDeletedError("The Coordination Crew was deleted or does not exist.");
      if (!request.allCrews) { if (!root && !request.userPending) throw new Error("A Coordination Crew is required."); if (root) { clauses.push("crew_root_session_id=?"); args.push(root); } }
      if (request.sessionId) { clauses.push("(initiator_session_id=? OR respondent_session_id=?)"); args.push(request.sessionId, request.sessionId); }
      if (request.mainSessionId) {
        clauses.push(`((initiator_kind='main' AND initiator_session_id=?) OR (respondent_kind='main' AND respondent_session_id=?) OR (initiator_kind='auxiliary' AND initiator_session_id IN (SELECT id FROM auxiliary_sessions WHERE parent_session_id=?)) OR (respondent_kind='auxiliary' AND respondent_session_id IN (SELECT id FROM auxiliary_sessions WHERE parent_session_id=?)))`);
        args.push(request.mainSessionId, request.mainSessionId, request.mainSessionId, request.mainSessionId);
      }
      if (request.userPending) clauses.push("state='open' AND respondent_kind='user'");
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const total = (this.db.prepare(`SELECT count(*) AS n FROM coordination_records_v7 ${where}`).get(...args) as { n: number }).n;
      const rows = this.db.prepare(`SELECT json_set(json_remove(payload_json,'$.body','$.choices','$.answers','$.history'),'$.bodyPreview',substr(json_extract(payload_json,'$.body'),1,180)) AS payload_json FROM coordination_records_v7 ${where} ORDER BY id LIMIT ? OFFSET ?`).all(...args, request.limit, request.offset) as Saved[];
      return { items: rows.map(row => { const summary = JSON.parse(row.payload_json) as Omit<CoordinationRecord, "body" | "choices" | "answers" | "history"> & { bodyPreview: string }; return { ...summary, initiatorMainSessionId: this.identity(summary.initiator).mainId }; }), total, nextOffset: request.offset + rows.length < total ? request.offset + rows.length : null };
    }
    if (request.operation === "get") {
      const record = this.get(request.id);
      const identity = record.initiator;
      if (identity.kind === "main") return { record, initiatorTarget: { ...identity, kind: "main" } };
      const { mainId } = this.identity(identity);
      const main = this.db.prepare("SELECT incarnation_id FROM sessions_v6 WHERE id=?").get(mainId) as { incarnation_id: string };
      return { record, initiatorTarget: { ...identity, kind: "auxiliary", mainSessionId: mainId, mainIncarnationId: main.incarnation_id } };
    }
    const now = new Date().toISOString();
    // Retry identity lives with the record's required operation history, not a second execution ledger.
    const existing = this.db.prepare("SELECT payload_json FROM coordination_records_v7 WHERE EXISTS(SELECT 1 FROM json_each(payload_json,'$.history') AS history WHERE json_extract(history.value,'$.operationId')=?)").all(request.operationId) as Saved[];
    for (const row of existing) {
      const record = JSON.parse(row.payload_json) as CoordinationRecord;
      const history = record.history.find(event => event.operationId === request.operationId);
      if (!history) continue;
      const persisted = (history as typeof history & { request?: unknown }).request;
      if (JSON.stringify(persisted) !== JSON.stringify(request) || !same(history.actor, actor) || (history.actor.kind !== "user" && actor.kind !== "user" && history.actor.turnId !== actor.turnId)) throw new Error("Coordination operation identity reused with different input or actor.");
      const target = (history as typeof history & { deliveryTarget?: CoordinationIdentity }).deliveryTarget;
      return { record, ...(target && history.receiptId ? { receipt: this.queue.getReceiptById(target, history.receiptId)! } : {}) };
    }
    let record: CoordinationRecord;
    if (request.operation === "create") {
      if (actor.kind === "user") throw new Error("Only an Agent can originate Coordination.");
      const { caller, receiptId } = this.caller(actor);
      const respondent = request.respondent ?? caller ?? { kind: "user" as const };
      if (respondent.kind !== "user" && (!caller || !same(respondent, caller))) throw new Error("Coordination respondent must be the saved actual caller.");
      record = { id: request.operationId, crewRootSessionId: this.identity(actor).rootId, kind: request.kind, initiator: { kind: actor.kind, sessionId: actor.sessionId, incarnationId: actor.incarnationId }, initiatorTurnId: actor.turnId, originReceiptId: receiptId, caller, body: request.body, choices: request.choices, respondent, state: ["escalation", "user_decision_required", "blocker"].includes(request.kind) ? "open" : "resolved", answerRevision: 0, answers: [], history: [], createdAt: now, updatedAt: now };
    } else record = this.get(request.id);
    this.identity(record.initiator);
    const initiator = actor.kind === "user" || same(actor, record.initiator);
    const respondent = same(actor, record.respondent);
    let deliveryTarget: CoordinationIdentity | undefined;
    let answer: CoordinationRecord["answers"][number] | undefined;
    if (request.operation === "create" && request.deliver && record.respondent.kind !== "user") deliveryTarget = record.respondent;
    if (request.operation === "deliver") { if (!initiator) throw new Error("Only the initiator may deliver Coordination."); if (record.respondent.kind !== "user") deliveryTarget = record.respondent; }
    if (request.operation === "escalate") { if (!respondent || actor.kind === "user") throw new Error("Only the assigned Agent can escalate Coordination."); record.respondent = { kind: "user" }; }
    if (request.operation === "answer") {
      if (!respondent) throw new Error("Only the assigned respondent can answer Coordination.");
      if (record.answerRevision !== request.expectedAnswerRevision) throw new Error("Coordination answer revision conflict.");
      if (request.selectedChoices.some(choice => !record.choices.includes(choice))) throw new Error("Unknown Coordination answer choice.");
      answer = { id: request.operationId, revision: ++record.answerRevision, actor, body: request.body, selectedChoices: request.selectedChoices, createdAt: now };
      record.answers.push(answer); if (request.send) deliveryTarget = record.initiator;
    }
    if (["withdraw", "resolve", "consume", "correct"].includes(request.operation) && !initiator) throw new Error("Only the originating Agent or real user can change this Coordination.");
    if (request.operation === "withdraw") { record.state = "withdrawn"; record.withdrawalReason = request.reason; }
    if (request.operation === "resolve") record.state = "resolved";
    if (request.operation === "consume") {
      if (actor.kind === "user") throw new Error("Only the originating Agent can consume answers.");
      const value = record.answers.find(item => item.id === request.answerId && item.revision === request.answerRevision);
      if (!value || request.answerRevision !== record.answerRevision || value.consumedByOperationId) throw new Error("Coordination answer is stale or already consumed.");
      value.consumedByOperationId = request.operationId;
    }
    let correctionId: string | undefined;
    if (request.operation === "correct") {
      correctionId = randomUUID(); record.state = "corrected";
      this.save({ ...record, id: correctionId, kind: "correction", body: request.body, state: "resolved", answers: [], answerRevision: 0, history: [], createdAt: now, updatedAt: now });
    }
    let receipt;
    if (deliveryTarget) {
      this.identity(deliveryTarget);
      if (!input.delivery || !same(input.delivery.target, deliveryTarget) || input.delivery.captured.request.clientRequestId !== request.operationId) throw new Error("Coordination delivery input is unavailable or target changed.");
      const notification = JSON.stringify({ coordinationId: record.id, kind: record.kind, consultation: record.body, actor, operation: request.operation, answer: answer ?? null, state: record.state, withdrawalReason: record.withdrawalReason ?? null });
      const captured = { ...input.delivery.captured, attachments: [], request: { ...input.delivery.captured.request, userMessage: notification, submitSource: "retry" as const }, origin: { kind: actor.kind === "user" ? "gui" as const : "session" as const, ...(actor.kind !== "user" ? { actorKind: actor.kind, actorSessionId: actor.sessionId, actorIncarnationId: actor.incarnationId, actorTurnId: actor.turnId } : {}), operation: "send" as const, targetSessionId: deliveryTarget.sessionId, targetIncarnationId: deliveryTarget.incarnationId }, coordination: { id: record.id, operation: request.operation, actor, answerId: answer?.id, answerRevision: answer?.revision } };
      receipt = this.queue.enqueue(deliveryTarget, captured);
      if (answer) answer.receiptId = receipt.id;
    }
    const history = { operationId: request.operationId, operation: request.operation, actor, at: now, request, ...("body" in request ? { body: request.body } : {}), ...(receipt ? { receiptId: receipt.id, deliveryTarget } : {}), ...(correctionId ? { correctionId } : {}) };
    record.history.push(history); record.updatedAt = now; this.save(record);
    return { record, ...(receipt ? { receipt } : {}) };
  }
}

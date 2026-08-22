import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  COORDINATION_EVENT_PENDING_ANSWER_LIMIT,
  initialCoordinationEventState,
  type CoordinationEvent,
  type CoordinationEventAction,
  type CoordinationEventCorrectionResult,
  type CoordinationEventKind,
  type CoordinationEventListInput,
  type CoordinationEventListResult,
  type CoordinationEventTrustedListInput,
  type CoordinationEventOption,
  type CoordinationEventPayload,
  type CoordinationEventRoleSnapshot,
  type CoordinationEventState,
  type CoordinationEventSummary,
  type PendingCoordinationAnswer,
} from "../src/coordination-event.js";
import { ensureV6Schema } from "./database-schema-v6.js";
import { openAppDatabase } from "./sqlite-connection.js";

type EventRow = {
  sequence: number;
  id: string;
  actor_session_id: string;
  session_role: CoordinationEventRoleSnapshot["sessionRole"];
  role_contract_revision: 1;
  root_session_id: string;
  parent_session_id: string | null;
  delegation_depth: number;
  kind: CoordinationEventKind;
  summary: string;
  payload_json: string;
  execution_id: string | null;
  target_session_id: string | null;
  corrected_event_id: string | null;
  options_json: string;
  created_at: string;
  projected_state: CoordinationEventState;
};

type ActionRow = {
  sequence: number;
  action_type: CoordinationEventAction["type"];
  actor_type: CoordinationEventAction["actorType"];
  actor_session_id: string | null;
  option_id: string | null;
  note: string | null;
  related_event_id: string | null;
  created_at: string;
};

type IdempotencyRow = {
  operation: CoordinationMutationOperation;
  request_fingerprint: string;
  result_event_id: string;
  target_event_id: string | null;
};

export type CoordinationMutationOperation =
  | "coordination.event.create"
  | "coordination.event.resolve"
  | "coordination.event.consume"
  | "coordination.event.cancel"
  | "coordination.event.correct";

export type CoordinationMutationPrincipal = {
  sessionId: string;
  actorType: "session" | "trusted_gui";
  roleBinding: CoordinationEventRoleSnapshot;
};

export class CoordinationEventNotFoundError extends Error {
  readonly code = "COORDINATION_EVENT_NOT_FOUND";
  constructor() {
    super("The coordination event was not found.");
    this.name = "CoordinationEventNotFoundError";
  }
}

export class CoordinationEventStateConflictError extends Error {
  readonly code = "COORDINATION_EVENT_STATE_CONFLICT";
  constructor() {
    super("The coordination event cannot be changed in its current state.");
    this.name = "CoordinationEventStateConflictError";
  }
}

export class CoordinationEventIdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";
  constructor() {
    super("The idempotency key was reused with different input.");
    this.name = "CoordinationEventIdempotencyConflictError";
  }
}

export class CoordinationEventStorageV6 {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    ensureV6Schema(this.db);
  }

  close(): void {
    this.db.close();
  }

  create(input: {
    principal: CoordinationMutationPrincipal;
    kind: Exclude<CoordinationEventKind, "correction">;
    payload: CoordinationEventPayload;
    executionId: string | null;
    targetSessionId: string | null;
    options: CoordinationEventOption[];
    idempotencyKey: string;
    requestFingerprint: string;
    createdAt: string;
  }): { event: CoordinationEvent; replayed: boolean } {
    return this.transaction(() => {
      const replay = this.resolveReplay("coordination.event.create", input.principal.sessionId, input.idempotencyKey, input.requestFingerprint);
      if (replay) return { event: this.getRequired(replay.result_event_id), replayed: true };
      this.assertCanonicalBinding(input.principal);
      if (input.executionId) this.assertExecutionOwner(input.executionId, input.principal.sessionId);
      if (input.kind === "escalation") {
        this.assertAncestorTarget(input.principal, input.targetSessionId);
      }
      const eventId = `coordination-${randomUUID()}`;
      this.insertEvent({
        eventId,
        principal: input.principal,
        kind: input.kind,
        payload: input.payload,
        executionId: input.executionId,
        targetSessionId: input.targetSessionId,
        correctedEventId: null,
        options: input.options,
        createdAt: input.createdAt,
      });
      this.insertIdempotency("coordination.event.create", input.principal.sessionId, input.idempotencyKey, input.requestFingerprint, eventId, null, input.createdAt);
      return { event: this.getRequired(eventId), replayed: false };
    });
  }

  list(principal: CoordinationMutationPrincipal, input: CoordinationEventListInput, beforeSequence: number | null): CoordinationEventListResult {
    this.assertCanonicalBinding(principal);
    if (input.scope === "subtree" && principal.roleBinding.sessionRole !== "overall-coordinator" && principal.roleBinding.sessionRole !== "task-coordinator") {
      throw new CoordinationEventNotFoundError();
    }
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (input.scope === "self") {
      clauses.push("events.actor_session_id = ?");
      parameters.push(principal.sessionId);
    } else if (principal.roleBinding.sessionRole === "overall-coordinator") {
      clauses.push("events.root_session_id = ?");
      parameters.push(principal.roleBinding.rootSessionId);
    } else {
      clauses.push("(events.actor_session_id = ? OR events.parent_session_id = ?)");
      parameters.push(principal.sessionId, principal.sessionId);
    }
    return this.queryList(input, beforeSequence, clauses, parameters);
  }

  listTrusted(input: CoordinationEventTrustedListInput, beforeSequence: number | null): CoordinationEventListResult {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (input.sessionId) {
      clauses.push("events.actor_session_id = ?");
      parameters.push(input.sessionId);
    }
    return this.queryList(input, beforeSequence, clauses, parameters);
  }

  private queryList(
    input: Pick<CoordinationEventListInput, "kind" | "state" | "limit">,
    beforeSequence: number | null,
    clauses: string[],
    parameters: Array<string | number>,
  ): CoordinationEventListResult {
    if (beforeSequence !== null) {
      clauses.push("events.sequence < ?");
      parameters.push(beforeSequence);
    }
    if (input.kind) {
      clauses.push("events.kind = ?");
      parameters.push(input.kind);
    }
    if (input.state) {
      clauses.push(`${PROJECTED_STATE_SQL} = ?`);
      parameters.push(input.state);
    }
    parameters.push(input.limit + 1);
    const rows = this.db.prepare(`
      SELECT events.sequence, events.id, events.actor_session_id, events.session_role,
        events.kind, events.summary, events.created_at,
        ${PROJECTED_STATE_SQL} AS projected_state
      FROM coordination_events_v6 AS events
      ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY events.sequence DESC
      LIMIT ?
    `).all(...parameters) as Array<Pick<EventRow,
      "sequence" | "id" | "actor_session_id" | "session_role" | "kind" | "summary" | "created_at" | "projected_state">>;
    const items = rows.slice(0, input.limit).map(mapSummaryRow);
    return {
      items,
      ...(rows.length > input.limit && items.length > 0
        ? { nextCursor: String(items[items.length - 1]!.sequence) }
        : {}),
    };
  }

  getVisible(principal: CoordinationMutationPrincipal, eventId: string): CoordinationEvent {
    this.assertCanonicalBinding(principal);
    const event = this.getRequired(eventId);
    if (!canView(principal, event)) throw new CoordinationEventNotFoundError();
    return event;
  }

  getTrusted(eventId: string): CoordinationEvent {
    return this.getRequired(eventId);
  }

  getByIdempotencyKey(principal: CoordinationMutationPrincipal, key: string): CoordinationEvent {
    this.assertCanonicalBinding(principal);
    const row = this.db.prepare(`
      SELECT result_event_id
      FROM coordination_event_idempotency_v6
      WHERE principal_session_id = ? AND idempotency_key = ?
    `).get(principal.sessionId, key) as { result_event_id: string } | undefined;
    if (!row) throw new CoordinationEventNotFoundError();
    return this.getVisible(principal, row.result_event_id);
  }

  resolve(input: {
    principal: CoordinationMutationPrincipal;
    eventId: string;
    optionId: string | null;
    note: string | null;
    idempotencyKey: string;
    requestFingerprint: string;
    createdAt: string;
  }): { event: CoordinationEvent; replayed: boolean } {
    return this.transition("coordination.event.resolve", "resolved", input, (event) => {
      if (!canView(input.principal, event)) throw new CoordinationEventNotFoundError();
      if (event.kind === "escalation") {
        if (input.principal.actorType !== "session" || event.targetSessionId !== input.principal.sessionId || input.optionId) {
          throw new CoordinationEventNotFoundError();
        }
      } else if (event.kind === "blocker") {
        if (input.principal.actorType !== "session" || event.actorSessionId !== input.principal.sessionId || input.optionId) {
          throw new CoordinationEventNotFoundError();
        }
      } else if (event.kind === "user_decision_required") {
        const hasOption = input.optionId !== null;
        const hasNote = input.note !== null && input.note.trim().length > 0;
        const hasBeenConsumed = event.actions.some((action) => action.type === "consumed");
        if (input.principal.actorType !== "trusted_gui"
          || !canView(input.principal, event)
          || (input.note !== null && !hasNote)
          || hasOption === hasNote
          || (hasOption && !event.options.some((option) => option.id === input.optionId))) {
          throw new CoordinationEventNotFoundError();
        }
        if (event.state !== "open" && (event.state !== "resolved" || hasBeenConsumed)) {
          throw new CoordinationEventStateConflictError();
        }
      } else {
        throw new CoordinationEventStateConflictError();
      }
      if (event.kind !== "user_decision_required" && event.state !== "open") {
        throw new CoordinationEventStateConflictError();
      }
    });
  }

  listPendingAnswers(principal: CoordinationMutationPrincipal): PendingCoordinationAnswer[] {
    this.assertCanonicalBinding(principal);
    const rows = this.db.prepare(`
      SELECT events.id
      FROM coordination_events_v6 AS events
      WHERE events.actor_session_id = ?
        AND events.kind = 'user_decision_required'
        AND ${PROJECTED_STATE_SQL} = 'resolved'
        AND EXISTS (
          SELECT 1
          FROM coordination_event_actions_v6 AS resolved_actions
          WHERE resolved_actions.event_id = events.id
            AND resolved_actions.action_type = 'resolved'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM coordination_event_actions_v6 AS consumed_actions
          WHERE consumed_actions.event_id = events.id
            AND consumed_actions.action_type = 'consumed'
        )
      ORDER BY (
        SELECT MAX(resolved_actions.sequence)
        FROM coordination_event_actions_v6 AS resolved_actions
        WHERE resolved_actions.event_id = events.id
          AND resolved_actions.action_type = 'resolved'
      ) ASC
      LIMIT ?
    `).all(principal.sessionId, COORDINATION_EVENT_PENDING_ANSWER_LIMIT) as Array<{ id: string }>;
    return rows.map(({ id }) => toPendingAnswer(this.getRequired(id)));
  }

  consume(input: {
    principal: CoordinationMutationPrincipal;
    eventId: string;
    expectedResolutionSequence: number;
    idempotencyKey: string;
    requestFingerprint: string;
    createdAt: string;
  }): { event: CoordinationEvent; replayed: boolean } {
    return this.transaction(() => {
      const replay = this.resolveReplay(
        "coordination.event.consume",
        input.principal.sessionId,
        input.idempotencyKey,
        input.requestFingerprint,
      );
      if (replay) return { event: this.getRequired(replay.result_event_id), replayed: true };
      this.assertCanonicalBinding(input.principal);
      const event = this.getRequired(input.eventId);
      if (input.principal.actorType !== "session"
        || event.actorSessionId !== input.principal.sessionId
        || event.kind !== "user_decision_required") {
        throw new CoordinationEventNotFoundError();
      }
      if (event.state !== "resolved"
        || event.actions.some((action) => action.type === "consumed")) {
        throw new CoordinationEventStateConflictError();
      }
      const latestResolution = [...event.actions]
        .reverse()
        .find((action) => action.type === "resolved" && action.actorType === "trusted_gui");
      if (!latestResolution || latestResolution.sequence !== input.expectedResolutionSequence) {
        throw new CoordinationEventStateConflictError();
      }
      this.insertAction(input.eventId, "consumed", input.principal, null, null, null, input.createdAt);
      this.insertIdempotency(
        "coordination.event.consume",
        input.principal.sessionId,
        input.idempotencyKey,
        input.requestFingerprint,
        input.eventId,
        null,
        input.createdAt,
      );
      return { event: this.getRequired(input.eventId), replayed: false };
    });
  }

  cancel(input: {
    principal: CoordinationMutationPrincipal;
    eventId: string;
    optionId: null;
    note: string | null;
    idempotencyKey: string;
    requestFingerprint: string;
    createdAt: string;
  }): { event: CoordinationEvent; replayed: boolean } {
    return this.transition("coordination.event.cancel", "cancelled", input, (event) => {
      if (!canView(input.principal, event)) throw new CoordinationEventNotFoundError();
      if (input.principal.actorType === "session" && event.actorSessionId !== input.principal.sessionId) {
        throw new CoordinationEventNotFoundError();
      }
      if (input.principal.actorType === "trusted_gui" && !canView(input.principal, event)) {
        throw new CoordinationEventNotFoundError();
      }
      if (event.state !== "open") throw new CoordinationEventStateConflictError();
    });
  }

  correct(input: {
    principal: CoordinationMutationPrincipal;
    eventId: string;
    payload: CoordinationEventPayload;
    executionId: string | null;
    idempotencyKey: string;
    requestFingerprint: string;
    createdAt: string;
  }): { result: CoordinationEventCorrectionResult; replayed: boolean } {
    return this.transaction(() => {
      const replay = this.resolveReplay("coordination.event.correct", input.principal.sessionId, input.idempotencyKey, input.requestFingerprint);
      if (replay) {
        return {
          result: {
            correction: this.getRequired(replay.result_event_id),
            superseded: this.getRequired(replay.target_event_id ?? input.eventId),
          },
          replayed: true,
        };
      }
      this.assertCanonicalBinding(input.principal);
      const target = this.getRequired(input.eventId);
      if (input.principal.actorType !== "session" || target.actorSessionId !== input.principal.sessionId) {
        throw new CoordinationEventNotFoundError();
      }
      if (target.state === "superseded" || target.state === "cancelled") throw new CoordinationEventStateConflictError();
      if (input.executionId) this.assertExecutionOwner(input.executionId, input.principal.sessionId);
      const correctionId = `coordination-${randomUUID()}`;
      this.insertEvent({
        eventId: correctionId,
        principal: input.principal,
        kind: "correction",
        payload: input.payload,
        executionId: input.executionId,
        targetSessionId: null,
        correctedEventId: input.eventId,
        options: [],
        createdAt: input.createdAt,
      });
      this.insertAction(input.eventId, "superseded", input.principal, null, null, correctionId, input.createdAt);
      this.insertIdempotency("coordination.event.correct", input.principal.sessionId, input.idempotencyKey, input.requestFingerprint, correctionId, input.eventId, input.createdAt);
      return {
        result: { correction: this.getRequired(correctionId), superseded: this.getRequired(input.eventId) },
        replayed: false,
      };
    });
  }

  private transition(
    operation: "coordination.event.resolve" | "coordination.event.cancel",
    action: "resolved" | "cancelled",
    input: {
      principal: CoordinationMutationPrincipal;
      eventId: string;
      optionId: string | null;
      note: string | null;
      idempotencyKey: string;
      requestFingerprint: string;
      createdAt: string;
    },
    authorize: (event: CoordinationEvent) => void,
  ): { event: CoordinationEvent; replayed: boolean } {
    return this.transaction(() => {
      const replay = this.resolveReplay(operation, input.principal.sessionId, input.idempotencyKey, input.requestFingerprint);
      if (replay) return { event: this.getRequired(replay.result_event_id), replayed: true };
      this.assertCanonicalBinding(input.principal);
      const event = this.getRequired(input.eventId);
      authorize(event);
      this.insertAction(input.eventId, action, input.principal, input.optionId, input.note, null, input.createdAt);
      this.insertIdempotency(operation, input.principal.sessionId, input.idempotencyKey, input.requestFingerprint, input.eventId, null, input.createdAt);
      return { event: this.getRequired(input.eventId), replayed: false };
    });
  }

  private insertEvent(input: {
    eventId: string;
    principal: CoordinationMutationPrincipal;
    kind: CoordinationEventKind;
    payload: CoordinationEventPayload;
    executionId: string | null;
    targetSessionId: string | null;
    correctedEventId: string | null;
    options: CoordinationEventOption[];
    createdAt: string;
  }): void {
    const binding = input.principal.roleBinding;
    this.db.prepare(`
      INSERT INTO coordination_events_v6 (
        id, actor_session_id, session_role, role_contract_revision, root_session_id,
        parent_session_id, delegation_depth, kind, summary, payload_json, execution_id,
        target_session_id, corrected_event_id, options_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.eventId,
      input.principal.sessionId,
      binding.sessionRole,
      binding.roleContractRevision,
      binding.rootSessionId,
      binding.parentSessionId,
      binding.delegationDepth,
      input.kind,
      input.payload.summary,
      JSON.stringify(input.payload),
      input.executionId,
      input.targetSessionId,
      input.correctedEventId,
      JSON.stringify(input.options),
      input.createdAt,
    );
  }

  private insertAction(
    eventId: string,
    action: CoordinationEventAction["type"],
    principal: CoordinationMutationPrincipal,
    optionId: string | null,
    note: string | null,
    relatedEventId: string | null,
    createdAt: string,
  ): void {
    this.db.prepare(`
      INSERT INTO coordination_event_actions_v6 (
        id, event_id, action_type, actor_type, actor_session_id, option_id, note, related_event_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `coordination-action-${randomUUID()}`,
      eventId,
      action,
      principal.actorType,
      principal.actorType === "session" ? principal.sessionId : null,
      optionId,
      note,
      relatedEventId,
      createdAt,
    );
  }

  private insertIdempotency(
    operation: CoordinationMutationOperation,
    principalSessionId: string,
    idempotencyKey: string,
    requestFingerprint: string,
    resultEventId: string,
    targetEventId: string | null,
    createdAt: string,
  ): void {
    this.db.prepare(`
      INSERT INTO coordination_event_idempotency_v6 (
        operation, principal_session_id, idempotency_key, request_fingerprint,
        result_event_id, target_event_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(operation, principalSessionId, idempotencyKey, requestFingerprint, resultEventId, targetEventId, createdAt);
  }

  private resolveReplay(
    operation: CoordinationMutationOperation,
    principalSessionId: string,
    idempotencyKey: string,
    requestFingerprint: string,
  ): IdempotencyRow | null {
    const row = this.db.prepare(`
      SELECT operation, request_fingerprint, result_event_id, target_event_id
      FROM coordination_event_idempotency_v6
      WHERE principal_session_id = ? AND idempotency_key = ?
    `).get(principalSessionId, idempotencyKey) as IdempotencyRow | undefined;
    if (!row) return null;
    if (row.operation !== operation || row.request_fingerprint !== requestFingerprint) {
      throw new CoordinationEventIdempotencyConflictError();
    }
    return row;
  }

  private getRequired(eventId: string): CoordinationEvent {
    const row = this.db.prepare(`
      SELECT events.*, ${PROJECTED_STATE_SQL} AS projected_state
      FROM coordination_events_v6 AS events
      WHERE events.id = ?
    `).get(eventId) as EventRow | undefined;
    if (!row) throw new CoordinationEventNotFoundError();
    const actions = this.db.prepare(`
      SELECT sequence, action_type, actor_type, actor_session_id, option_id, note, related_event_id, created_at
      FROM coordination_event_actions_v6
      WHERE event_id = ?
      ORDER BY sequence ASC
    `).all(eventId) as ActionRow[];
    return mapEventRow(row, actions);
  }

  private assertCanonicalBinding(principal: CoordinationMutationPrincipal): void {
    const row = this.db.prepare(`
      SELECT session_role, role_contract_revision, root_session_id, parent_session_id, delegation_depth
      FROM session_role_bindings_v6
      WHERE session_id = ?
    `).get(principal.sessionId) as {
      session_role: string;
      role_contract_revision: number;
      root_session_id: string;
      parent_session_id: string | null;
      delegation_depth: number;
    } | undefined;
    const binding = principal.roleBinding;
    if (!row
      || row.session_role !== binding.sessionRole
      || row.role_contract_revision !== binding.roleContractRevision
      || row.root_session_id !== binding.rootSessionId
      || row.parent_session_id !== binding.parentSessionId
      || row.delegation_depth !== binding.delegationDepth) {
      throw new CoordinationEventNotFoundError();
    }
  }

  private assertExecutionOwner(executionId: string, actorSessionId: string): void {
    const row = this.db.prepare("SELECT session_id FROM session_executions_v6 WHERE id = ?")
      .get(executionId) as { session_id: string } | undefined;
    if (!row || row.session_id !== actorSessionId) throw new CoordinationEventNotFoundError();
  }

  private assertAncestorTarget(principal: CoordinationMutationPrincipal, targetSessionId: string | null): void {
    if (!targetSessionId) throw new CoordinationEventNotFoundError();
    let parentId = principal.roleBinding.parentSessionId;
    while (parentId) {
      if (parentId === targetSessionId) return;
      const row = this.db.prepare("SELECT parent_session_id, root_session_id FROM session_role_bindings_v6 WHERE session_id = ?")
        .get(parentId) as { parent_session_id: string | null; root_session_id: string } | undefined;
      if (!row || row.root_session_id !== principal.roleBinding.rootSessionId) break;
      parentId = row.parent_session_id;
    }
    throw new CoordinationEventNotFoundError();
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

const PROJECTED_STATE_SQL = `COALESCE(
  (SELECT CASE actions.action_type
    WHEN 'resolved' THEN 'resolved'
    WHEN 'cancelled' THEN 'cancelled'
    WHEN 'superseded' THEN 'superseded'
   END
   FROM coordination_event_actions_v6 AS actions
   WHERE actions.event_id = events.id
     AND actions.action_type IN ('resolved', 'cancelled', 'superseded')
   ORDER BY actions.sequence DESC
   LIMIT 1),
  CASE WHEN events.kind IN ('escalation', 'user_decision_required', 'blocker') THEN 'open' ELSE 'recorded' END
)`;

function toPendingAnswer(event: CoordinationEvent): PendingCoordinationAnswer {
  const resolution = [...event.actions]
    .reverse()
    .find((action) => action.type === "resolved" && action.actorType === "trusted_gui");
  if (!resolution) throw new CoordinationEventStateConflictError();
  if (resolution.optionId) {
    const option = event.options.find((candidate) => candidate.id === resolution.optionId);
    if (!option) throw new CoordinationEventStateConflictError();
    return {
      eventId: event.eventId,
      resolutionSequence: resolution.sequence,
      question: event.payload.summary,
      answer: { kind: "option", optionId: option.id, label: option.label },
      resolvedAt: resolution.createdAt,
      consumption: "pending",
    };
  }
  if (!resolution.note) throw new CoordinationEventStateConflictError();
  return {
    eventId: event.eventId,
    resolutionSequence: resolution.sequence,
    question: event.payload.summary,
    answer: { kind: "text", text: resolution.note },
    resolvedAt: resolution.createdAt,
    consumption: "pending",
  };
}

function mapSummaryRow(row: Pick<EventRow,
  "sequence" | "id" | "actor_session_id" | "session_role" | "kind" | "summary" | "created_at" | "projected_state">): CoordinationEventSummary {
  return {
    sequence: row.sequence,
    eventId: row.id,
    actorSessionId: row.actor_session_id,
    sessionRole: row.session_role,
    kind: row.kind,
    state: row.projected_state,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

function mapEventRow(row: EventRow, actions: ActionRow[]): CoordinationEvent {
  return {
    ...mapSummaryRow(row),
    roleContractRevision: row.role_contract_revision,
    rootSessionId: row.root_session_id,
    parentSessionId: row.parent_session_id,
    delegationDepth: row.delegation_depth,
    payload: JSON.parse(row.payload_json) as CoordinationEventPayload,
    executionId: row.execution_id,
    targetSessionId: row.target_session_id,
    correctedEventId: row.corrected_event_id,
    options: JSON.parse(row.options_json) as CoordinationEventOption[],
    actions: actions.map((action) => ({
      sequence: action.sequence,
      type: action.action_type,
      actorType: action.actor_type,
      actorSessionId: action.actor_session_id,
      optionId: action.option_id,
      note: action.note,
      relatedEventId: action.related_event_id,
      createdAt: action.created_at,
    })),
  };
}

function canView(principal: CoordinationMutationPrincipal, event: CoordinationEvent): boolean {
  if (event.actorSessionId === principal.sessionId) return true;
  if (event.kind === "escalation" && event.targetSessionId === principal.sessionId) return true;
  const role = principal.roleBinding.sessionRole;
  if (role === "overall-coordinator" && event.rootSessionId === principal.roleBinding.rootSessionId) return true;
  return role === "task-coordinator" && event.parentSessionId === principal.sessionId;
}

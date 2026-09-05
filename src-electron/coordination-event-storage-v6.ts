import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  COORDINATION_EVENT_PENDING_RESPONSE_LIMIT,
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
  type PendingCoordinationResponse,
} from "../src/coordination-event.js";
import type {
  MutationAdmissionProof,
  MutationAuthorityProof,
  ResourceEventHeader,
  SessionAuthorityDecisionClass,
  TrustedMutationProof,
} from "../src/session-authority.js";
import { ensureV6Schema } from "./database-schema-v6.js";
import { claimSessionContainerRevision } from "./resource-history-schema.js";
import { appendResourceEventHeader, assertGrantProofCurrent } from "./session-authority-storage.js";
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
  decision_class: SessionAuthorityDecisionClass;
  summary: string;
  payload_json: string;
  execution_id: string | null;
  target_session_id: string | null;
  corrected_event_id: string | null;
  options_json: string;
  created_at: string;
  projected_state: CoordinationEventState;
  projected_revision: number;
};

type ActionRow = {
  sequence: number;
  action_type: CoordinationEventAction["type"];
  actor_type: CoordinationEventAction["actorType"];
  principal_kind: CoordinationEventAction["principalKind"];
  actor_session_id: string | null;
  option_id: string | null;
  note: string | null;
  related_event_id: string | null;
  receipt_id: string | null;
  created_at: string;
};

type IdempotencyRow = {
  operation: CoordinationMutationOperation;
  request_fingerprint: string;
  result_event_id: string;
  target_event_id: string | null;
  result_revision: number;
  operation_id: string;
};

export type CoordinationMutationOperation =
  | "coordination.event.create"
  | "coordination.event.resolve"
  | "coordination.event.consume"
  | "coordination.event.cancel"
  | "coordination.event.correct";

export type CoordinationMutationPrincipal = {
  sessionId: string;
  proof: MutationAdmissionProof;
};

type TrustedCoordinationMutationPrincipal = {
  sessionId: string;
  proof: TrustedMutationProof;
  receiptId: string;
};

type AnyCoordinationMutationPrincipal = CoordinationMutationPrincipal | TrustedCoordinationMutationPrincipal;

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

export class CoordinationEventRevisionConflictError extends Error {
  readonly code = "COORDINATION_EVENT_REVISION_CONFLICT";
  constructor(readonly eventId: string, readonly expectedRevision: number, readonly currentRevision: number) {
    super("The coordination event revision is stale.");
    this.name = "CoordinationEventRevisionConflictError";
  }
}

export class CoordinationEventIdempotencyResponseUnavailableError extends Error {
  readonly code = "IDEMPOTENCY_RESPONSE_UNAVAILABLE";
  readonly effect = "applied" as const;

  constructor(
    readonly operation: CoordinationMutationOperation,
    readonly idempotencyKey: string,
    readonly eventId: string,
  ) {
    super(`The original Coordination event response is unavailable after migration: ${operation}`);
    this.name = "CoordinationEventIdempotencyResponseUnavailableError";
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
    expectedContainerRevision: number;
    idempotencyKey: string;
    requestFingerprint: string;
    createdAt: string;
  }): { event: CoordinationEvent; replayed: boolean } {
    return this.transaction(() => {
      const binding = this.assertAgentProofForSession(
        input.principal,
        "coordination.event.create",
        input.principal.sessionId,
        null,
        "self",
        input.createdAt,
      );
      const replay = this.resolveReplay(
        "coordination.event.create",
        "agent",
        input.principal.sessionId,
        input.idempotencyKey,
        input.requestFingerprint,
      );
      if (replay) return { event: this.getRequired(replay.result_event_id), replayed: true };
      const operationId = `coordination-operation:${randomUUID()}`;
      if (input.executionId) this.assertExecutionOwner(input.executionId, input.principal.sessionId);
      if (input.kind === "escalation") {
        this.assertAncestorTarget(input.principal, input.targetSessionId);
      }
      claimSessionContainerRevision(this.db, {
        sessionId: input.principal.sessionId,
        expectedRevision: input.expectedContainerRevision,
        eventKind: "coordination_event_created",
        proof: input.principal.proof,
        operationId,
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.createdAt,
        payload: { kind: input.kind },
      });
      const eventId = `coordination-${randomUUID()}`;
      this.insertEvent({
        eventId,
        principal: input.principal,
        roleBinding: binding,
        kind: input.kind,
        payload: input.payload,
        executionId: input.executionId,
        targetSessionId: input.targetSessionId,
        correctedEventId: null,
        options: input.options,
        createdAt: input.createdAt,
        operationId,
        idempotencyKey: input.idempotencyKey,
      });
      this.insertIdempotency(
        "coordination.event.create",
        "agent",
        input.principal.sessionId,
        input.idempotencyKey,
        input.requestFingerprint,
        eventId,
        null,
        0,
        operationId,
        input.createdAt,
      );
      return { event: this.getRequired(eventId), replayed: false };
    });
  }

  list(principal: CoordinationMutationPrincipal, input: CoordinationEventListInput, beforeSequence: number | null): CoordinationEventListResult {
    const binding = this.requireCanonicalBinding(principal.sessionId);
    this.assertAgentProofIdentity(principal, "coordination.event.list");
    assertGrantProofCurrent(this.db, principal.proof);
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (input.scope === "self") {
      this.assertProofScope(principal.proof, {
        resourceId: null,
        rootSessionId: binding.rootSessionId,
        ownerId: principal.sessionId,
        relation: "self",
      });
      clauses.push("events.actor_session_id = ?");
      parameters.push(principal.sessionId);
    } else if (principal.proof.resolvedScope.relation === "root_member") {
      this.assertProofScope(principal.proof, {
        resourceId: null,
        rootSessionId: binding.rootSessionId,
        ownerId: principal.sessionId,
        relation: "root_member",
      });
      clauses.push(`EXISTS (
        SELECT 1 FROM session_role_bindings_v6 AS event_binding
        WHERE event_binding.session_id = events.actor_session_id
          AND event_binding.root_session_id = ?
      )`);
      parameters.push(binding.rootSessionId);
    } else if (principal.proof.resolvedScope.relation === "direct_child") {
      this.assertProofScope(principal.proof, {
        resourceId: null,
        rootSessionId: binding.rootSessionId,
        ownerId: principal.sessionId,
        relation: "direct_child",
      });
      clauses.push(`(events.actor_session_id = ? OR EXISTS (
        SELECT 1 FROM session_role_bindings_v6 AS event_binding
        WHERE event_binding.session_id = events.actor_session_id
          AND event_binding.parent_session_id = ?
      ))`);
      parameters.push(principal.sessionId, principal.sessionId);
    } else {
      throw new CoordinationEventNotFoundError();
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
    if (input.category === "needs_answer") {
      clauses.push(`events.kind = 'user_decision_required' AND ${PROJECTED_STATE_SQL} = 'open'`);
    } else if (input.category === "unresolved") {
      clauses.push(`events.kind IN ('blocker', 'escalation') AND ${PROJECTED_STATE_SQL} = 'open'`);
    } else if (input.category === "answered") {
      clauses.push(`events.kind = 'user_decision_required' AND ${PROJECTED_STATE_SQL} = 'resolved'`);
    } else if (input.category === "history") {
      clauses.push(`(${PROJECTED_STATE_SQL} = 'recorded'
        OR ${PROJECTED_STATE_SQL} IN ('cancelled', 'superseded')
        OR (events.kind IN ('blocker', 'escalation') AND ${PROJECTED_STATE_SQL} = 'resolved'))`);
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
        events.kind, events.decision_class, events.summary, events.created_at,
        ${PROJECTED_REVISION_SQL} AS projected_revision,
        ${PROJECTED_STATE_SQL} AS projected_state
      FROM coordination_events_v6 AS events
      ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY events.sequence DESC
      LIMIT ?
    `).all(...parameters) as Array<Pick<EventRow,
      "sequence" | "id" | "actor_session_id" | "session_role" | "kind" | "decision_class" | "summary" | "created_at" | "projected_state"> & { projected_revision: number }>;
    const items = rows.slice(0, input.limit).map(mapSummaryRow);
    return {
      items,
      ...(rows.length > input.limit && items.length > 0
        ? { nextCursor: String(items[items.length - 1]!.sequence) }
        : {}),
    };
  }

  getVisible(principal: CoordinationMutationPrincipal, eventId: string): CoordinationEvent {
    this.assertAgentProofIdentity(principal, "coordination.event.get");
    assertGrantProofCurrent(this.db, principal.proof);
    const event = this.getRequired(eventId);
    this.assertEventProofScope(principal, event);
    return event;
  }

  getTrusted(eventId: string): CoordinationEvent {
    return this.getRequired(eventId);
  }

  getByIdempotencyKey(principal: CoordinationMutationPrincipal, key: string): CoordinationEvent {
    this.assertAgentProofIdentity(principal, "coordination.event.get");
    assertGrantProofCurrent(this.db, principal.proof);
    const row = this.db.prepare(`
      SELECT result_event_id
      FROM coordination_event_idempotency_v6
      WHERE principal_kind = 'agent' AND principal_id = ? AND idempotency_key = ?
    `).get(principal.sessionId, key) as { result_event_id: string } | undefined;
    if (!row) throw new CoordinationEventNotFoundError();
    return this.getVisible(principal, row.result_event_id);
  }

  resolve(input: {
    principal: CoordinationMutationPrincipal;
    eventId: string;
    expectedRevision: number;
    optionId: string | null;
    note: string | null;
    idempotencyKey: string;
    requestFingerprint: string;
    createdAt: string;
  }): { event: CoordinationEvent; replayed: boolean } {
    return this.transitionAgent("coordination.event.resolve", input, (event) => {
      if (event.decisionClass !== "agent_delegable") throw new CoordinationEventNotFoundError();
      if (event.kind === "escalation") {
        if (event.targetSessionId !== input.principal.sessionId || input.optionId) {
          throw new CoordinationEventNotFoundError();
        }
        if (event.state !== "open") throw new CoordinationEventStateConflictError();
      } else if (event.kind === "blocker") {
        if (event.actorSessionId !== input.principal.sessionId || input.optionId) {
          throw new CoordinationEventNotFoundError();
        }
        if (event.state !== "open") throw new CoordinationEventStateConflictError();
      } else {
        throw new CoordinationEventStateConflictError();
      }
    }, "resolved");
  }

  resolveFromTrustedGui(input: {
    eventId: string;
    expectedRevision: number;
    optionId: string | null;
    note: string | null;
    idempotencyKey: string;
    requestFingerprint: string;
    createdAt: string;
  }): { event: CoordinationEvent; replayed: boolean } {
    return this.transitionTrusted("coordination.event.resolve", input, (event) => {
      const hasOption = input.optionId !== null;
      const hasNote = input.note !== null && input.note.trim().length > 0;
      const hasBeenConsumed = event.actions.some((action) => action.type === "consumed");
      if (event.kind === "user_decision_required" && event.decisionClass === "user_only") {
        if ((input.note !== null && !hasNote)
          || hasOption === hasNote
          || (hasOption && !event.options.some((option) => option.id === input.optionId))) {
          throw new CoordinationEventNotFoundError();
        }
        if (event.state !== "open" && (event.state !== "resolved" || hasBeenConsumed)) {
          throw new CoordinationEventStateConflictError();
        }
        return;
      }
      if (event.kind === "blocker" && event.decisionClass === "agent_delegable") {
        const hasTrustedResponse = event.actions.some(
          (action) => action.type === "responded" && action.principalKind === "user",
        );
        if (input.optionId || !hasNote) throw new CoordinationEventNotFoundError();
        if (hasBeenConsumed) throw new CoordinationEventStateConflictError();
        if (event.state !== "open" && (event.state !== "resolved" || !hasTrustedResponse)) {
          throw new CoordinationEventStateConflictError();
        }
        return;
      }
      throw new CoordinationEventNotFoundError();
    }, (event) => event.kind === "blocker" ? "responded" : "resolved");
  }

  listPendingResponses(sessionId: string): PendingCoordinationResponse[] {
    this.requireCanonicalBinding(sessionId);
    const rows = this.db.prepare(`
      SELECT events.id
      FROM coordination_events_v6 AS events
      WHERE events.actor_session_id = ?
        AND events.kind IN ('user_decision_required', 'blocker')
        AND (
          (events.kind = 'user_decision_required' AND ${PROJECTED_STATE_SQL} = 'resolved')
          OR (events.kind = 'blocker' AND ${PROJECTED_STATE_SQL} IN ('open', 'resolved'))
        )
        AND EXISTS (
          SELECT 1
          FROM coordination_event_actions_v6 AS resolved_actions
          WHERE resolved_actions.event_id = events.id
            AND resolved_actions.action_type = CASE events.kind
              WHEN 'blocker' THEN 'responded'
              ELSE 'resolved'
            END
            AND resolved_actions.principal_kind = 'user'
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
          AND resolved_actions.action_type = CASE events.kind
            WHEN 'blocker' THEN 'responded'
            ELSE 'resolved'
          END
          AND resolved_actions.principal_kind = 'user'
      ) ASC
      LIMIT ?
    `).all(sessionId, COORDINATION_EVENT_PENDING_RESPONSE_LIMIT) as Array<{ id: string }>;
    return rows.map(({ id }) => toPendingResponse(this.getRequired(id)));
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
      this.assertAgentProofIdentity(input.principal, "coordination.event.consume");
      assertGrantProofCurrent(this.db, input.principal.proof, new Date(input.createdAt));
      const replay = this.resolveReplay(
        "coordination.event.consume",
        "agent",
        input.principal.sessionId,
        input.idempotencyKey,
        input.requestFingerprint,
      );
      if (replay) {
        const event = this.getRequired(replay.result_event_id);
        this.assertEventProofScope(input.principal, event);
        return { event, replayed: true };
      }
      const event = this.getRequired(input.eventId);
      this.assertEventProofScope(input.principal, event);
      if (event.actorSessionId !== input.principal.sessionId
        || (event.kind !== "user_decision_required" && event.kind !== "blocker")) {
        throw new CoordinationEventNotFoundError();
      }
      const consumableState = event.kind === "blocker"
        ? event.state === "open" || event.state === "resolved"
        : event.state === "resolved";
      if (!consumableState
        || event.actions.some((action) => action.type === "consumed")) {
        throw new CoordinationEventStateConflictError();
      }
      const expectedActionType = event.kind === "blocker" ? "responded" : "resolved";
      const latestResponse = [...event.actions]
        .reverse()
        .find((action) => action.type === expectedActionType && action.principalKind === "user");
      if (!latestResponse || latestResponse.sequence !== input.expectedResolutionSequence) {
        throw new CoordinationEventStateConflictError();
      }
      const operationId = `coordination-operation:${randomUUID()}`;
      const revision = this.insertAction({
        event,
        action: "consumed",
        principal: input.principal,
        optionId: null,
        note: null,
        relatedEventId: null,
        createdAt: input.createdAt,
        operationId,
        idempotencyKey: input.idempotencyKey,
      });
      this.insertIdempotency(
        "coordination.event.consume",
        "agent",
        input.principal.sessionId,
        input.idempotencyKey,
        input.requestFingerprint,
        input.eventId,
        null,
        revision,
        operationId,
        input.createdAt,
      );
      return { event: this.getRequired(input.eventId), replayed: false };
    });
  }

  cancel(input: {
    principal: CoordinationMutationPrincipal;
    eventId: string;
    expectedRevision: number;
    optionId: null;
    note: string | null;
    idempotencyKey: string;
    requestFingerprint: string;
    createdAt: string;
  }): { event: CoordinationEvent; replayed: boolean } {
    return this.transitionAgent("coordination.event.cancel", input, (event) => {
      if (event.actorSessionId !== input.principal.sessionId) throw new CoordinationEventNotFoundError();
      if (event.state !== "open") throw new CoordinationEventStateConflictError();
    }, "cancelled");
  }

  cancelFromTrustedGui(input: {
    eventId: string;
    expectedRevision: number;
    note: string | null;
    idempotencyKey: string;
    requestFingerprint: string;
    createdAt: string;
  }): { event: CoordinationEvent; replayed: boolean } {
    return this.transitionTrusted("coordination.event.cancel", {
      ...input,
      optionId: null,
    }, (event) => {
      if (event.state !== "open") throw new CoordinationEventStateConflictError();
    }, "cancelled");
  }

  correct(input: {
    principal: CoordinationMutationPrincipal;
    eventId: string;
    expectedRevision: number;
    payload: CoordinationEventPayload;
    executionId: string | null;
    idempotencyKey: string;
    requestFingerprint: string;
    createdAt: string;
  }): { result: CoordinationEventCorrectionResult; replayed: boolean } {
    return this.transaction(() => {
      this.assertAgentProofIdentity(input.principal, "coordination.event.correct");
      assertGrantProofCurrent(this.db, input.principal.proof, new Date(input.createdAt));
      const replay = this.resolveReplay(
        "coordination.event.correct",
        "agent",
        input.principal.sessionId,
        input.idempotencyKey,
        input.requestFingerprint,
      );
      if (replay) {
        const correction = this.getRequired(replay.result_event_id);
        const superseded = this.getRequired(replay.target_event_id ?? input.eventId);
        this.assertEventProofScope(input.principal, superseded);
        return {
          result: {
            correction,
            superseded,
          },
          replayed: true,
        };
      }
      const target = this.getRequired(input.eventId);
      this.assertEventProofScope(input.principal, target);
      this.assertExpectedRevision(target, input.expectedRevision);
      if (target.actorSessionId !== input.principal.sessionId) throw new CoordinationEventNotFoundError();
      if (target.state === "superseded" || target.state === "cancelled") throw new CoordinationEventStateConflictError();
      if (input.executionId) this.assertExecutionOwner(input.executionId, input.principal.sessionId);
      const operationId = `coordination-operation:${randomUUID()}`;
      const correctionId = `coordination-${randomUUID()}`;
      const binding = this.requireCanonicalBinding(input.principal.sessionId);
      this.insertEvent({
        eventId: correctionId,
        principal: input.principal,
        roleBinding: binding,
        kind: "correction",
        payload: input.payload,
        executionId: input.executionId,
        targetSessionId: null,
        correctedEventId: input.eventId,
        options: [],
        createdAt: input.createdAt,
        operationId,
        idempotencyKey: input.idempotencyKey,
      });
      const targetRevision = this.insertAction({
        event: target,
        action: "superseded",
        principal: input.principal,
        optionId: null,
        note: null,
        relatedEventId: correctionId,
        createdAt: input.createdAt,
        operationId,
        idempotencyKey: input.idempotencyKey,
      });
      this.insertIdempotency(
        "coordination.event.correct",
        "agent",
        input.principal.sessionId,
        input.idempotencyKey,
        input.requestFingerprint,
        correctionId,
        input.eventId,
        targetRevision,
        operationId,
        input.createdAt,
      );
      return {
        result: { correction: this.getRequired(correctionId), superseded: this.getRequired(input.eventId) },
        replayed: false,
      };
    });
  }

  private transitionAgent(
    operation: "coordination.event.resolve" | "coordination.event.cancel",
    input: {
      principal: CoordinationMutationPrincipal;
      eventId: string;
      expectedRevision: number;
      optionId: string | null;
      note: string | null;
      idempotencyKey: string;
      requestFingerprint: string;
      createdAt: string;
    },
    authorize: (event: CoordinationEvent) => void,
    action: "responded" | "resolved" | "cancelled" | ((event: CoordinationEvent) => "responded" | "resolved"),
  ): { event: CoordinationEvent; replayed: boolean } {
    return this.transaction(() => {
      this.assertAgentProofIdentity(input.principal, operation);
      assertGrantProofCurrent(this.db, input.principal.proof, new Date(input.createdAt));
      const replay = this.resolveReplay(operation, "agent", input.principal.sessionId, input.idempotencyKey, input.requestFingerprint);
      if (replay) {
        const event = this.getRequired(replay.result_event_id);
        this.assertEventProofScope(input.principal, event);
        return { event, replayed: true };
      }
      const event = this.getRequired(input.eventId);
      this.assertEventProofScope(input.principal, event);
      this.assertExpectedRevision(event, input.expectedRevision);
      authorize(event);
      const actionType = typeof action === "function" ? action(event) : action;
      const operationId = `coordination-operation:${randomUUID()}`;
      const revision = this.insertAction({
        event,
        action: actionType,
        principal: input.principal,
        optionId: input.optionId,
        note: input.note,
        relatedEventId: null,
        createdAt: input.createdAt,
        operationId,
        idempotencyKey: input.idempotencyKey,
      });
      this.insertIdempotency(operation, "agent", input.principal.sessionId, input.idempotencyKey, input.requestFingerprint, input.eventId, null, revision, operationId, input.createdAt);
      return { event: this.getRequired(input.eventId), replayed: false };
    });
  }

  private transitionTrusted(
    operation: "coordination.event.resolve" | "coordination.event.cancel",
    input: {
      eventId: string;
      expectedRevision: number;
      optionId: string | null;
      note: string | null;
      idempotencyKey: string;
      requestFingerprint: string;
      createdAt: string;
    },
    authorize: (event: CoordinationEvent) => void,
    action: "responded" | "resolved" | "cancelled" | ((event: CoordinationEvent) => "responded" | "resolved"),
  ): { event: CoordinationEvent; replayed: boolean } {
    return this.transaction(() => {
      const replay = this.resolveReplay(operation, "user", "local-user", input.idempotencyKey, input.requestFingerprint);
      if (replay) {
        const event = this.getRequired(replay.result_event_id);
        this.requireCanonicalEventScope(event);
        return { event, replayed: true };
      }
      const event = this.getRequired(input.eventId);
      const scope = this.requireCanonicalEventScope(event);
      this.assertExpectedRevision(event, input.expectedRevision);
      authorize(event);
      const receiptId = `coordination-receipt:${randomUUID()}`;
      const principal: TrustedCoordinationMutationPrincipal = {
        sessionId: event.actorSessionId,
        receiptId,
        proof: {
          principal: { kind: "user", receiptId },
          operation,
          mappingRevision: 1,
          action: operation,
          resolvedScope: scope,
          effectClass: "local_mutation",
          grantId: null,
          grantRevision: null,
          evaluatedAt: input.createdAt,
        },
      };
      const operationId = `coordination-operation:${randomUUID()}`;
      const actionType = typeof action === "function" ? action(event) : action;
      const revision = this.insertAction({
        event,
        action: actionType,
        principal,
        optionId: input.optionId,
        note: input.note,
        relatedEventId: null,
        createdAt: input.createdAt,
        operationId,
        idempotencyKey: input.idempotencyKey,
      });
      this.insertUserReceipt(receiptId, input.eventId, revision, actionType, input.optionId, input.note, input.createdAt);
      this.insertIdempotency(operation, "user", "local-user", input.idempotencyKey, input.requestFingerprint, input.eventId, null, revision, operationId, input.createdAt);
      return { event: this.getRequired(input.eventId), replayed: false };
    });
  }

  private insertEvent(input: {
    eventId: string;
    principal: AnyCoordinationMutationPrincipal;
    roleBinding: CoordinationEventRoleSnapshot;
    kind: CoordinationEventKind;
    payload: CoordinationEventPayload;
    executionId: string | null;
    targetSessionId: string | null;
    correctedEventId: string | null;
    options: CoordinationEventOption[];
    createdAt: string;
    operationId: string;
    idempotencyKey: string;
  }): void {
    const binding = input.roleBinding;
    this.db.prepare(`
      INSERT INTO coordination_events_v6 (
        id, actor_session_id, creation_principal_kind, session_role, role_contract_revision, root_session_id,
        parent_session_id, delegation_depth, kind, decision_class, summary, payload_json, execution_id,
        target_session_id, corrected_event_id, options_json, created_at
      ) VALUES (?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.eventId,
      input.principal.sessionId,
      binding.sessionRole,
      binding.roleContractRevision,
      binding.rootSessionId,
      binding.parentSessionId,
      binding.delegationDepth,
      input.kind,
      this.requireDecisionClass(input.kind),
      input.payload.summary,
      JSON.stringify(input.payload),
      input.executionId,
      input.targetSessionId,
      input.correctedEventId,
      JSON.stringify(input.options),
      input.createdAt,
    );
    appendResourceEventHeader(this.db, this.resourceEventHeader({
      eventId: input.eventId,
      resourceId: input.eventId,
      rootId: binding.rootSessionId,
      ownerId: input.principal.sessionId,
      eventKind: "coordination_event_created",
      resourceRevision: null,
      principal: input.principal,
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      occurredAt: input.createdAt,
      supersedesEventId: input.correctedEventId,
    }));
  }

  private insertAction(input: {
    event: CoordinationEvent;
    action: CoordinationEventAction["type"];
    principal: AnyCoordinationMutationPrincipal;
    optionId: string | null;
    note: string | null;
    relatedEventId: string | null;
    createdAt: string;
    operationId: string;
    idempotencyKey: string;
  }): number {
    const actionId = `coordination-action-${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO coordination_event_actions_v6 (
        id, event_id, action_type, actor_type, principal_kind, actor_session_id,
        option_id, note, related_event_id, receipt_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      actionId,
      input.event.eventId,
      input.action,
      input.principal.proof.principal.kind === "agent" ? "session" : "trusted_gui",
      input.principal.proof.principal.kind,
      input.principal.proof.principal.kind === "agent" ? input.principal.sessionId : null,
      input.optionId,
      input.note,
      input.relatedEventId,
      "receiptId" in input.principal ? input.principal.receiptId : null,
      input.createdAt,
    );
    const revision = input.event.revision + 1;
    const scope = this.requireCanonicalEventScope(input.event);
    appendResourceEventHeader(this.db, this.resourceEventHeader({
      eventId: actionId,
      resourceId: input.event.eventId,
      rootId: scope.rootSessionId,
      ownerId: scope.ownerId,
      eventKind: `coordination_event_${input.action}`,
      resourceRevision: revision,
      principal: input.principal,
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      occurredAt: input.createdAt,
      supersedesEventId: null,
    }));
    return revision;
  }

  private insertIdempotency(
    operation: CoordinationMutationOperation,
    principalKind: "agent" | "user",
    principalId: string,
    idempotencyKey: string,
    requestFingerprint: string,
    resultEventId: string,
    targetEventId: string | null,
    resultRevision: number,
    operationId: string,
    createdAt: string,
  ): void {
    this.db.prepare(`
      INSERT INTO coordination_event_idempotency_v6 (
        operation, principal_kind, principal_id, idempotency_key, request_fingerprint,
        result_event_id, target_event_id, result_revision, operation_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      operation,
      principalKind,
      principalId,
      idempotencyKey,
      requestFingerprint,
      resultEventId,
      targetEventId,
      resultRevision,
      operationId,
      createdAt,
    );
  }

  private resolveReplay(
    operation: CoordinationMutationOperation,
    principalKind: "agent" | "user",
    principalId: string,
    idempotencyKey: string,
    requestFingerprint: string,
  ): IdempotencyRow | null {
    const row = this.db.prepare(`
      SELECT operation, request_fingerprint, result_event_id, target_event_id,
        result_revision, operation_id
      FROM coordination_event_idempotency_v6
      WHERE principal_kind = ? AND principal_id = ? AND idempotency_key = ?
    `).get(principalKind, principalId, idempotencyKey) as IdempotencyRow | undefined;
    if (!row) {
      const legacy = this.db.prepare(`
        SELECT result_event_id
        FROM coordination_event_idempotency_v6
        WHERE operation = ? AND principal_kind = 'legacy_unknown' AND idempotency_key = ?
        LIMIT 1
      `).get(operation, idempotencyKey) as { result_event_id: string } | undefined;
      if (legacy) {
        throw new CoordinationEventIdempotencyResponseUnavailableError(
          operation,
          idempotencyKey,
          legacy.result_event_id,
        );
      }
      return null;
    }
    if (row.operation !== operation || row.request_fingerprint !== requestFingerprint) {
      throw new CoordinationEventIdempotencyConflictError();
    }
    return row;
  }

  private getRequired(eventId: string): CoordinationEvent {
    const row = this.db.prepare(`
      SELECT events.*, ${PROJECTED_REVISION_SQL} AS projected_revision,
        ${PROJECTED_STATE_SQL} AS projected_state
      FROM coordination_events_v6 AS events
      WHERE events.id = ?
    `).get(eventId) as EventRow | undefined;
    if (!row) throw new CoordinationEventNotFoundError();
    const actions = this.db.prepare(`
      SELECT sequence, action_type, actor_type, principal_kind, actor_session_id,
        option_id, note, related_event_id, receipt_id, created_at
      FROM coordination_event_actions_v6
      WHERE event_id = ?
      ORDER BY sequence ASC
    `).all(eventId) as ActionRow[];
    return mapEventRow(row, actions);
  }

  private requireCanonicalBinding(sessionId: string): CoordinationEventRoleSnapshot {
    const row = this.db.prepare(`
      SELECT session_role, role_contract_revision, root_session_id, parent_session_id, delegation_depth
      FROM session_role_bindings_v6
      WHERE session_id = ?
    `).get(sessionId) as {
      session_role: CoordinationEventRoleSnapshot["sessionRole"];
      role_contract_revision: number;
      root_session_id: string;
      parent_session_id: string | null;
      delegation_depth: number;
    } | undefined;
    if (!row || row.role_contract_revision !== 1) throw new CoordinationEventNotFoundError();
    return {
      sessionRole: row.session_role,
      roleContractRevision: 1,
      rootSessionId: row.root_session_id,
      parentSessionId: row.parent_session_id,
      delegationDepth: row.delegation_depth,
    };
  }

  private requireDecisionClass(kind: CoordinationEventKind): SessionAuthorityDecisionClass {
    const row = this.db.prepare(`
      SELECT decision_class, mapping_revision
      FROM coordination_event_decision_class_registry_v6
      WHERE kind = ?
    `).get(kind) as { decision_class: SessionAuthorityDecisionClass; mapping_revision: number } | undefined;
    if (!row || row.mapping_revision !== 1) {
      throw new Error("The Coordination event decision class registry is unavailable.");
    }
    return row.decision_class;
  }

  private assertAgentProofIdentity(
    principal: CoordinationMutationPrincipal,
    operation: CoordinationMutationOperation | "coordination.event.list" | "coordination.event.get",
  ): void {
    const proof = principal.proof;
    if (proof.principal.kind !== "agent"
      || proof.principal.actorSessionId !== principal.sessionId
      || proof.operation !== operation
      || proof.action !== operation
      || proof.resolvedScope.resourceKind !== "coordination_event") {
      throw new CoordinationEventNotFoundError();
    }
  }

  private assertAgentProofForSession(
    principal: CoordinationMutationPrincipal,
    operation: CoordinationMutationOperation,
    ownerSessionId: string,
    resourceId: string | null,
    relation: MutationAdmissionProof["resolvedScope"]["relation"],
    occurredAt: string,
  ): CoordinationEventRoleSnapshot {
    this.assertAgentProofIdentity(principal, operation);
    assertGrantProofCurrent(this.db, principal.proof, new Date(occurredAt));
    const binding = this.requireCanonicalBinding(ownerSessionId);
    this.assertProofScope(principal.proof, {
      resourceId,
      rootSessionId: binding.rootSessionId,
      ownerId: ownerSessionId,
      relation,
    });
    return binding;
  }

  private assertEventProofScope(principal: CoordinationMutationPrincipal, event: CoordinationEvent): void {
    const owner = this.requireCanonicalBinding(event.actorSessionId);
    if (owner.rootSessionId !== event.rootSessionId) throw new CoordinationEventNotFoundError();
    const actor = this.requireCanonicalBinding(principal.sessionId);
    const relations = new Set<MutationAdmissionProof["resolvedScope"]["relation"]>();
    if (principal.sessionId === event.actorSessionId) {
      relations.add("created");
    }
    if (owner.parentSessionId === principal.sessionId) relations.add("direct_child");
    if (actor.parentSessionId === event.actorSessionId) relations.add("parent");
    if (actor.parentSessionId !== null
      && actor.parentSessionId === owner.parentSessionId
      && owner.sessionRole === "task-coordinator") {
      relations.add("sibling");
    }
    if (actor.rootSessionId === principal.sessionId && actor.rootSessionId === owner.rootSessionId) relations.add("root_member");
    const relation = principal.proof.resolvedScope.relation;
    if (!relations.has(relation)) throw new CoordinationEventNotFoundError();
    this.assertProofScope(principal.proof, {
      resourceId: event.eventId,
      rootSessionId: owner.rootSessionId,
      ownerId: event.actorSessionId,
      relation,
    });
  }

  private assertProofScope(
    proof: MutationAuthorityProof,
    expected: {
      resourceId: string | null;
      rootSessionId: string;
      ownerId: string;
      relation: MutationAdmissionProof["resolvedScope"]["relation"];
    },
  ): void {
    const scope = proof.resolvedScope;
    if (scope.resourceKind !== "coordination_event"
      || scope.resourceId !== expected.resourceId
      || scope.rootSessionId !== expected.rootSessionId
      || scope.ownerKind !== "session"
      || scope.ownerId !== expected.ownerId
      || scope.relation !== expected.relation) {
      throw new CoordinationEventNotFoundError();
    }
  }

  private requireCanonicalEventScope(event: CoordinationEvent): MutationAuthorityProof["resolvedScope"] {
    const owner = this.requireCanonicalBinding(event.actorSessionId);
    if (owner.rootSessionId !== event.rootSessionId) throw new CoordinationEventNotFoundError();
    return {
      resourceKind: "coordination_event",
      resourceId: event.eventId,
      rootSessionId: owner.rootSessionId,
      ownerKind: "session",
      ownerId: event.actorSessionId,
      relation: "created",
    };
  }

  private assertExpectedRevision(event: CoordinationEvent, expectedRevision: number): void {
    if (event.revision !== expectedRevision) {
      throw new CoordinationEventRevisionConflictError(event.eventId, expectedRevision, event.revision);
    }
  }

  private insertUserReceipt(
    receiptId: string,
    eventId: string,
    eventRevision: number,
    action: "responded" | "resolved" | "cancelled",
    optionId: string | null,
    note: string | null,
    createdAt: string,
  ): void {
    const responseKind = action === "cancelled" ? "cancel" : optionId !== null ? "option" : "text";
    this.db.prepare(`
      INSERT INTO coordination_event_user_receipts_v6 (
        receipt_id, user_id, event_id, event_revision, response_kind, option_id, note, created_at
      ) VALUES (?, 'local-user', ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId,
      eventId,
      eventRevision,
      responseKind,
      optionId,
      action === "cancelled" ? null : note,
      createdAt,
    );
  }

  private resourceEventHeader(input: {
    eventId: string;
    resourceId: string;
    rootId: string;
    ownerId: string;
    eventKind: string;
    resourceRevision: number | null;
    principal: AnyCoordinationMutationPrincipal;
    operationId: string;
    idempotencyKey: string;
    occurredAt: string;
    supersedesEventId: string | null;
  }): ResourceEventHeader {
    const proof = input.principal.proof;
    return {
      eventId: input.eventId,
      resourceKind: "coordination_event",
      resourceId: input.resourceId,
      rootId: input.rootId,
      ownerKind: "session",
      ownerId: input.ownerId,
      eventKind: input.eventKind,
      resourceRevision: input.resourceRevision,
      principalKind: proof.principal.kind,
      actorSessionId: proof.principal.kind === "agent" ? proof.principal.actorSessionId : null,
      grantId: proof.grantId,
      grantRevision: proof.grantRevision,
      operationId: input.operationId,
      idempotencyKeyFingerprint: fingerprintIdempotencyKey(input.idempotencyKey),
      occurredAt: input.occurredAt,
      committedAt: input.occurredAt,
      supersedesEventId: input.supersedesEventId,
      payloadSchemaRevision: 1,
      effect: "committed",
    };
  }

  private assertExecutionOwner(executionId: string, actorSessionId: string): void {
    const row = this.db.prepare("SELECT session_id FROM session_executions_v6 WHERE id = ?")
      .get(executionId) as { session_id: string } | undefined;
    if (!row || row.session_id !== actorSessionId) throw new CoordinationEventNotFoundError();
  }

  private assertAncestorTarget(principal: CoordinationMutationPrincipal, targetSessionId: string | null): void {
    if (!targetSessionId) throw new CoordinationEventNotFoundError();
    const actor = this.requireCanonicalBinding(principal.sessionId);
    let parentId = actor.parentSessionId;
    while (parentId) {
      if (parentId === targetSessionId) return;
      const row = this.db.prepare("SELECT parent_session_id, root_session_id FROM session_role_bindings_v6 WHERE session_id = ?")
        .get(parentId) as { parent_session_id: string | null; root_session_id: string } | undefined;
      if (!row || row.root_session_id !== actor.rootSessionId) break;
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

const PROJECTED_REVISION_SQL = `COALESCE((
  SELECT COUNT(*)
  FROM coordination_event_actions_v6 AS actions
  WHERE actions.event_id = events.id
), 0)`;

function toPendingResponse(event: CoordinationEvent): PendingCoordinationResponse {
  if (event.kind !== "user_decision_required" && event.kind !== "blocker") {
    throw new CoordinationEventStateConflictError();
  }
  const expectedActionType = event.kind === "blocker" ? "responded" : "resolved";
  const resolution = [...event.actions]
    .reverse()
    .find((action) => action.type === expectedActionType && action.principalKind === "user");
  if (!resolution) throw new CoordinationEventStateConflictError();
  if (resolution.optionId) {
    if (event.kind !== "user_decision_required") throw new CoordinationEventStateConflictError();
    const option = event.options.find((candidate) => candidate.id === resolution.optionId);
    if (!option) throw new CoordinationEventStateConflictError();
    return {
      eventId: event.eventId,
      kind: "user_decision_required",
      resolutionSequence: resolution.sequence,
      request: event.payload.summary,
      response: { kind: "option", optionId: option.id, label: option.label },
      respondedAt: resolution.createdAt,
      consumption: "pending",
    };
  }
  if (!resolution.note) throw new CoordinationEventStateConflictError();
  return {
    eventId: event.eventId,
    kind: event.kind,
    resolutionSequence: resolution.sequence,
    request: event.payload.summary,
    response: { kind: "text", text: resolution.note },
    respondedAt: resolution.createdAt,
    consumption: "pending",
  };
}

function mapSummaryRow(row: Pick<EventRow,
  "sequence" | "id" | "actor_session_id" | "session_role" | "kind" | "decision_class" | "summary" | "created_at" | "projected_state" | "projected_revision">): CoordinationEventSummary {
  return {
    sequence: row.sequence,
    eventId: row.id,
    revision: row.projected_revision,
    actorSessionId: row.actor_session_id,
    sessionRole: row.session_role,
    kind: row.kind,
    decisionClass: row.decision_class,
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
      principalKind: action.principal_kind,
      actorSessionId: action.actor_session_id,
      optionId: action.option_id,
      note: action.note,
      relatedEventId: action.related_event_id,
      createdAt: action.created_at,
    })),
  };
}

function fingerprintIdempotencyKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

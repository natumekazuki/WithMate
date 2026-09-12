import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { ensureV6Schema } from "./database-schema-v6.js";
import { openAppDatabase } from "./sqlite-connection.js";
import { appendSessionResourceEvent, getSessionResourceRevision } from "./resource-history-schema.js";
import type { MutationAuthorityProof } from "../src/session-authority.js";
import type { Session } from "../src/session-state.js";

export type SessionLifecycleOperation =
  | "session.create"
  | "session.configure"
  | "session.move"
  | "session.clone"
  | "session.restore"
  | "session.archive"
  | "session.delete";

export type SessionLifecyclePrincipalKind = "agent" | "user" | "system";
export type SessionLifecycleEffect = "none" | "committed" | "unknown";
export type SessionLifecycleState = "prepared" | "running" | "committed" | "rejected" | "recovery-required";

export type SessionLifecycleOperationRecord = {
  operationId: string;
  operation: SessionLifecycleOperation;
  principalKind: SessionLifecyclePrincipalKind;
  principalId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  targetSessionId: string | null;
  sourceRootSessionId: string | null;
  destinationRootSessionId: string | null;
  revision: number;
  state: SessionLifecycleState;
  currentStep: string;
  manifest: Record<string, unknown>;
  reservedResourceIds: string[];
  effects: Record<string, SessionLifecycleEffect>;
  result: unknown;
  error: unknown;
  createdAt: string;
  updatedAt: string;
};

export type SessionLifecyclePrepareInput = {
  operationId?: string;
  operation: SessionLifecycleOperation;
  principalKind: SessionLifecyclePrincipalKind;
  principalId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  targetSessionId?: string | null;
  sourceRootSessionId?: string | null;
  destinationRootSessionId?: string | null;
  manifest: Record<string, unknown>;
  reservedResourceIds?: readonly string[];
  createdAt?: string;
};

export type SessionLifecycleStepInput = {
  operationId: string;
  expectedRevision: number;
  step: string;
  effect: SessionLifecycleEffect;
  payload?: Record<string, unknown>;
  occurredAt?: string;
  state?: "running" | "recovery-required";
};

export type SessionLifecycleSessionPatch = {
  title?: string;
  state?: "active" | "completed" | "failed" | "archived";
  providerId?: string;
  catalogRevision?: number;
  modelId?: string;
  reasoningEffort?: string;
  customAgentName?: string;
  approvalMode?: string;
  codexSandboxMode?: string;
  allowedAdditionalDirectories?: readonly string[];
  runtimePolicyJson?: string;
  threadId?: string;
  characterId?: string | null;
  characterSnapshotJson?: string | null;
  workspacePath?: string;
  isPinned?: boolean;
  binding?: {
    sessionRole: string;
    roleContractRevision: number;
    rootSessionId: string;
    parentSessionId: string | null;
    delegationDepth: number;
  };
};

export type SessionLifecycleSessionMutation = {
  sessionId: string;
  expectedRevision: number;
  patch: SessionLifecycleSessionPatch;
  eventKind: string;
  proof: MutationAuthorityProof;
  operationId: string;
  idempotencyKey?: string | null;
  occurredAt?: string;
  payload?: Record<string, unknown>;
};

export type PrepareLifecycleMutationInput = {
  operation: SessionLifecycleOperation;
  input: Record<string, unknown>;
  proof: MutationAuthorityProof;
  nextSession?: Session;
  destinationProof?: MutationAuthorityProof;
  now: string;
  requestFingerprint?: string;
  projectResult?: (session: Session) => unknown;
};

export type CommitLifecycleMutationInput = {
  operationId: string;
  expectedOperationRevision: number;
  proof: MutationAuthorityProof;
  now: string;
  projectResult?: (session: Session) => unknown;
};

export class SessionLifecycleOperationConflictError extends Error {
  readonly code = "SESSION_LIFECYCLE_OPERATION_CONFLICT";
}

export class SessionLifecycleOperationRevisionConflictError extends Error {
  readonly code = "SESSION_LIFECYCLE_OPERATION_REVISION_CONFLICT";
}

type OperationRow = {
  operation_id: string;
  operation: SessionLifecycleOperation;
  principal_kind: SessionLifecyclePrincipalKind;
  principal_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  target_session_id: string | null;
  source_root_session_id: string | null;
  destination_root_session_id: string | null;
  revision: number;
  state: SessionLifecycleState;
  current_step: string;
  manifest_json: string;
  reserved_resource_ids_json: string;
  effects_json: string;
  result_json: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
};

function parseObject(value: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Stored Session lifecycle ${label} is not an object.`);
  }
  return parsed as Record<string, unknown>;
}

function parseArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("Stored Session lifecycle reserved resource IDs are invalid.");
  }
  return parsed;
}

function parseNullableJson(value: string | null): unknown {
  return value === null ? null : JSON.parse(value);
}

function assertText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`Session lifecycle ${name} must not be empty.`);
  return normalized;
}

function assertObject(value: Record<string, unknown>, name: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Session lifecycle ${name} must be an object.`);
  }
}

export class SessionLifecycleStorage {
  private readonly db: DatabaseSync;
  private readonly ownsDatabase: boolean;
  private transactionActive = false;

  constructor(dbOrPath: DatabaseSync | string) {
    this.ownsDatabase = typeof dbOrPath === "string";
    this.db = typeof dbOrPath === "string" ? openAppDatabase(dbOrPath) : dbOrPath;
    if (this.ownsDatabase) ensureV6Schema(this.db);
    this.verifyRecoveryRecords();
  }

  prepare(input: SessionLifecyclePrepareInput): SessionLifecycleOperationRecord {
    const operationId = assertText(input.operationId ?? randomUUID(), "operationId");
    const principalId = assertText(input.principalId, "principalId");
    const idempotencyKey = assertText(input.idempotencyKey, "idempotencyKey");
    const requestFingerprint = assertText(input.requestFingerprint, "requestFingerprint");
    assertObject(input.manifest, "manifest");
    const reservedResourceIds = [...new Set((input.reservedResourceIds ?? []).map((id) => assertText(id, "reservedResourceId")))];
    const createdAt = input.createdAt ?? new Date().toISOString();

    const existing = this.db.prepare(`
      SELECT * FROM session_lifecycle_operations_v6
      WHERE operation = ? AND principal_kind = ? AND principal_id = ? AND idempotency_key = ?
    `).get(input.operation, input.principalKind, principalId, idempotencyKey) as OperationRow | undefined;
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) throw new SessionLifecycleOperationConflictError("The lifecycle idempotency key belongs to another request.");
      return this.toRecord(existing);
    }

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.db.prepare(`
        INSERT INTO session_lifecycle_operations_v6 (
          operation_id, operation, principal_kind, principal_id, idempotency_key, request_fingerprint,
          target_session_id, source_root_session_id, destination_root_session_id,
          revision, state, current_step, manifest_json, reserved_resource_ids_json,
          effects_json, result_json, error_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'prepared', 'prepared', ?, ?, '{}', NULL, NULL, ?, ?)
      `).run(
        operationId,
        input.operation,
        input.principalKind,
        principalId,
        idempotencyKey,
        requestFingerprint,
        input.targetSessionId ?? null,
        input.sourceRootSessionId ?? null,
        input.destinationRootSessionId ?? null,
        JSON.stringify(input.manifest),
        JSON.stringify(reservedResourceIds),
        createdAt,
        createdAt,
      );
      this.db.prepare(`
        INSERT INTO session_lifecycle_operation_events_v6
          (event_id, operation_id, revision, step, effect, payload_json, created_at)
        VALUES (?, ?, 1, 'prepared', 'none', ?, ?)
      `).run(randomUUID(), operationId, JSON.stringify({ manifest: input.manifest, reservedResourceIds }), createdAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.require(operationId);
  }

  get(operationId: string): SessionLifecycleOperationRecord | null {
    const row = this.db.prepare("SELECT * FROM session_lifecycle_operations_v6 WHERE operation_id = ?")
      .get(assertText(operationId, "operationId")) as OperationRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  replay(operationId: string, requestFingerprint: string): SessionLifecycleOperationRecord {
    const record = this.require(operationId);
    if (record.requestFingerprint !== assertText(requestFingerprint, "requestFingerprint")) {
      throw new SessionLifecycleOperationConflictError("The lifecycle operation fingerprint does not match.");
    }
    return record;
  }

  recordStep(input: SessionLifecycleStepInput): SessionLifecycleOperationRecord {
    const operationId = assertText(input.operationId, "operationId");
    const step = assertText(input.step, "step");
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    assertObject(input.payload ?? {}, "step payload");
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const row = this.requireRow(operationId);
      if (row.revision !== input.expectedRevision) throw new SessionLifecycleOperationRevisionConflictError("The lifecycle operation revision is stale.");
      if (row.state === "committed" || row.state === "rejected") {
        throw new Error("A terminal Session lifecycle operation cannot accept another step.");
      }
      const nextRevision = row.revision + 1;
      const effects = parseObject(row.effects_json, "effects");
      effects[step] = input.effect;
      const state = input.state ?? (input.effect === "unknown" ? "recovery-required" : "running");
      const changed = this.db.prepare(`
        UPDATE session_lifecycle_operations_v6
        SET revision = ?, state = ?, current_step = ?, effects_json = ?, updated_at = ?
        WHERE operation_id = ? AND revision = ?
      `).run(nextRevision, state, step, JSON.stringify(effects), occurredAt, operationId, input.expectedRevision);
      if (changed.changes !== 1) throw new SessionLifecycleOperationRevisionConflictError("The lifecycle operation revision is stale.");
      this.db.prepare(`
        INSERT INTO session_lifecycle_operation_events_v6
          (event_id, operation_id, revision, step, effect, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), operationId, nextRevision, step, input.effect, JSON.stringify(input.payload ?? {}), occurredAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.require(operationId);
  }

  prepareLifecycleMutation(input: PrepareLifecycleMutationInput): SessionLifecycleOperationRecord {
    const idempotencyKey = typeof input.input.idempotencyKey === "string" ? input.input.idempotencyKey : "";
    const requestFingerprint = input.requestFingerprint ?? (typeof input.input.requestFingerprint === "string"
      ? input.input.requestFingerprint
      : JSON.stringify(input.input));
    const principal = input.proof.principal;
    const principalId = principal.kind === "agent"
      ? principal.actorSessionId
      : principal.kind === "user" ? principal.receiptId : principal.service;
    const targetSessionId = input.nextSession?.id ?? (typeof input.input.sessionId === "string" ? input.input.sessionId : null);
    return this.prepare({
      operation: input.operation,
      principalKind: principal.kind,
      principalId,
      idempotencyKey,
      requestFingerprint,
      targetSessionId,
      sourceRootSessionId: input.proof.resolvedScope.rootSessionId,
      destinationRootSessionId: typeof input.input.destinationRootSessionId === "string" ? input.input.destinationRootSessionId : null,
      manifest: { input: input.input, proof: input.proof, nextSession: input.nextSession ?? null, destinationProof: input.destinationProof ?? null },
      reservedResourceIds: targetSessionId ? [targetSessionId] : [],
      createdAt: input.now,
    });
  }

  completeLifecycleMutation(operationId: string, expectedRevision: number, now = new Date().toISOString()): SessionLifecycleOperationRecord {
    const record = this.require(operationId);
    return this.complete(operationId, expectedRevision, record.result, now);
  }

  getLifecycleOperationByKey(operation: SessionLifecycleOperation, proof: MutationAuthorityProof, idempotencyKey: string, requestFingerprint: string): SessionLifecycleOperationRecord | null {
    const principal = proof.principal;
    const principalId = principal.kind === "agent" ? principal.actorSessionId : principal.kind === "user" ? principal.receiptId : principal.service;
    const row = this.db.prepare(`SELECT * FROM session_lifecycle_operations_v6 WHERE operation = ? AND principal_kind = ? AND principal_id = ? AND idempotency_key = ?`).get(operation, principal.kind, principalId, idempotencyKey) as OperationRow | undefined;
    if (!row) return null;
    if (row.request_fingerprint !== requestFingerprint) throw new SessionLifecycleOperationConflictError("The lifecycle idempotency key belongs to another request.");
    return this.toRecord(row);
  }

  /** Atomically updates the canonical Session projection and appends its resource event. */
  applySessionMutation(input: SessionLifecycleSessionMutation): number {
    const sessionId = assertText(input.sessionId, "sessionId");
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const patch = input.patch;
    const columns: string[] = [];
    const values: SQLInputValue[] = [];
    const add = (column: string, value: SQLInputValue): void => { columns.push(`${column} = ?`); values.push(value); };
    if (patch.title !== undefined) add("title", assertText(patch.title, "title"));
    if (patch.state !== undefined) add("state", patch.state);
    if (patch.providerId !== undefined) add("provider_id", assertText(patch.providerId, "providerId"));
    if (patch.catalogRevision !== undefined) add("catalog_revision", patch.catalogRevision);
    if (patch.modelId !== undefined) add("model_id", assertText(patch.modelId, "modelId"));
    if (patch.reasoningEffort !== undefined) add("reasoning_effort", patch.reasoningEffort);
    if (patch.customAgentName !== undefined) add("custom_agent_name", patch.customAgentName);
    if (patch.approvalMode !== undefined) add("approval_mode", patch.approvalMode);
    if (patch.codexSandboxMode !== undefined) add("codex_sandbox_mode", patch.codexSandboxMode);
    if (patch.allowedAdditionalDirectories !== undefined) add("allowed_additional_directories_json", JSON.stringify([...patch.allowedAdditionalDirectories]));
    if (patch.runtimePolicyJson !== undefined) add("runtime_policy_json", patch.runtimePolicyJson);
    if (patch.threadId !== undefined) add("thread_id", patch.threadId);
    if (patch.characterId !== undefined) add("character_id", patch.characterId);
    if (patch.characterSnapshotJson !== undefined) add("character_snapshot_json", patch.characterSnapshotJson);
    if (patch.workspacePath !== undefined) add("workspace_path", patch.workspacePath);
    if (patch.isPinned !== undefined) add("is_pinned", patch.isPinned ? 1 : 0);
    if (columns.length === 0 && !patch.binding) throw new TypeError("Session lifecycle mutation has no projection change.");

    const ownsTransaction = !this.transactionActive;
    if (ownsTransaction) this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const current = this.db.prepare("SELECT id FROM sessions_v6 WHERE id = ? AND deleted_at IS NULL")
        .get(sessionId) as { id: string } | undefined;
      if (!current) throw new Error(`Session was not found: ${sessionId}`);
      const changed = this.db.prepare(`
        UPDATE sessions_v6 SET resource_revision = resource_revision + 1
        WHERE id = ? AND deleted_at IS NULL AND resource_revision = ?
      `).run(sessionId, input.expectedRevision);
      if (changed.changes !== 1) {
        const currentRevision = getSessionResourceRevision(this.db, sessionId);
        throw new SessionLifecycleOperationRevisionConflictError(
          `The Session resource revision is stale (expected ${input.expectedRevision}, current ${currentRevision ?? "missing"}).`,
        );
      }
      const revision = input.expectedRevision + 1;
      if (columns.length > 0) {
        columns.push("updated_at = ?", "last_active_at = ?");
        values.push(occurredAt, occurredAt, sessionId);
        this.db.prepare(`UPDATE sessions_v6 SET ${columns.join(", ")} WHERE id = ?`).run(...values);
      }
      if (patch.binding) {
        this.db.prepare(`
          UPDATE session_role_bindings_v6
          SET session_role = ?, role_contract_revision = ?, root_session_id = ?, parent_session_id = ?, delegation_depth = ?
          WHERE session_id = ?
        `).run(
          patch.binding.sessionRole,
          patch.binding.roleContractRevision,
          patch.binding.rootSessionId,
          patch.binding.parentSessionId,
          patch.binding.delegationDepth,
          sessionId,
        );
      }
      appendSessionResourceEvent(this.db, {
        sessionId,
        revision,
        eventKind: input.eventKind,
        proof: input.proof,
        operationId: input.operationId,
        idempotencyKey: input.idempotencyKey ?? null,
        occurredAt,
        payload: { ...(input.payload ?? {}), binding: patch.binding ?? null },
      });
      if (ownsTransaction) this.db.exec("COMMIT");
      return revision;
    } catch (error) {
      if (ownsTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  commitLifecycleMutationAtomic(
    input: CommitLifecycleMutationInput,
    applyProjection: () => unknown,
  ): SessionLifecycleOperationRecord {
    const record = this.require(input.operationId);
    if (record.revision !== input.expectedOperationRevision) {
      throw new SessionLifecycleOperationRevisionConflictError("The lifecycle operation revision is stale.");
    }
    const nextRevision = input.expectedOperationRevision + 1;
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    this.transactionActive = true;
    try {
      const result = applyProjection();
      const effects = { ...record.effects, database: "committed" as const };
      const changed = this.db.prepare(`
        UPDATE session_lifecycle_operations_v6
        SET revision = ?, state = 'running', current_step = 'db_committed',
          effects_json = ?, result_json = ?, updated_at = ?
        WHERE operation_id = ? AND revision = ?
      `).run(nextRevision, JSON.stringify(effects), JSON.stringify(result), input.now, input.operationId, input.expectedOperationRevision);
      if (changed.changes !== 1) throw new SessionLifecycleOperationRevisionConflictError("The lifecycle operation revision is stale.");
      this.db.prepare(`
        INSERT INTO session_lifecycle_operation_events_v6
          (event_id, operation_id, revision, step, effect, payload_json, created_at)
        VALUES (?, ?, ?, 'db_committed', 'committed', ?, ?)
      `).run(randomUUID(), input.operationId, nextRevision, JSON.stringify({ result }), input.now);
      this.db.exec("COMMIT");
      return this.require(input.operationId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionActive = false;
    }
  }

  complete(operationId: string, expectedRevision: number, result: unknown, occurredAt = new Date().toISOString()): SessionLifecycleOperationRecord {
    return this.finish(operationId, expectedRevision, "committed", result, null, occurredAt);
  }

  reject(operationId: string, expectedRevision: number, error: unknown, occurredAt = new Date().toISOString()): SessionLifecycleOperationRecord {
    return this.finish(operationId, expectedRevision, "rejected", null, error, occurredAt);
  }

  markRecoveryRequired(operationId: string, expectedRevision: number, error: unknown, occurredAt = new Date().toISOString()): SessionLifecycleOperationRecord {
    return this.finish(operationId, expectedRevision, "recovery-required", null, error, occurredAt);
  }

  listPending(limit = 100): SessionLifecycleOperationRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("Session lifecycle recovery limit must be between 1 and 1000.");
    const rows = this.db.prepare(`
      SELECT * FROM session_lifecycle_operations_v6
      WHERE state IN ('prepared', 'running', 'recovery-required')
      ORDER BY updated_at ASC, operation_id ASC LIMIT ?
    `).all(limit) as OperationRow[];
    return rows.map((row) => this.toRecord(row));
  }

  listEvents(operationId: string): Array<{ eventId: string; revision: number; step: string; effect: SessionLifecycleEffect; payload: Record<string, unknown>; createdAt: string }> {
    const rows = this.db.prepare(`
      SELECT event_id, revision, step, effect, payload_json, created_at
      FROM session_lifecycle_operation_events_v6 WHERE operation_id = ? ORDER BY revision ASC
    `).all(assertText(operationId, "operationId")) as Array<{ event_id: string; revision: number; step: string; effect: SessionLifecycleEffect; payload_json: string; created_at: string }>;
    return rows.map((row) => ({ eventId: row.event_id, revision: row.revision, step: row.step, effect: row.effect, payload: parseObject(row.payload_json, "event payload"), createdAt: row.created_at }));
  }

  /** Validates durable recovery projections after a process restart. */
  verifyRecoveryRecords(): void {
    const rows = this.db.prepare("SELECT * FROM session_lifecycle_operations_v6 ORDER BY operation_id")
      .all() as OperationRow[];
    const readEvents = this.db.prepare(`
      SELECT revision, step, effect, payload_json
      FROM session_lifecycle_operation_events_v6
      WHERE operation_id = ? ORDER BY revision ASC
    `);
    for (const row of rows) {
      this.toRecord(row);
      const events = readEvents.all(row.operation_id) as Array<{
        revision: number;
        step: string;
        effect: SessionLifecycleEffect;
        payload_json: string;
      }>;
      if (events.length === 0 || events[0].revision !== 1 || events[0].step !== "prepared" || events[0].effect !== "none") {
        throw new Error(`Session lifecycle recovery history has no valid prepared baseline: ${row.operation_id}`);
      }
      events.forEach((event, index) => {
        if (event.revision !== index + 1) throw new Error(`Session lifecycle recovery history has a revision gap: ${row.operation_id}`);
        parseObject(event.payload_json, "event payload");
      });
      const last = events.at(-1)!;
      if (last.revision !== row.revision || last.step !== row.current_step) {
        throw new Error(`Session lifecycle recovery projection disagrees with event history: ${row.operation_id}`);
      }
      if ((row.state === "committed" || row.state === "rejected" || row.state === "recovery-required") && last.step !== "terminal") {
        throw new Error(`Terminal Session lifecycle operation has no terminal event: ${row.operation_id}`);
      }
      const effects = parseObject(row.effects_json, "effects");
      for (const [step, effect] of Object.entries(effects)) {
        const event = events.find((candidate) => candidate.step === step);
        if (!event || event.effect !== effect) throw new Error(`Session lifecycle effect does not match event history: ${row.operation_id}:${step}`);
      }
    }
  }

  close(): void {
    if (this.ownsDatabase) this.db.close();
  }

  private finish(operationId: string, expectedRevision: number, state: "committed" | "rejected" | "recovery-required", result: unknown, error: unknown, occurredAt: string): SessionLifecycleOperationRecord {
    const row = this.require(operationId);
    if (row.revision !== expectedRevision) throw new SessionLifecycleOperationRevisionConflictError("The lifecycle operation revision is stale.");
    const nextRevision = expectedRevision + 1;
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const changed = this.db.prepare(`
        UPDATE session_lifecycle_operations_v6
        SET revision = ?, state = ?, current_step = 'terminal', result_json = ?, error_json = ?, updated_at = ?
        WHERE operation_id = ? AND revision = ?
      `).run(nextRevision, state, result === null ? null : JSON.stringify(result), error === null ? null : JSON.stringify(error), occurredAt, operationId, expectedRevision);
      if (changed.changes !== 1) throw new SessionLifecycleOperationRevisionConflictError("The lifecycle operation revision is stale.");
      this.db.prepare(`
        INSERT INTO session_lifecycle_operation_events_v6
          (event_id, operation_id, revision, step, effect, payload_json, created_at)
        VALUES (?, ?, ?, 'terminal', ?, ?, ?)
      `).run(randomUUID(), operationId, nextRevision, state === "committed" ? "committed" : state === "recovery-required" ? "unknown" : "none", JSON.stringify({ result, error }), occurredAt);
      this.db.exec("COMMIT");
    } catch (caught) {
      this.db.exec("ROLLBACK");
      throw caught;
    }
    return this.require(operationId);
  }

  private require(operationId: string): SessionLifecycleOperationRecord {
    const row = this.requireRow(operationId);
    return this.toRecord(row);
  }

  private requireRow(operationId: string): OperationRow {
    const row = this.db.prepare("SELECT * FROM session_lifecycle_operations_v6 WHERE operation_id = ?")
      .get(operationId) as OperationRow | undefined;
    if (!row) throw new Error(`Session lifecycle operation was not found: ${operationId}`);
    return row;
  }

  private toRecord(row: OperationRow): SessionLifecycleOperationRecord {
    return {
      operationId: row.operation_id,
      operation: row.operation,
      principalKind: row.principal_kind,
      principalId: row.principal_id,
      requestFingerprint: row.request_fingerprint,
      idempotencyKey: row.idempotency_key,
      targetSessionId: row.target_session_id,
      sourceRootSessionId: row.source_root_session_id,
      destinationRootSessionId: row.destination_root_session_id,
      revision: row.revision,
      state: row.state,
      currentStep: row.current_step,
      manifest: parseObject(row.manifest_json, "manifest"),
      reservedResourceIds: parseArray(row.reserved_resource_ids_json),
      effects: parseObject(row.effects_json, "effects") as Record<string, SessionLifecycleEffect>,
      result: parseNullableJson(row.result_json),
      error: parseNullableJson(row.error_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

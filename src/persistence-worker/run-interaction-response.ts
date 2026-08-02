import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { isPlainObject } from "../shared/persistence-runtime-protocol.js";
import type {
  RepositoryCommandErrorCode,
  RepositoryCommandResult,
  RunInteractionResponseAdmissionCommand,
  RunInteractionResponseMarkWriteAttemptCommand,
  RunInteractionResponseResult,
  RunInteractionResponseSettlementCommand,
} from "../shared/repository-write-model.js";
import type {
  RunInteractionResponseReplayProbeRequest,
  RunInteractionResponseReplayProbeResult,
} from "../shared/repository-read-model.js";

export const RUN_INTERACTION_RESPONSE_IDEMPOTENCY_OPERATION = "run.interaction.respond";
const FINGERPRINT_DOMAIN = "withmate:run.interaction.respond:v1";

export function interactionResponseFingerprint(input: InteractionFingerprintInput): string | undefined {
  let response: unknown;
  try {
    response = JSON.parse(input.canonicalResponseJson);
  } catch {
    return undefined;
  }
  if (
    !isPlainObject(response) ||
    canonicalJsonString(response) !== input.canonicalResponseJson ||
    Buffer.byteLength(input.canonicalResponseJson) > 64 * 1024
  ) {
    return undefined;
  }
  const semanticRequest = canonicalJsonString({
    sessionId: input.sessionId,
    runId: input.runId,
    interactionKind: input.interactionKind,
    interactionId: input.interactionId,
    response,
  });
  return createHash("sha256").update(FINGERPRINT_DOMAIN).update("\0").update(semanticRequest).digest("hex");
}

export function admitRunInteractionResponse(
  database: DatabaseSync,
  command: RunInteractionResponseAdmissionCommand,
  fingerprint: string,
  now: number,
  ephemeralBindingOwners: ReadonlyMap<string, string>,
): RepositoryCommandResult<RunInteractionResponseResult> {
  const existing = readIdempotencyRecord(database, command.idempotencyKey);
  if (existing !== undefined) {
    expireCompletedIdempotencyRecord(database, command.idempotencyKey, existing, now);
    return replayFromIdempotency(
      database,
      existing,
      command.sessionId,
      command.runId,
      command.interactionId,
      fingerprint,
      now,
    );
  }
  if (readIdempotencyClaimKind(database, command.idempotencyKey) !== undefined) {
    return failure("idempotency_conflict", "Idempotency key was used differently.");
  }
  if (
    database
      .prepare("SELECT 1 FROM run_interaction_responses WHERE run_id = ? AND interaction_id = ?")
      .get(command.runId, command.interactionId) !== undefined
  ) {
    return failure("lifecycle_conflict", "Interaction response was already admitted with a different key.");
  }

  const gate = database
    .prepare(
      `
      SELECT s.lifecycle_status, s.provider_id AS session_provider_id,
        r.phase AS run_phase,
        json_extract(r.execution_snapshot_json, '$.providerId') AS snapshot_provider_id,
        json_extract(r.execution_snapshot_json, '$.definitionVersion') AS snapshot_definition_version,
        a.attempt_state, a.provider_binding_id, a.external_execution_id,
        b.persistence_mode, b.binding_state, b.external_conversation_id,
        d.dispatch_state
      FROM sessions s
      JOIN runs r ON r.session_id = s.id AND r.id = ?
      JOIN run_attempts a ON a.run_id = r.id AND a.id = ?
      JOIN provider_bindings b ON b.id = a.provider_binding_id
        AND b.session_id = s.id AND b.provider_id = s.provider_id
        AND EXISTS (
          SELECT 1
          FROM run_attempts creator_a
          JOIN runs creator_r ON creator_r.id = creator_a.run_id
          WHERE creator_a.id = b.created_by_run_attempt_id
            AND creator_r.session_id = s.id
        )
        AND (b.persistence_mode = 'persistent' OR b.created_by_run_attempt_id = a.id)
      JOIN run_dispatches d ON d.run_attempt_id = a.id
      WHERE s.id = ? AND s.workspace_key = ?
    `,
    )
    .get(command.runId, command.attemptId, command.sessionId, command.workspaceKey) as InteractionGateRow | undefined;
  if (gate === undefined) return failure("not_found", "Interaction response target was not found.");
  if (
    gate.lifecycle_status !== "active" ||
    gate.run_phase !== "active" ||
    gate.attempt_state !== "active" ||
    gate.provider_binding_id !== command.bindingId ||
    gate.binding_state !== "active" ||
    gate.dispatch_state !== "accepted"
  ) {
    return failure("lifecycle_conflict", "Interaction response admission Gate is not satisfied.");
  }
  if (
    gate.session_provider_id !== command.providerId ||
    gate.snapshot_provider_id !== command.providerId ||
    gate.snapshot_definition_version !== command.definitionVersion ||
    gate.external_conversation_id !== command.externalConversationId ||
    gate.external_execution_id !== command.externalExecutionId
  ) {
    return failure("reference_invalid", "Interaction response owner tuple does not match.");
  }
  if (!hasLiveBindingOwnership(command.bindingId, command.ephemeralOwnerToken, gate, ephemeralBindingOwners)) {
    return failure("reference_invalid", "Interaction response live ownership is unavailable.");
  }

  const responseRefId = randomUUID();
  database
    .prepare(
      `
      INSERT INTO run_interaction_responses (
        id, session_id, run_id, run_attempt_id, provider_binding_id,
        interaction_id, provider_id, definition_version, interaction_kind,
        semantic_action, effect_certainty, admitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admitted', ?)
    `,
    )
    .run(
      responseRefId,
      command.sessionId,
      command.runId,
      command.attemptId,
      command.bindingId,
      command.interactionId,
      command.providerId,
      command.definitionVersion,
      command.interactionKind,
      command.semanticAction,
      now,
    );
  database
    .prepare(
      `
      INSERT INTO idempotency_records (
        idempotency_key, scope_session_id, operation, request_fingerprint,
        record_state, response_ref_type, response_ref_id, created_at
      ) VALUES (?, ?, ?, ?, 'in_progress', 'interaction', ?, ?)
    `,
    )
    .run(
      command.idempotencyKey,
      command.sessionId,
      RUN_INTERACTION_RESPONSE_IDEMPOTENCY_OPERATION,
      fingerprint,
      responseRefId,
      now,
    );
  const value = readRunInteractionResponseResult(database, responseRefId, command.sessionId, command.runId);
  if (value === undefined) throw new TypeError("Admitted interaction response cannot be projected.");
  return success(value, false);
}

function expireCompletedIdempotencyRecord(
  database: DatabaseSync,
  idempotencyKey: string,
  row: IdempotencyRow,
  now: number,
): void {
  if (row.record_state !== "completed" || row.expires_at === null || row.expires_at > now) return;
  database
    .prepare(
      `
      UPDATE idempotency_records
      SET record_state = 'expired', response_kind = NULL, response_ref_type = NULL,
        response_ref_id = NULL, response_envelope_json = NULL
      WHERE idempotency_key = ? AND record_state = 'completed'
    `,
    )
    .run(idempotencyKey);
}

export function markRunInteractionResponseWriteAttempt(
  database: DatabaseSync,
  command: RunInteractionResponseMarkWriteAttemptCommand,
  now: number,
): RepositoryCommandResult<RunInteractionResponseResult> {
  const current = readScopedResult(database, command);
  if (current === undefined) return failure("reference_invalid", "Interaction response reference is invalid.");
  if (!hasLinkedIdempotency(database, current.responseRefId, current.sessionId, current.effectCertainty)) {
    return failure("reference_invalid", "Interaction response idempotency reference is invalid.");
  }
  if (current.effectCertainty !== "admitted") return success(current, true);
  const update = database
    .prepare(
      `
      UPDATE run_interaction_responses
      SET effect_certainty = 'write_attempted', write_attempted_at = ?
      WHERE id = ? AND effect_certainty = 'admitted'
    `,
    )
    .run(now, command.responseRefId);
  if (update.changes !== 1) return failure("lifecycle_conflict", "Interaction response write attempt conflicted.");
  const value = readScopedResult(database, command);
  if (value === undefined) throw new TypeError("Interaction response write attempt cannot be projected.");
  return success(value, false);
}

export function settleRunInteractionResponse(
  database: DatabaseSync,
  command: RunInteractionResponseSettlementCommand,
  now: number,
  retentionMs: number,
): RepositoryCommandResult<RunInteractionResponseResult> {
  const current = readScopedResult(database, command);
  if (current === undefined) return failure("reference_invalid", "Interaction response reference is invalid.");
  if (!hasLinkedIdempotency(database, current.responseRefId, current.sessionId, current.effectCertainty)) {
    return failure("reference_invalid", "Interaction response idempotency reference is invalid.");
  }
  if (isSameSettlement(current, command.outcome)) return success(current, true);
  if (!canSettle(current, command.outcome)) {
    return failure("lifecycle_conflict", "Interaction response certainty cannot regress or conflict.");
  }
  applySettlement(database, current, command.outcome, now, retentionMs);
  const value = readScopedResult(database, command);
  if (value === undefined) throw new TypeError("Settled interaction response cannot be projected.");
  return success(value, false);
}

export function repairRunInteractionResponses(database: DatabaseSync, now: number, retentionMs: number): number {
  const rows = database
    .prepare(
      `
      SELECT rr.*
      FROM run_interaction_responses rr
      JOIN idempotency_records i
        ON i.response_ref_type = 'interaction' AND i.response_ref_id = rr.id
        AND i.scope_session_id = rr.session_id
        AND i.operation = ? AND i.record_state = 'in_progress'
      WHERE rr.effect_certainty IN ('admitted', 'write_attempted')
      ORDER BY rr.admitted_at, rr.id
    `,
    )
    .all(RUN_INTERACTION_RESPONSE_IDEMPOTENCY_OPERATION) as unknown as readonly InteractionResponseRow[];
  for (const row of rows) {
    const current = projectRow(row);
    const outcome: RunInteractionResponseSettlementCommand["outcome"] =
      current.effectCertainty === "admitted"
        ? { effectCertainty: "not_sent", resolutionCode: "owner_lost_before_write" }
        : { effectCertainty: "ambiguous", resolutionCode: "process_unknown" };
    applySettlement(database, current, outcome, now, retentionMs);
  }
  return rows.length;
}

export function probeRunInteractionResponseReplay(
  database: DatabaseSync,
  request: RunInteractionResponseReplayProbeRequest,
  now: number,
): RunInteractionResponseReplayProbeResult {
  const fingerprint = interactionResponseFingerprint(request);
  if (fingerprint === undefined) {
    return replayProbeFailure("idempotency_conflict", "Interaction response fingerprint is invalid.");
  }
  const row = readIdempotencyRecord(database, request.idempotencyKey);
  if (row === undefined) {
    return readIdempotencyClaimKind(database, request.idempotencyKey) === undefined
      ? { kind: "absent" }
      : replayProbeFailure("idempotency_conflict", "Idempotency key was used differently.");
  }
  const replay = replayFromIdempotency(
    database,
    row,
    request.sessionId,
    request.runId,
    request.interactionId,
    fingerprint,
    now,
  );
  return replay.ok ? { kind: "replay", value: replay.value } : { kind: "failure", error: replay.error };
}

export function readRunInteractionResponseResult(
  database: DatabaseSync,
  responseRefId: string,
  sessionId: string,
  runId: string,
  interactionId?: string,
): RunInteractionResponseResult | undefined {
  const row = database
    .prepare(
      `
      SELECT * FROM run_interaction_responses
      WHERE id = ? AND session_id = ? AND run_id = ?
        AND (? IS NULL OR interaction_id = ?)
    `,
    )
    .get(responseRefId, sessionId, runId, interactionId ?? null, interactionId ?? null) as
    InteractionResponseRow | undefined;
  return row === undefined ? undefined : projectRow(row);
}

function replayFromIdempotency(
  database: DatabaseSync,
  row: IdempotencyRow,
  sessionId: string,
  runId: string,
  interactionId: string,
  fingerprint: string,
  now: number,
): RepositoryCommandResult<RunInteractionResponseResult> {
  if (
    row.scope_session_id !== sessionId ||
    row.operation !== RUN_INTERACTION_RESPONSE_IDEMPOTENCY_OPERATION ||
    row.request_fingerprint !== fingerprint
  ) {
    return failure("idempotency_conflict", "Idempotency key was used differently.");
  }
  if (row.record_state === "expired" || (row.expires_at !== null && row.expires_at <= now)) {
    return failure("idempotency_expired", "Idempotency key has expired.");
  }
  if (row.response_ref_type !== "interaction" || row.response_ref_id === null) {
    return failure("reference_invalid", "Interaction response reference is invalid.");
  }
  const current = readRunInteractionResponseResult(database, row.response_ref_id, sessionId, runId, interactionId);
  if (current === undefined) return failure("reference_invalid", "Interaction response reference is invalid.");
  if (row.record_state === "in_progress") {
    if (
      row.response_kind !== null ||
      row.response_envelope_json !== null ||
      (current.effectCertainty !== "admitted" && current.effectCertainty !== "write_attempted")
    ) {
      return failure("reference_invalid", "Interaction response in-progress receipt is invalid.");
    }
    return success(current, true);
  }
  if (row.response_kind !== "success" || row.response_envelope_json === null) {
    return failure("reference_invalid", "Interaction response receipt is invalid.");
  }
  let receipt: unknown;
  try {
    receipt = JSON.parse(row.response_envelope_json);
  } catch {
    return failure("reference_invalid", "Interaction response receipt is invalid.");
  }
  if (canonicalJsonString(receipt) !== canonicalJsonString(current)) {
    return failure("reference_invalid", "Interaction response receipt is invalid.");
  }
  return success(current, true);
}

function readScopedResult(
  database: DatabaseSync,
  command: RunInteractionResponseMarkWriteAttemptCommand | RunInteractionResponseSettlementCommand,
): RunInteractionResponseResult | undefined {
  const row = database
    .prepare(
      `
      SELECT rr.*
      FROM run_interaction_responses rr
      JOIN sessions s ON s.id = rr.session_id
      WHERE rr.id = ? AND rr.session_id = ? AND s.workspace_key = ?
        AND rr.run_id = ? AND rr.interaction_id = ?
    `,
    )
    .get(command.responseRefId, command.sessionId, command.workspaceKey, command.runId, command.interactionId) as
    InteractionResponseRow | undefined;
  return row === undefined ? undefined : projectRow(row);
}

function applySettlement(
  database: DatabaseSync,
  current: RunInteractionResponseResult,
  outcome: RunInteractionResponseSettlementCommand["outcome"],
  now: number,
  retentionMs: number,
): void {
  const update = database
    .prepare(
      `
      UPDATE run_interaction_responses
      SET effect_certainty = ?, resolution_code = ?, settled_at = ?
      WHERE id = ? AND effect_certainty = ?
    `,
    )
    .run(outcome.effectCertainty, outcome.resolutionCode, now, current.responseRefId, current.effectCertainty);
  if (update.changes !== 1) throw new TypeError("Interaction response settlement conflicted.");
  const settled = readRunInteractionResponseResult(
    database,
    current.responseRefId,
    current.sessionId,
    current.runId,
    current.interactionId,
  );
  if (settled === undefined) throw new TypeError("Settled interaction response cannot be projected.");
  const receipt = JSON.stringify(settled);
  if (Buffer.byteLength(receipt) > 16 * 1024) throw new RangeError("Interaction response receipt is too large.");
  const idempotencyUpdate = database
    .prepare(
      `
      UPDATE idempotency_records
      SET record_state = 'completed', response_kind = 'success',
        response_envelope_json = ?, completed_at = COALESCE(completed_at, ?),
        expires_at = COALESCE(expires_at, ?)
      WHERE response_ref_type = 'interaction' AND response_ref_id = ?
        AND operation = ? AND scope_session_id = ?
        AND record_state IN ('in_progress', 'completed')
    `,
    )
    .run(
      receipt,
      now,
      now + retentionMs,
      current.responseRefId,
      RUN_INTERACTION_RESPONSE_IDEMPOTENCY_OPERATION,
      current.sessionId,
    );
  if (idempotencyUpdate.changes !== 1) throw new TypeError("Interaction response idempotency completion failed.");
  insertSettlementEvent(database, settled, now);
}

function insertSettlementEvent(database: DatabaseSync, settled: RunInteractionResponseResult, now: number): void {
  if (
    settled.effectCertainty !== "resolved" &&
    settled.effectCertainty !== "ambiguous" &&
    settled.effectCertainty !== "not_sent"
  ) {
    throw new TypeError("Interaction response event requires terminal certainty.");
  }
  const ordinal = (
    database
      .prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM run_events WHERE run_id = ?")
      .get(settled.runId) as { ordinal: number }
  ).ordinal;
  database
    .prepare(
      `
      INSERT INTO run_events (
        id, run_id, ordinal, event_code, subject_type, subject_id, dedupe_key, summary, created_at
      ) VALUES (?, ?, ?, ?, 'interaction', ?, ?, ?, ?)
    `,
    )
    .run(
      randomUUID(),
      settled.runId,
      ordinal,
      `run.interaction.response.${settled.effectCertainty}`,
      settled.interactionId,
      `interaction-response:${settled.responseRefId}:${settled.effectCertainty}`,
      `Interaction response ${settled.effectCertainty}.`,
      now,
    );
}

function canSettle(
  current: RunInteractionResponseResult,
  outcome: RunInteractionResponseSettlementCommand["outcome"],
): boolean {
  if (current.effectCertainty === "admitted") {
    return (
      outcome.effectCertainty === "not_sent" &&
      (outcome.resolutionCode === "owner_lost_before_write" || outcome.resolutionCode === "adapter_rejected")
    );
  }
  if (current.effectCertainty === "write_attempted") {
    return (
      outcome.effectCertainty === "resolved" ||
      outcome.effectCertainty === "ambiguous" ||
      (outcome.effectCertainty === "not_sent" &&
        (outcome.resolutionCode === "transport_not_sent" || outcome.resolutionCode === "adapter_rejected"))
    );
  }
  return current.effectCertainty === "ambiguous" && outcome.effectCertainty === "resolved";
}

function isSameSettlement(
  current: RunInteractionResponseResult,
  outcome: RunInteractionResponseSettlementCommand["outcome"],
): boolean {
  return current.effectCertainty === outcome.effectCertainty && current.resolutionCode === outcome.resolutionCode;
}

function hasLinkedIdempotency(
  database: DatabaseSync,
  responseRefId: string,
  sessionId: string,
  certainty: RunInteractionResponseResult["effectCertainty"],
): boolean {
  const expectedState = certainty === "admitted" || certainty === "write_attempted" ? "in_progress" : "completed";
  return (
    database
      .prepare(
        `
        SELECT 1 FROM idempotency_records
        WHERE response_ref_type = 'interaction' AND response_ref_id = ?
          AND scope_session_id = ? AND operation = ? AND record_state = ?
      `,
      )
      .get(responseRefId, sessionId, RUN_INTERACTION_RESPONSE_IDEMPOTENCY_OPERATION, expectedState) !== undefined
  );
}

function hasLiveBindingOwnership(
  bindingId: string,
  ephemeralOwnerToken: string | null,
  gate: Pick<InteractionGateRow, "persistence_mode">,
  owners: ReadonlyMap<string, string>,
): boolean {
  return gate.persistence_mode === "persistent"
    ? ephemeralOwnerToken === null
    : ephemeralOwnerToken !== null && owners.get(bindingId) === ephemeralOwnerToken;
}

function projectRow(row: InteractionResponseRow): RunInteractionResponseResult {
  const base = {
    responseRefId: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    interactionId: row.interaction_id,
    providerId: row.provider_id,
    definitionVersion: row.definition_version,
    interactionKind: row.interaction_kind,
    semanticAction: row.semantic_action,
    admittedAt: row.admitted_at,
  } as const;
  switch (row.effect_certainty) {
    case "admitted":
      return { ...base, effectCertainty: "admitted", writeAttemptedAt: null, settledAt: null, resolutionCode: null };
    case "write_attempted":
      if (row.write_attempted_at === null) throw new TypeError("Interaction response write timestamp is missing.");
      return {
        ...base,
        effectCertainty: "write_attempted",
        writeAttemptedAt: row.write_attempted_at,
        settledAt: null,
        resolutionCode: null,
      };
    case "resolved":
      if (row.write_attempted_at === null || row.settled_at === null || row.resolution_code !== "provider_resolved") {
        throw new TypeError("Resolved interaction response is invalid.");
      }
      return {
        ...base,
        effectCertainty: "resolved",
        writeAttemptedAt: row.write_attempted_at,
        settledAt: row.settled_at,
        resolutionCode: "provider_resolved",
      };
    case "ambiguous":
      if (
        row.write_attempted_at === null ||
        row.settled_at === null ||
        (row.resolution_code !== "transport_unknown" && row.resolution_code !== "process_unknown")
      ) {
        throw new TypeError("Ambiguous interaction response is invalid.");
      }
      return {
        ...base,
        effectCertainty: "ambiguous",
        writeAttemptedAt: row.write_attempted_at,
        settledAt: row.settled_at,
        resolutionCode: row.resolution_code,
      };
    case "not_sent":
      if (row.settled_at === null) throw new TypeError("Not-sent interaction response is invalid.");
      if (row.write_attempted_at === null) {
        if (row.resolution_code !== "owner_lost_before_write" && row.resolution_code !== "adapter_rejected") {
          throw new TypeError("Not-sent interaction response is invalid.");
        }
        return {
          ...base,
          effectCertainty: "not_sent",
          writeAttemptedAt: null,
          settledAt: row.settled_at,
          resolutionCode: row.resolution_code,
        };
      }
      if (row.resolution_code !== "transport_not_sent" && row.resolution_code !== "adapter_rejected") {
        throw new TypeError("Not-sent interaction response is invalid.");
      }
      return {
        ...base,
        effectCertainty: "not_sent",
        writeAttemptedAt: row.write_attempted_at,
        settledAt: row.settled_at,
        resolutionCode: row.resolution_code,
      };
  }
}

function readIdempotencyRecord(database: DatabaseSync, key: string): IdempotencyRow | undefined {
  return database.prepare("SELECT * FROM idempotency_records WHERE idempotency_key = ?").get(key) as
    IdempotencyRow | undefined;
}

function readIdempotencyClaimKind(database: DatabaseSync, key: string): string | undefined {
  return (
    database.prepare("SELECT claim_kind FROM idempotency_key_claims WHERE idempotency_key = ?").get(key) as
      { claim_kind: string } | undefined
  )?.claim_kind;
}

function canonicalJsonString(value: unknown): string {
  return JSON.stringify(toCanonicalJson(value));
}

function toCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCanonicalJson);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, toCanonicalJson(value[key])]),
    );
  }
  return value;
}

function success<T>(value: T, replayed: boolean): RepositoryCommandResult<T> {
  return { ok: true, value, replayed };
}

function failure<T>(
  code: Exclude<RepositoryCommandErrorCode, "capacity_exceeded">,
  message: string,
  retryable = false,
): RepositoryCommandResult<T> {
  return { ok: false, error: { code, message, retryable }, replayed: false };
}

function replayProbeFailure(
  code: Extract<RepositoryCommandErrorCode, "idempotency_conflict" | "idempotency_expired" | "reference_invalid">,
  message: string,
): Extract<RunInteractionResponseReplayProbeResult, { kind: "failure" }> {
  return { kind: "failure", error: { code, message, retryable: false } };
}

type InteractionGateRow = Readonly<{
  lifecycle_status: string;
  session_provider_id: string;
  run_phase: string;
  snapshot_provider_id: string | null;
  snapshot_definition_version: string | null;
  attempt_state: string;
  provider_binding_id: string;
  external_execution_id: string | null;
  persistence_mode: "persistent" | "ephemeral";
  binding_state: string;
  external_conversation_id: string | null;
  dispatch_state: string;
}>;

type InteractionFingerprintInput = Readonly<{
  sessionId: string;
  runId: string;
  interactionKind: string;
  interactionId: string;
  canonicalResponseJson: string;
}>;

type InteractionResponseRow = Readonly<{
  id: string;
  session_id: string;
  run_id: string;
  run_attempt_id: string;
  provider_binding_id: string;
  interaction_id: string;
  provider_id: string;
  definition_version: string;
  interaction_kind: string;
  semantic_action: RunInteractionResponseResult["semanticAction"];
  effect_certainty: RunInteractionResponseResult["effectCertainty"];
  resolution_code: RunInteractionResponseResult["resolutionCode"];
  admitted_at: number;
  write_attempted_at: number | null;
  settled_at: number | null;
}>;

type IdempotencyRow = Readonly<{
  scope_session_id: string;
  operation: string;
  request_fingerprint: string;
  record_state: "in_progress" | "completed" | "expired";
  response_kind: "success" | "error" | null;
  response_ref_type: "run" | "session" | "delivery" | "interaction" | "none" | null;
  response_ref_id: string | null;
  response_envelope_json: string | null;
  expires_at: number | null;
}>;

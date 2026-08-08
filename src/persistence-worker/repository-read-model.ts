import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  REPOSITORY_READ_LIMITS,
  REPOSITORY_READ_OPERATIONS,
  type RunAdmissionReplayProbeResult,
  type RunCancelReplayProbeResult,
  type RunInputReplayProbeResult,
  type RunInteractionResponseReplayProbeRequest,
  type RunInteractionResponseReplayProbeResult,
  type RunOutputListItem,
} from "../shared/repository-read-model.js";
import type {
  RepositoryCommandErrorCode,
  RunCancelAdmissionResult,
  RunInputAdmissionResult,
} from "../shared/repository-write-model.js";
import { isCanonicalUuid, isPlainObject } from "../shared/persistence-runtime-protocol.js";
import { isLocalRepositoryKey, SESSION_METADATA_LIMITS, sessionSearchKey } from "../shared/session-metadata.js";
import { prepareRunCancelIdempotency, projectRunCancelAdmissionResult } from "./run-cancel-idempotency.js";
import {
  decodeRunAdmissionProbeCommand,
  decodeRunAdmissionReplay,
  prepareNormalRunAdmissionIdempotency,
  prepareRetryRunAdmissionIdempotency,
} from "./run-admission-idempotency.js";
import { prepareRunInputIdempotency } from "./run-input-idempotency.js";
import { probeRunInteractionResponseReplay } from "./run-interaction-response.js";

const INLINE_MESSAGE_BYTES = 64 * 1024;
const MAX_PAGE_JSON_BYTES = 192 * 1024;
const SESSION_SEARCH_SQL_FUNCTION = "withmate_session_search_key";
const RUN_OUTPUT_CATEGORIES = [
  "assistant_detail",
  "operation",
  "interaction",
  "telemetry",
  "diagnostic",
  "provider_metadata",
] as const;

export const REPOSITORY_PAGE_SQL = {
  messages: `
    SELECT CASE WHEN m.id IS NULL THEN 1 ELSE 0 END AS scope_only,
           m.id, m.session_id, m.ordinal, m.role, m.content_byte_length, m.inline_content, m.created_at,
           s.workspace_key
    FROM sessions s
    LEFT JOIN (
      SELECT id, session_id, ordinal, role,
             length(CAST(content_blocks_json AS BLOB)) AS content_byte_length,
             CASE WHEN length(CAST(content_blocks_json AS BLOB)) <= ? THEN content_blocks_json END AS inline_content,
             created_at
      FROM messages
      WHERE session_id = ? AND ordinal > ?
      ORDER BY ordinal ASC LIMIT ?
    ) m ON m.session_id = s.id
    WHERE s.id = ? AND s.workspace_key = ?
    ORDER BY m.ordinal ASC
  `,
  runs: `
    SELECT CASE WHEN r.id IS NULL THEN 1 ELSE 0 END AS scope_only,
           r.id AS run_id, r.session_id, r.ordinal, r.initiating_message_id,
           r.final_assistant_message_id, r.retry_of_run_id, r.phase,
           r.failure_origin, r.error_summary, r.cancel_requested_at, r.cancel_acknowledged_at,
           r.created_at, r.started_at, r.terminal_at, r.updated_at,
           s.workspace_key
    FROM sessions s
    LEFT JOIN (
      SELECT id, session_id, ordinal, initiating_message_id, final_assistant_message_id,
             retry_of_run_id, phase, failure_origin, error_summary,
             cancel_requested_at, cancel_acknowledged_at,
             created_at, started_at, terminal_at, updated_at
      FROM runs
      WHERE session_id = ? AND ordinal > ?
      ORDER BY ordinal ASC LIMIT ?
    ) r ON r.session_id = s.id
    WHERE s.id = ? AND s.workspace_key = ?
    ORDER BY r.ordinal ASC
  `,
  runEvents: `
    SELECT e.id, e.run_id, e.ordinal, e.event_code, e.subject_type, e.subject_id, e.summary, e.created_at
    FROM run_events e
    JOIN runs r ON r.id = e.run_id JOIN sessions s ON s.id = r.session_id
    WHERE e.run_id = ? AND r.session_id = ? AND s.workspace_key = ? AND e.ordinal > ?
    ORDER BY e.ordinal ASC LIMIT ?
  `,
  runOutputs: `
    SELECT o.id, o.run_id, o.ordinal, o.category, o.kind, o.summary, o.completion_state,
           o.payload_state, o.payload_original_byte_length, o.stored_payload_id, o.redaction_state, o.created_at
    FROM run_output_items o
    JOIN runs r ON r.id = o.run_id JOIN sessions s ON s.id = r.session_id
    WHERE o.run_id = ? AND r.session_id = ? AND s.workspace_key = ?
      AND o.ordinal > ?
    ORDER BY o.ordinal ASC LIMIT ?
  `,
  runOutputsByCategory: `
    SELECT o.id, o.run_id, o.ordinal, o.category, o.kind, o.summary, o.completion_state,
           o.payload_state, o.payload_original_byte_length, o.stored_payload_id, o.redaction_state, o.created_at
    FROM run_output_items o
    JOIN runs r ON r.id = o.run_id JOIN sessions s ON s.id = r.session_id
    WHERE o.run_id = ? AND r.session_id = ? AND s.workspace_key = ?
      AND o.category = ? AND o.ordinal > ?
    ORDER BY o.ordinal ASC LIMIT ?
  `,
} as const;

export const REPOSITORY_RUN_OUTPUT_ITEM_SQL = `
  SELECT o.id, o.run_id, o.ordinal, o.category, o.kind, o.summary, o.completion_state,
         o.payload_state, o.payload_original_byte_length, o.stored_payload_id,
         o.redaction_state, o.created_at
  FROM run_output_items o
  JOIN runs r ON r.id = o.run_id
  JOIN sessions s ON s.id = r.session_id
  WHERE o.id = ? AND o.run_id = ? AND r.session_id = ? AND s.workspace_key = ?
`;

export const REPOSITORY_RECOVERY_CANDIDATE_SQL = `
  WITH page_runs AS MATERIALIZED (
    SELECT r.id, r.session_id, r.initiating_message_id, r.phase, r.external_side_effect_state,
           r.cancel_requested_at, r.created_at, r.updated_at, r.version,
           s.workspace_key, s.provider_id AS session_provider_id
    FROM runs r
    JOIN sessions s ON s.id = r.session_id
    WHERE r.phase IN ('queued', 'starting', 'active', 'canceling', 'finalizing')
      AND (? IS NULL OR r.created_at > ? OR (r.created_at = ? AND r.id > ?))
    ORDER BY r.created_at ASC, r.id ASC
    LIMIT ?
  ), current_attempts AS MATERIALIZED (
    SELECT a.* FROM run_attempts a
    JOIN page_runs r ON r.id = a.run_id
    WHERE a.attempt_state IN ('preparing', 'active')
  ), binding_candidates AS MATERIALIZED (
    SELECT a.id AS attempt_id, b.id AS binding_id
    FROM current_attempts a
    JOIN provider_bindings b ON b.id = a.provider_binding_id
    UNION
    SELECT a.id AS attempt_id, b.id AS binding_id
    FROM current_attempts a
    JOIN provider_bindings b ON b.created_by_run_attempt_id = a.id AND b.binding_state = 'creating'
  )
  SELECT r.id AS run_id, r.session_id, r.workspace_key, r.session_provider_id,
         r.phase AS run_phase, r.version AS run_version, r.initiating_message_id,
         r.created_at AS run_created_at,
         r.updated_at AS run_updated_at, r.cancel_requested_at, r.external_side_effect_state,
         (SELECT COUNT(*) FROM current_attempts ca WHERE ca.run_id = r.id) AS current_attempt_count,
         a.id AS attempt_id, a.ordinal AS attempt_ordinal, a.attempt_state,
         a.provider_binding_id AS attempt_provider_binding_id, a.external_execution_id,
         (SELECT COUNT(*) FROM binding_candidates bc WHERE bc.attempt_id = a.id) AS binding_candidate_count,
         b.id AS binding_id, b.session_id AS binding_session_id,
         b.provider_id AS binding_provider_id, b.persistence_mode, b.binding_state,
         b.created_by_run_attempt_id AS binding_creator_attempt_id,
         creator_a.run_id AS binding_creator_run_id,
         creator_r.session_id AS binding_creator_session_id,
         b.external_conversation_id,
         CASE WHEN a.id IS NULL THEN 0
              ELSE (SELECT COUNT(*) FROM run_dispatches rd WHERE rd.run_attempt_id = a.id)
         END AS dispatch_count,
         d.dispatch_state, d.provider_idempotency_key
  FROM page_runs r
  LEFT JOIN current_attempts a ON a.run_id = r.id
    AND (SELECT COUNT(*) FROM current_attempts ca WHERE ca.run_id = r.id) = 1
  LEFT JOIN provider_bindings b ON b.id = (
    SELECT bc.binding_id FROM binding_candidates bc
    WHERE bc.attempt_id = a.id
      AND (SELECT COUNT(*) FROM binding_candidates all_bc WHERE all_bc.attempt_id = a.id) = 1
    LIMIT 1
  )
  LEFT JOIN run_attempts creator_a ON creator_a.id = b.created_by_run_attempt_id
  LEFT JOIN runs creator_r ON creator_r.id = creator_a.run_id
  LEFT JOIN run_dispatches d ON d.run_attempt_id = a.id
  ORDER BY r.created_at ASC, r.id ASC
`;

const SESSION_PAGE_COLUMNS = `
  SELECT id, title, workspace_key, workspace_path, local_repository_key, repository_name,
         default_character_id, lifecycle_status,
         created_at, updated_at, last_activity_at
  FROM sessions`;
const SESSION_PAGE_PROJECTION = `
  SELECT s.*,
    (SELECT id FROM runs WHERE session_id = s.id
      AND phase IN ('queued','starting','active','canceling','finalizing') LIMIT 1) AS active_run_id,
    (SELECT created_at FROM runs WHERE session_id = s.id
      AND phase IN ('queued','starting','active','canceling','finalizing') LIMIT 1) AS active_run_created_at,
    (SELECT id FROM runs WHERE session_id = s.id ORDER BY ordinal DESC LIMIT 1) AS latest_run_id,
    (SELECT phase FROM runs WHERE session_id = s.id ORDER BY ordinal DESC LIMIT 1) AS latest_run_phase,
    (SELECT terminal_at FROM runs
      WHERE session_id = s.id ORDER BY ordinal DESC LIMIT 1) AS latest_run_terminal_at
  FROM page_sessions s
  ORDER BY s.last_activity_at DESC, s.id DESC`;

function sessionPageSql(filter: "all" | "lifecycle" | "workspace" | "workspace_lifecycle"): string {
  const scope =
    filter === "all"
      ? ""
      : filter === "lifecycle"
        ? "lifecycle_status = ? AND "
        : filter === "workspace"
          ? "workspace_key = ? AND "
          : "workspace_key = ? AND lifecycle_status = ? AND ";
  return `
    WITH page_sessions AS MATERIALIZED (
      ${SESSION_PAGE_COLUMNS}
      WHERE ${scope}(? IS NULL OR last_activity_at < ? OR (last_activity_at = ? AND id < ?))
      ORDER BY last_activity_at DESC, id DESC
      LIMIT ?
    )
    ${SESSION_PAGE_PROJECTION}
  `;
}

function filteredSessionPageSql(
  hasWorkspace: boolean,
  hasLifecycle: boolean,
  repositoryKeyCount: number,
  hasQuery: boolean,
): string {
  const filters = [
    ...(hasWorkspace ? ["workspace_key = ?"] : []),
    ...(hasLifecycle ? ["lifecycle_status = ?"] : []),
    ...(repositoryKeyCount === 0
      ? []
      : [`local_repository_key IN (${Array.from({ length: repositoryKeyCount }, () => "?").join(", ")})`]),
    ...(hasQuery
      ? [
          `(instr(${SESSION_SEARCH_SQL_FUNCTION}(title), ?) > 0 OR instr(${SESSION_SEARCH_SQL_FUNCTION}(repository_name), ?) > 0)`,
        ]
      : []),
  ];
  return `
    WITH page_sessions AS MATERIALIZED (
      ${SESSION_PAGE_COLUMNS}
      WHERE ${filters.length === 0 ? "" : `${filters.join(" AND ")} AND `}
        (? IS NULL OR last_activity_at < ? OR (last_activity_at = ? AND id < ?))
      ORDER BY last_activity_at DESC, id DESC
      LIMIT ?
    )
    ${SESSION_PAGE_PROJECTION}
  `;
}

export const REPOSITORY_SESSION_PAGE_SQL = {
  all: sessionPageSql("all"),
  lifecycle: sessionPageSql("lifecycle"),
  workspace: sessionPageSql("workspace"),
  workspaceLifecycle: sessionPageSql("workspace_lifecycle"),
} as const;

export type RepositoryReadOperation = Readonly<{
  requestClass: "read";
  execute: (payload: Readonly<Record<string, unknown>>) => Readonly<{ result: unknown }>;
}>;

export class RepositoryReadError extends Error {
  constructor(
    readonly code: "request_invalid" | "cursor_invalid" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

export function createRepositoryReadOperations(
  database: DatabaseSync,
  options: Readonly<{ clock?: () => number }> = {},
): ReadonlyMap<string, RepositoryReadOperation> {
  const clock = options.clock ?? Date.now;
  database.function(SESSION_SEARCH_SQL_FUNCTION, { deterministic: true }, (value) =>
    typeof value === "string" ? sessionSearchKey(value) : null,
  );
  const read = (execute: RepositoryReadOperation["execute"]): RepositoryReadOperation => ({
    requestClass: "read",
    execute,
  });
  return new Map([
    [REPOSITORY_READ_OPERATIONS.sessionsPage, read((payload) => ({ result: sessionsPage(database, payload) }))],
    [
      REPOSITORY_READ_OPERATIONS.localRepositoriesPage,
      read((payload) => ({ result: localRepositoriesPage(database, payload) })),
    ],
    [REPOSITORY_READ_OPERATIONS.sessionGet, read((payload) => ({ result: sessionGet(database, payload) }))],
    [REPOSITORY_READ_OPERATIONS.messagesPage, read((payload) => ({ result: messagesPage(database, payload) }))],
    [REPOSITORY_READ_OPERATIONS.runsPage, read((payload) => ({ result: runsPage(database, payload) }))],
    [REPOSITORY_READ_OPERATIONS.runGet, read((payload) => ({ result: runGet(database, payload) }))],
    [REPOSITORY_READ_OPERATIONS.runEventsPage, read((payload) => ({ result: runEventsPage(database, payload) }))],
    [REPOSITORY_READ_OPERATIONS.runOutputCounts, read((payload) => ({ result: runOutputCounts(database, payload) }))],
    [REPOSITORY_READ_OPERATIONS.runOutputsPage, read((payload) => ({ result: runOutputsPage(database, payload) }))],
    [REPOSITORY_READ_OPERATIONS.runOutputGet, read((payload) => ({ result: runOutputGet(database, payload) }))],
    [
      REPOSITORY_READ_OPERATIONS.runInputDeliveriesPage,
      read((payload) => ({ result: runInputDeliveriesPage(database, payload) })),
    ],
    [
      REPOSITORY_READ_OPERATIONS.runAdmissionReplayProbe,
      read((payload) => ({ result: runAdmissionReplayProbe(database, payload, clock) })),
    ],
    [
      REPOSITORY_READ_OPERATIONS.runInputReplayProbe,
      read((payload) => ({ result: runInputReplayProbe(database, payload, clock) })),
    ],
    [
      REPOSITORY_READ_OPERATIONS.runInteractionResponseReplayProbe,
      read((payload) => ({ result: runInteractionResponseReplayProbe(database, payload, clock) })),
    ],
    [
      REPOSITORY_READ_OPERATIONS.runCancelReplayProbe,
      read((payload) => ({ result: runCancelReplayProbe(database, payload, clock) })),
    ],
    [
      REPOSITORY_READ_OPERATIONS.runOutputPayloadMetadata,
      read((payload) => ({ result: runOutputPayloadMetadata(database, payload) })),
    ],
    [REPOSITORY_READ_OPERATIONS.childResultsPage, read((payload) => ({ result: childResultsPage(database, payload) }))],
    [
      REPOSITORY_READ_OPERATIONS.sessionDeletionStatusGet,
      read((payload) => ({ result: sessionDeletionStatusGet(database, payload) })),
    ],
    [
      REPOSITORY_READ_OPERATIONS.sessionDeletionCleanupPage,
      read((payload) => ({ result: sessionDeletionCleanupPage(database, payload) })),
    ],
    [REPOSITORY_READ_OPERATIONS.recoveryGet, read((payload) => ({ result: recoveryGet(database, payload) }))],
    [
      REPOSITORY_READ_OPERATIONS.recoveryCandidatesPage,
      read((payload) => ({ result: recoveryCandidatesPage(database, payload) })),
    ],
  ]);
}

function runAdmissionReplayProbe(
  database: DatabaseSync,
  payload: Readonly<Record<string, unknown>>,
  clock: () => number,
): RunAdmissionReplayProbeResult {
  const command = decodeRunAdmissionProbeCommand(payload);
  if (command === undefined) throw invalidRequest("runAdmissionReplay");
  const operation = "retryOfRunId" in command ? "run.retry" : "run.admit";
  const prepared =
    "retryOfRunId" in command
      ? prepareRetryRunAdmissionIdempotency(command)
      : prepareNormalRunAdmissionIdempotency(command);
  if (prepared === undefined) throw invalidRequest("runAdmissionReplay");
  const claim = database
    .prepare("SELECT claim_kind FROM idempotency_key_claims WHERE idempotency_key = ?")
    .get(command.idempotencyKey) as Readonly<{ claim_kind: "standard" | "session_deletion" }> | undefined;
  const row = database
    .prepare(
      `
      SELECT scope_session_id, operation, request_fingerprint, record_state,
        response_kind, response_ref_type, response_ref_id, response_envelope_json, expires_at
      FROM idempotency_records
      WHERE idempotency_key = ?
    `,
    )
    .get(command.idempotencyKey) as RunInputIdempotencyRow | undefined;
  if (row === undefined) {
    return claim === undefined ? { kind: "absent" } : runAdmissionReplayFailure("idempotency_conflict");
  }
  if (
    row.scope_session_id !== command.sessionId ||
    row.operation !== operation ||
    row.request_fingerprint !== prepared.fingerprint
  ) {
    return runAdmissionReplayFailure("idempotency_conflict");
  }
  if (row.record_state === "in_progress") return runAdmissionReplayFailure("idempotency_in_progress");
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) throw persistenceContractViolation();
  if (row.record_state === "expired" || row.expires_at === null || row.expires_at <= now) {
    return runAdmissionReplayFailure("idempotency_expired");
  }
  if (
    row.response_kind !== "success" ||
    row.response_ref_type !== "run" ||
    row.response_ref_id === null ||
    row.response_envelope_json === null
  ) {
    return runAdmissionReplayFailure("reference_invalid");
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(row.response_envelope_json);
  } catch {
    return runAdmissionReplayFailure("reference_invalid");
  }
  const current = decodeRunAdmissionReplay(database, command, envelope, row.response_ref_id);
  return current === undefined ? runAdmissionReplayFailure("reference_invalid") : { kind: "replay", value: current };
}

function runAdmissionReplayFailure(
  code: "idempotency_conflict" | "idempotency_in_progress" | "idempotency_expired" | "reference_invalid",
): Extract<RunAdmissionReplayProbeResult, Readonly<{ kind: "failure" }>> {
  return {
    kind: "failure",
    error: {
      code,
      message:
        code === "idempotency_conflict"
          ? "Idempotency key was used differently."
          : code === "idempotency_in_progress"
            ? "Idempotent command is in progress."
            : code === "idempotency_expired"
              ? "Idempotency key has expired."
              : "Idempotent Run admission response is invalid.",
      retryable: code === "idempotency_in_progress",
    },
  };
}

function runInteractionResponseReplayProbe(
  database: DatabaseSync,
  payload: Readonly<Record<string, unknown>>,
  clock: () => number,
): RunInteractionResponseReplayProbeResult {
  assertExactKeys(payload, [
    "sessionId",
    "runId",
    "idempotencyKey",
    "interactionKind",
    "interactionId",
    "canonicalResponseJson",
  ]);
  if (
    !isCanonicalUuid(payload.idempotencyKey) ||
    !isInteractionProbeString(payload.sessionId, 1_024) ||
    !isInteractionProbeString(payload.runId, 1_024) ||
    !isInteractionProbeString(payload.interactionKind, 1_024) ||
    !isInteractionProbeString(payload.interactionId, 1_024) ||
    typeof payload.canonicalResponseJson !== "string" ||
    Buffer.byteLength(payload.canonicalResponseJson) > 64 * 1024
  ) {
    throw invalidRequest("interactionResponseReplay");
  }
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) throw persistenceContractViolation();
  return probeRunInteractionResponseReplay(database, payload as RunInteractionResponseReplayProbeRequest, now);
}

function isInteractionProbeString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function runCancelReplayProbe(
  database: DatabaseSync,
  payload: Readonly<Record<string, unknown>>,
  clock: () => number,
): RunCancelReplayProbeResult {
  assertExactKeys(payload, ["sessionId", "runId", "idempotencyKey"]);
  const sessionId = requiredString(payload.sessionId, "sessionId");
  const runId = requiredString(payload.runId, "runId");
  if (!isCanonicalUuid(payload.idempotencyKey)) throw invalidRequest("idempotencyKey");
  const scope = database
    .prepare(
      `
      SELECT s.workspace_key
      FROM sessions s
      JOIN runs r ON r.session_id = s.id
      WHERE s.id = ? AND r.id = ?
    `,
    )
    .get(sessionId, runId) as Readonly<{ workspace_key: string }> | undefined;
  const claim = database
    .prepare("SELECT claim_kind FROM idempotency_key_claims WHERE idempotency_key = ?")
    .get(payload.idempotencyKey) as Readonly<{ claim_kind: "standard" | "session_deletion" }> | undefined;
  const row = database
    .prepare(
      `
      SELECT scope_session_id, operation, request_fingerprint, record_state,
        response_kind, response_ref_type, response_ref_id, response_envelope_json, expires_at
      FROM idempotency_records
      WHERE idempotency_key = ?
    `,
    )
    .get(payload.idempotencyKey) as RunInputIdempotencyRow | undefined;
  if (row === undefined) {
    return claim === undefined ? { kind: "absent" } : replayFailure("idempotency_conflict", "Run cancel");
  }
  const prepared =
    scope === undefined
      ? undefined
      : prepareRunCancelIdempotency({ sessionId, runId, workspaceKey: scope.workspace_key });
  if (
    prepared === undefined ||
    row.scope_session_id !== sessionId ||
    row.operation !== "run.cancel.admit" ||
    row.request_fingerprint !== prepared.fingerprint
  ) {
    return replayFailure("idempotency_conflict", "Run cancel");
  }
  if (row.record_state === "in_progress") return replayFailure("idempotency_in_progress", "Run cancel");
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) throw persistenceContractViolation();
  if (row.record_state === "expired" || row.expires_at === null || row.expires_at <= now) {
    return replayFailure("idempotency_expired", "Run cancel");
  }
  if (
    row.response_kind !== "success" ||
    row.response_ref_type !== "run" ||
    row.response_ref_id !== runId ||
    row.response_envelope_json === null
  ) {
    return replayFailure("reference_invalid", "Run cancel");
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(row.response_envelope_json);
  } catch {
    return replayFailure("reference_invalid", "Run cancel");
  }
  if (!validRunCancelReplayEnvelope(envelope, sessionId, runId)) {
    return replayFailure("reference_invalid", "Run cancel");
  }
  const current = readRunCancelReplayResult(database, sessionId, runId);
  return current === undefined ? replayFailure("reference_invalid", "Run cancel") : { kind: "replay", value: current };
}

function runInputReplayProbe(
  database: DatabaseSync,
  payload: Readonly<Record<string, unknown>>,
  clock: () => number,
): RunInputReplayProbeResult {
  assertExactKeys(payload, ["sessionId", "runId", "idempotencyKey", "contentBlocks"]);
  const sessionId = requiredString(payload.sessionId, "sessionId");
  const runId = requiredString(payload.runId, "runId");
  if (!isCanonicalUuid(payload.idempotencyKey)) throw invalidRequest("idempotencyKey");
  const scope = database
    .prepare(
      `
      SELECT s.workspace_key
      FROM sessions s
      JOIN runs r ON r.session_id = s.id
      WHERE s.id = ? AND r.id = ?
    `,
    )
    .get(sessionId, runId) as Readonly<{ workspace_key: string }> | undefined;
  const claim = database
    .prepare("SELECT claim_kind FROM idempotency_key_claims WHERE idempotency_key = ?")
    .get(payload.idempotencyKey) as Readonly<{ claim_kind: "standard" | "session_deletion" }> | undefined;
  const row = database
    .prepare(
      `
      SELECT scope_session_id, operation, request_fingerprint, record_state,
        response_kind, response_ref_type, response_ref_id, response_envelope_json, expires_at
      FROM idempotency_records
      WHERE idempotency_key = ?
    `,
    )
    .get(payload.idempotencyKey) as RunInputIdempotencyRow | undefined;
  if (row === undefined) {
    return claim === undefined ? { kind: "absent" } : replayFailure("idempotency_conflict", "Run input");
  }
  const prepared =
    scope === undefined
      ? undefined
      : prepareRunInputIdempotency({
          sessionId,
          runId,
          workspaceKey: scope.workspace_key,
          contentBlocks: payload.contentBlocks,
        });
  if (
    prepared === undefined ||
    row.scope_session_id !== sessionId ||
    row.operation !== "run.input.admit" ||
    row.request_fingerprint !== prepared.fingerprint
  ) {
    return replayFailure("idempotency_conflict", "Run input");
  }
  if (row.record_state === "in_progress") return replayFailure("idempotency_in_progress", "Run input");
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) throw persistenceContractViolation();
  if (row.record_state === "expired" || row.expires_at === null || row.expires_at <= now) {
    return replayFailure("idempotency_expired", "Run input");
  }
  if (
    row.response_kind !== "success" ||
    row.response_ref_type !== "delivery" ||
    row.response_ref_id === null ||
    row.response_envelope_json === null
  ) {
    return replayFailure("reference_invalid", "Run input");
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(row.response_envelope_json);
  } catch {
    return replayFailure("reference_invalid", "Run input");
  }
  if (!validRunInputReplayEnvelope(envelope, row.response_ref_id, sessionId, runId)) {
    return replayFailure("reference_invalid", "Run input");
  }
  const current = readRunInputReplayResult(database, row.response_ref_id, sessionId, runId);
  return current === undefined ? replayFailure("reference_invalid", "Run input") : { kind: "replay", value: current };
}

function replayFailure(
  code: Extract<
    RepositoryCommandErrorCode,
    "idempotency_conflict" | "idempotency_in_progress" | "idempotency_expired" | "reference_invalid"
  >,
  subject: "Run input" | "Run cancel",
): Extract<RunInputReplayProbeResult | RunCancelReplayProbeResult, Readonly<{ kind: "failure" }>> {
  const retryable = code === "idempotency_in_progress";
  const message =
    code === "idempotency_conflict"
      ? "Idempotency key was used differently."
      : code === "idempotency_in_progress"
        ? "Idempotent command is in progress."
        : code === "idempotency_expired"
          ? "Idempotency key has expired."
          : `Idempotent ${subject} response is invalid.`;
  return { kind: "failure", error: { code, message, retryable } };
}

function validRunCancelReplayEnvelope(value: unknown, sessionId: string, runId: string): boolean {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["sessionId", "runId", "phase", "cancelRequestedAt", "cancelAcknowledgedAt", "terminalAt"]) ||
    value.sessionId !== sessionId ||
    value.runId !== runId
  ) {
    return false;
  }
  return (
    projectRunCancelAdmissionResult({
      sessionId,
      runId,
      phase: value.phase,
      cancelRequestedAt: value.cancelRequestedAt,
      cancelAcknowledgedAt: value.cancelAcknowledgedAt,
      terminalAt: value.terminalAt,
    }) !== undefined
  );
}

function readRunCancelReplayResult(
  database: DatabaseSync,
  sessionId: string,
  runId: string,
): RunCancelAdmissionResult | undefined {
  const row = database
    .prepare(
      `
      SELECT r.phase, r.cancel_requested_at, r.cancel_acknowledged_at, r.terminal_at
      FROM runs r
      JOIN sessions s ON s.id = r.session_id
      WHERE s.id = ? AND r.id = ?
    `,
    )
    .get(sessionId, runId) as RunCancelReplayRow | undefined;
  if (row === undefined) return undefined;
  return projectRunCancelAdmissionResult({
    sessionId,
    runId,
    phase: row.phase,
    cancelRequestedAt: row.cancel_requested_at,
    cancelAcknowledgedAt: row.cancel_acknowledged_at,
    terminalAt: row.terminal_at,
  });
}

function validRunInputReplayEnvelope(value: unknown, messageId: string, sessionId: string, runId: string): boolean {
  if (!isPlainObject(value)) return false;
  const keys = [
    "sessionId",
    "runId",
    "attemptId",
    "messageId",
    "messageOrdinal",
    "bindingId",
    "deliveryState",
    "resolutionCode",
    "admittedAt",
    "dispatchingAt",
    "resolvedAt",
  ];
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    value.sessionId === sessionId &&
    value.runId === runId &&
    value.messageId === messageId &&
    typeof value.attemptId === "string" &&
    value.attemptId.length > 0 &&
    value.attemptId.length <= 1_024 &&
    Number.isSafeInteger(value.messageOrdinal) &&
    (value.messageOrdinal as number) > 0 &&
    typeof value.bindingId === "string" &&
    value.bindingId.length > 0 &&
    value.bindingId.length <= 1_024 &&
    value.deliveryState === "pending" &&
    value.resolutionCode === null &&
    Number.isSafeInteger(value.admittedAt) &&
    value.dispatchingAt === null &&
    value.resolvedAt === null
  );
}

function readRunInputReplayResult(
  database: DatabaseSync,
  messageId: string,
  sessionId: string,
  runId: string,
): RunInputAdmissionResult | undefined {
  const row = database
    .prepare(
      `
      SELECT i.message_id, m.ordinal AS message_ordinal, i.run_id, i.run_attempt_id,
        i.delivery_state, i.resolution_code, i.created_at, i.dispatching_at, i.resolved_at,
        b.id AS provider_binding_id
      FROM run_input_deliveries i
      JOIN messages m ON m.id = i.message_id AND m.session_id = ?
      JOIN run_attempts a ON a.id = i.run_attempt_id AND a.run_id = i.run_id
      JOIN runs r ON r.id = i.run_id AND r.session_id = m.session_id
      JOIN sessions s ON s.id = r.session_id
      JOIN provider_bindings b ON b.id = a.provider_binding_id
        AND b.session_id = r.session_id AND b.provider_id = s.provider_id
        AND EXISTS (
          SELECT 1
          FROM run_attempts creator_a
          JOIN runs creator_r ON creator_r.id = creator_a.run_id
          WHERE creator_a.id = b.created_by_run_attempt_id
            AND creator_r.session_id = r.session_id
        )
        AND (b.persistence_mode = 'persistent' OR b.created_by_run_attempt_id = a.id)
      WHERE i.message_id = ? AND i.run_id = ?
    `,
    )
    .get(sessionId, messageId, runId) as RunInputReplayRow | undefined;
  if (row === undefined || row.provider_binding_id === null) return undefined;
  return {
    sessionId,
    runId: row.run_id,
    attemptId: row.run_attempt_id,
    messageId: row.message_id,
    messageOrdinal: row.message_ordinal,
    bindingId: row.provider_binding_id,
    deliveryState: row.delivery_state,
    resolutionCode: row.resolution_code,
    admittedAt: row.created_at,
    dispatchingAt: row.dispatching_at,
    resolvedAt: row.resolved_at,
  };
}

function sessionsPage(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  assertExactKeys(payload, [
    "workspaceKey",
    "lifecycleStatus",
    "localRepositoryKeys",
    "querySearchKey",
    "cursor",
    "limit",
  ]);
  const workspaceKey = optionalString(payload.workspaceKey, "workspaceKey");
  const lifecycleStatus = optionalEnum(payload.lifecycleStatus, ["active", "archived", "closed"]);
  const localRepositoryKeys = optionalLocalRepositoryKeys(payload.localRepositoryKeys);
  const querySearchKey = optionalQuerySearchKey(payload.querySearchKey);
  const limit = readLimit(payload.limit, REPOSITORY_READ_LIMITS.sessions);
  const scope = scopeDigest({
    workspaceKey: workspaceKey ?? null,
    lifecycleStatus: lifecycleStatus ?? null,
    localRepositoryKeys,
    querySearchKey: querySearchKey ?? null,
  });
  const cursor = decodeCursor(payload.cursor, "sessions", scope, 2);
  if (cursor !== undefined && (!Number.isSafeInteger(cursor[0]) || typeof cursor[1] !== "string")) {
    throw invalidCursor();
  }
  const cursorTime = cursor?.[0] as number | undefined;
  const cursorId = cursor?.[1] as string | undefined;

  const cursorParameters = [cursorTime ?? null, cursorTime ?? null, cursorTime ?? null, cursorId ?? null, limit + 1];
  const query = {
    sql: filteredSessionPageSql(
      workspaceKey !== undefined,
      lifecycleStatus !== undefined,
      localRepositoryKeys.length,
      querySearchKey !== undefined,
    ),
    parameters: [
      ...(workspaceKey === undefined ? [] : [workspaceKey]),
      ...(lifecycleStatus === undefined ? [] : [lifecycleStatus]),
      ...localRepositoryKeys,
      ...(querySearchKey === undefined ? [] : [querySearchKey, querySearchKey]),
      ...cursorParameters,
    ],
  };
  const rows = database.prepare(query.sql).all(...query.parameters) as unknown as readonly SessionPageRow[];
  const page = splitPage(rows, limit);
  return budgetPage(
    page,
    (row) => ({
      id: row.id,
      title: row.title,
      workspaceKey: row.workspace_key,
      workspacePath: row.workspace_path,
      localRepositoryKey: row.local_repository_key,
      repositoryName: row.repository_name,
      defaultCharacterId: row.default_character_id,
      lifecycleStatus: row.lifecycle_status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastActivityAt: row.last_activity_at,
      executionState: row.active_run_id !== null ? "running" : (row.latest_run_phase ?? "not_started"),
      ...(row.active_run_id === null ? {} : { activeRunId: row.active_run_id }),
      ...(row.latest_run_id === null ? {} : { latestRunId: row.latest_run_id }),
      stateChangedAt:
        row.active_run_id === null
          ? (row.latest_run_terminal_at ?? row.created_at)
          : (row.active_run_created_at ?? row.created_at),
    }),
    (budgeted) => ({
      items: budgeted.items,
      ...(budgeted.hasMore && budgeted.lastRow !== undefined
        ? {
            nextCursor: encodeCursor("sessions", scope, [budgeted.lastRow.last_activity_at, budgeted.lastRow.id]),
          }
        : {}),
    }),
  );
}

function localRepositoriesPage(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  assertExactKeys(payload, ["cursor", "limit"]);
  const limit = readLimit(payload.limit, REPOSITORY_READ_LIMITS.localRepositories);
  const scope = scopeDigest({ collection: "local_repositories" });
  const cursor = decodeCursor(payload.cursor, "local_repositories", scope, 2);
  if (cursor !== undefined && (!Number.isSafeInteger(cursor[0]) || !isLocalRepositoryKey(cursor[1]))) {
    throw invalidCursor();
  }
  const cursorTime = cursor?.[0] as number | undefined;
  const cursorKey = cursor?.[1] as string | undefined;
  const rows = database
    .prepare(
      `
      WITH repository_stats AS MATERIALIZED (
        SELECT local_repository_key, COUNT(*) AS session_count,
               COUNT(DISTINCT repository_name) AS repository_name_count,
               MAX(last_activity_at) AS last_activity_at
        FROM sessions
        WHERE local_repository_key IS NOT NULL
        GROUP BY local_repository_key
      ), page_repositories AS MATERIALIZED (
        SELECT * FROM repository_stats
        WHERE (? IS NULL OR last_activity_at < ? OR
          (last_activity_at = ? AND local_repository_key < ?))
        ORDER BY last_activity_at DESC, local_repository_key DESC
        LIMIT ?
      )
      SELECT p.*,
        (SELECT json_group_array(repository_name) FROM (
          SELECT repository_name FROM sessions n
          WHERE n.local_repository_key = p.local_repository_key
          GROUP BY repository_name
          ORDER BY MAX(last_activity_at) DESC, repository_name ASC
          LIMIT ?
        )) AS repository_names_json
      FROM page_repositories p
      ORDER BY p.last_activity_at DESC, p.local_repository_key DESC
    `,
    )
    .all(
      cursorTime ?? null,
      cursorTime ?? null,
      cursorTime ?? null,
      cursorKey ?? null,
      limit + 1,
      SESSION_METADATA_LIMITS.repositoryNamesPerItemMax,
    ) as unknown as readonly LocalRepositoryPageRow[];
  const page = splitPage(rows, limit);
  return budgetPage(
    page,
    (row) => ({
      localRepositoryKey: row.local_repository_key,
      repositoryNames: decodeRepositoryNames(row.repository_names_json),
      repositoryNameCount: row.repository_name_count,
      sessionCount: row.session_count,
      lastActivityAt: row.last_activity_at,
    }),
    (budgeted) => ({
      items: budgeted.items,
      ...(budgeted.hasMore && budgeted.lastRow !== undefined
        ? {
            nextCursor: encodeCursor("local_repositories", scope, [
              budgeted.lastRow.last_activity_at,
              budgeted.lastRow.local_repository_key,
            ]),
          }
        : {}),
    }),
  );
}

function sessionGet(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  assertExactKeys(payload, ["sessionId"]);
  const sessionId = requiredString(payload.sessionId, "sessionId");
  const row = database
    .prepare(
      `
      SELECT s.id, s.title, s.provider_id, s.workspace_key, s.workspace_path,
        s.local_repository_key, s.repository_name, s.default_character_id, s.max_concurrent_child_runs,
        s.lifecycle_status, s.created_at, s.updated_at, s.last_activity_at,
        length(CAST(s.allowed_additional_directories_json AS BLOB)) AS directories_byte_length,
        CASE WHEN length(CAST(s.allowed_additional_directories_json AS BLOB)) <= ?
          THEN s.allowed_additional_directories_json END AS inline_directories,
        (SELECT id FROM runs WHERE session_id = s.id
          AND phase IN ('queued','starting','active','canceling','finalizing') LIMIT 1) AS active_run_id,
        (SELECT id FROM runs WHERE session_id = s.id ORDER BY ordinal DESC LIMIT 1) AS latest_run_id,
        (SELECT phase FROM runs WHERE session_id = s.id ORDER BY ordinal DESC LIMIT 1) AS latest_run_phase
      FROM sessions s WHERE s.id = ?
    `,
    )
    .get(INLINE_MESSAGE_BYTES, sessionId) as SessionDetailRow | undefined;
  if (row === undefined) throw notFound();
  return {
    session: {
      id: row.id,
      title: row.title,
      providerId: row.provider_id,
      workspaceKey: row.workspace_key,
      workspacePath: row.workspace_path,
      localRepositoryKey: row.local_repository_key,
      repositoryName: row.repository_name,
      allowedAdditionalDirectoriesByteLength: row.directories_byte_length,
      allowedAdditionalDirectoriesState: row.inline_directories === null ? "chunked" : "inline",
      ...(row.inline_directories === null
        ? {}
        : { allowedAdditionalDirectories: JSON.parse(row.inline_directories) as unknown }),
      defaultCharacterId: row.default_character_id,
      maxConcurrentChildRuns: row.max_concurrent_child_runs,
      lifecycleStatus: row.lifecycle_status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastActivityAt: row.last_activity_at,
    },
    execution: {
      state: row.active_run_id !== null ? "running" : (row.latest_run_phase ?? "not_started"),
      ...(row.active_run_id === null ? {} : { activeRunId: row.active_run_id }),
      ...(row.latest_run_id === null ? {} : { latestRunId: row.latest_run_id }),
    },
  };
}

function messagesPage(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  const scope = readSessionScope(payload, ["sessionId", "workspaceKey", "cursor", "limit"]);
  const limit = readLimit(payload.limit, REPOSITORY_READ_LIMITS.messages);
  const cursorScope = scopeDigest(scope);
  const afterOrdinal = decodeOrdinalCursor(payload.cursor, "messages", cursorScope);
  const queryRows = database
    .prepare(REPOSITORY_PAGE_SQL.messages)
    .all(
      INLINE_MESSAGE_BYTES,
      scope.sessionId,
      afterOrdinal,
      limit + 1,
      scope.sessionId,
      scope.workspaceKey,
    ) as unknown as readonly MessageQueryRow[];
  if (queryRows.length === 0) throw notFound();
  let rows: readonly MessageRow[];
  if (queryRows[0]?.scope_only === 1) {
    if (queryRows.length !== 1) throw new TypeError("Repository projection violates the persistence contract.");
    rows = [];
  } else {
    if (queryRows.some((row) => row.scope_only !== 0)) {
      throw new TypeError("Repository projection violates the persistence contract.");
    }
    rows = queryRows as unknown as readonly MessageRow[];
  }
  const page = splitPage(rows, limit);
  return ordinalPage(scope, page, "messages", cursorScope, (row) => ({
    id: row.id,
    sessionId: row.session_id,
    ordinal: row.ordinal,
    role: row.role,
    contentByteLength: row.content_byte_length,
    contentState: row.inline_content === null ? "chunked" : "inline",
    ...(row.inline_content === null ? {} : { contentBlocks: JSON.parse(row.inline_content) as unknown }),
    createdAt: row.created_at,
  }));
}

function runsPage(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  const scope = readSessionScope(payload, ["sessionId", "workspaceKey", "cursor", "limit"]);
  const limit = readLimit(payload.limit, REPOSITORY_READ_LIMITS.runs);
  const cursorScope = scopeDigest(scope);
  const afterOrdinal = decodeOrdinalCursor(payload.cursor, "runs", cursorScope);
  const queryRows = database
    .prepare(REPOSITORY_PAGE_SQL.runs)
    .all(
      scope.sessionId,
      afterOrdinal,
      limit + 1,
      scope.sessionId,
      scope.workspaceKey,
    ) as unknown as readonly RunHistoryQueryRow[];
  if (queryRows.length === 0) throw notFound();
  let rows: readonly RunHistoryRow[];
  if (queryRows[0]?.scope_only === 1) {
    if (queryRows.length !== 1) throw persistenceContractViolation();
    rows = [];
  } else {
    if (queryRows.some((row) => row.scope_only !== 0)) throw persistenceContractViolation();
    rows = queryRows as unknown as readonly RunHistoryRow[];
  }
  const page = splitPage(rows, limit);
  return ordinalPage(scope, page, "runs", cursorScope, (row) => ({
    runId: row.run_id,
    sessionId: row.session_id,
    ordinal: row.ordinal,
    initiatingMessageId: row.initiating_message_id,
    ...(row.final_assistant_message_id === null ? {} : { finalAssistantMessageId: row.final_assistant_message_id }),
    ...(row.retry_of_run_id === null ? {} : { retryOfRunId: row.retry_of_run_id }),
    phase: row.phase,
    ...(row.failure_origin === null ? {} : { failureOrigin: row.failure_origin }),
    ...(row.error_summary === null ? {} : { errorSummary: row.error_summary }),
    ...(row.cancel_requested_at === null ? {} : { cancelRequestedAt: row.cancel_requested_at }),
    ...(row.cancel_acknowledged_at === null ? {} : { cancelAcknowledgedAt: row.cancel_acknowledged_at }),
    createdAt: row.created_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.terminal_at === null ? {} : { terminalAt: row.terminal_at }),
    updatedAt: row.updated_at,
  }));
}

function runGet(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  const scope = readRunScope(payload, ["sessionId", "runId", "workspaceKey"]);
  const row = database
    .prepare(
      `
      SELECT r.id, r.session_id, r.ordinal, r.initiating_message_id, r.final_assistant_message_id,
        r.retry_of_run_id, r.phase, r.failure_origin, r.provider_error_code, r.error_summary,
        r.cancel_requested_at, r.cancel_acknowledged_at, r.terminal_event_received_at,
        r.external_side_effect_state, r.created_at, r.started_at, r.terminal_at, r.updated_at, r.version,
        length(CAST(r.execution_snapshot_json AS BLOB)) AS execution_snapshot_byte_length,
        CASE WHEN length(CAST(r.execution_snapshot_json AS BLOB)) <= ?
          THEN r.execution_snapshot_json END AS inline_execution_snapshot,
        s.workspace_key FROM runs r JOIN sessions s ON s.id = r.session_id
      WHERE r.id = ? AND r.session_id = ? AND s.workspace_key = ?
    `,
    )
    .get(INLINE_MESSAGE_BYTES, scope.runId, scope.sessionId, scope.workspaceKey) as Record<string, unknown> | undefined;
  if (row === undefined) throw notFound();
  const { inline_execution_snapshot: inlineSnapshot, workspace_key: _workspaceKey, ...metadata } = row;
  return {
    sessionId: scope.sessionId,
    workspaceKey: scope.workspaceKey,
    run: {
      ...snakeToCamel(metadata),
      executionSnapshotState: inlineSnapshot === null ? "chunked" : "inline",
      ...(typeof inlineSnapshot === "string" ? { executionSnapshot: JSON.parse(inlineSnapshot) as unknown } : {}),
    },
  };
}

function runEventsPage(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  const scope = readRunScope(payload, ["sessionId", "runId", "workspaceKey", "cursor", "limit"]);
  const limit = readLimit(payload.limit, REPOSITORY_READ_LIMITS.events);
  const cursorScope = runCursorScope(scope);
  const afterOrdinal = decodeOrdinalCursor(payload.cursor, "run_events", cursorScope);
  const rows = database
    .prepare(REPOSITORY_PAGE_SQL.runEvents)
    .all(scope.runId, scope.sessionId, scope.workspaceKey, afterOrdinal, limit + 1) as unknown as readonly OrdinalRow[];
  assertRunScopeExists(database, scope);
  const page = splitPage(rows, limit);
  return budgetPage(
    page,
    (row) => ({
      id: row.id,
      runId: row.run_id,
      ordinal: row.ordinal,
      eventCode: row.event_code,
      ...(row.subject_type === null ? {} : { subjectType: row.subject_type }),
      ...(row.subject_id === null ? {} : { subjectId: row.subject_id }),
      ...(row.summary === null ? {} : { summary: row.summary }),
      createdAt: row.created_at,
    }),
    (budgeted) => ({
      ...scope,
      items: budgeted.items,
      continuationCursor: encodeCursor("run_events", cursorScope, [budgeted.lastRow?.ordinal ?? afterOrdinal]),
      hasMore: budgeted.hasMore,
    }),
  );
}

function runOutputCounts(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  const scope = readRunScope(payload, ["sessionId", "runId", "workspaceKey"]);
  assertRunScopeExists(database, scope);
  const rows = database
    .prepare(
      `
      SELECT category, count(*) AS item_count,
             sum(CASE WHEN completion_state = 'partial' THEN 1 ELSE 0 END) AS partial_count
      FROM run_output_items WHERE run_id = ? GROUP BY category
    `,
    )
    .all(scope.runId) as unknown as readonly Readonly<{
    category: string;
    item_count: number;
    partial_count: number;
  }>[];
  return {
    ...scope,
    totalCount: rows.reduce((sum, row) => sum + row.item_count, 0),
    partialCount: rows.reduce((sum, row) => sum + row.partial_count, 0),
    byCategory: Object.fromEntries(rows.map((row) => [row.category, row.item_count])),
  };
}

function runInputDeliveriesPage(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  const scope = readRunScope(payload, ["sessionId", "runId", "workspaceKey", "cursor", "limit"]);
  const limit = readLimit(payload.limit, REPOSITORY_READ_LIMITS.runInputDeliveries);
  const cursorScope = runCursorScope(scope);
  const cursor = decodeCursor(payload.cursor, "run_input_deliveries", cursorScope, 2);
  if (
    cursor !== undefined &&
    (!Number.isSafeInteger(cursor[0]) || (cursor[0] as number) < 0 || typeof cursor[1] !== "string")
  ) {
    throw invalidCursor();
  }
  const afterCreatedAt = cursor?.[0] as number | undefined;
  const afterMessageId = cursor?.[1] as string | undefined;
  const rows = database
    .prepare(
      `
      SELECT i.message_id, i.run_id, i.run_attempt_id AS attempt_id,
             b.id AS binding_id, i.delivery_state,
             i.created_at, i.dispatching_at
      FROM run_input_deliveries i
      JOIN run_attempts a ON a.id = i.run_attempt_id AND a.run_id = i.run_id
      JOIN runs r ON r.id = i.run_id
      JOIN sessions s ON s.id = r.session_id
      LEFT JOIN provider_bindings b ON b.id = a.provider_binding_id
        AND b.session_id = r.session_id AND b.provider_id = s.provider_id
        AND EXISTS (
          SELECT 1
          FROM run_attempts creator_a
          JOIN runs creator_r ON creator_r.id = creator_a.run_id
          WHERE creator_a.id = b.created_by_run_attempt_id
            AND creator_r.session_id = r.session_id
        )
        AND (b.persistence_mode = 'persistent' OR b.created_by_run_attempt_id = a.id)
      WHERE i.run_id = ? AND r.session_id = ? AND s.workspace_key = ?
        AND i.delivery_state IN ('pending', 'dispatching')
        AND (? IS NULL OR i.created_at > ? OR (i.created_at = ? AND i.message_id > ?))
      ORDER BY i.created_at ASC, i.message_id ASC
      LIMIT ?
    `,
    )
    .all(
      scope.runId,
      scope.sessionId,
      scope.workspaceKey,
      afterCreatedAt ?? null,
      afterCreatedAt ?? null,
      afterCreatedAt ?? null,
      afterMessageId ?? null,
      limit + 1,
    ) as unknown as readonly RunInputDeliveryRow[];
  assertRunScopeExists(database, scope);
  const page = splitPage(rows, limit);
  return budgetPage(
    page,
    (row) => ({
      messageId: row.message_id,
      runId: row.run_id,
      attemptId: row.attempt_id,
      bindingId: row.binding_id,
      deliveryState: row.delivery_state,
      createdAt: row.created_at,
      dispatchingAt: row.dispatching_at,
    }),
    (budgeted) => ({
      ...scope,
      items: budgeted.items,
      ...(budgeted.hasMore && budgeted.lastRow !== undefined
        ? {
            nextCursor: encodeCursor("run_input_deliveries", cursorScope, [
              budgeted.lastRow.created_at,
              budgeted.lastRow.message_id,
            ]),
          }
        : {}),
    }),
  );
}

function runOutputsPage(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  const scope = readRunScope(payload, ["sessionId", "runId", "workspaceKey", "category", "cursor", "limit"]);
  const category = optionalString(payload.category, "category");
  const limit = readLimit(payload.limit, REPOSITORY_READ_LIMITS.outputs);
  const cursorScope = scopeDigest({ ...scope, category: category ?? null });
  const afterOrdinal = decodeOrdinalCursor(payload.cursor, "run_outputs", cursorScope);
  const rows = (category === undefined
    ? database
        .prepare(REPOSITORY_PAGE_SQL.runOutputs)
        .all(scope.runId, scope.sessionId, scope.workspaceKey, afterOrdinal, limit + 1)
    : database
        .prepare(REPOSITORY_PAGE_SQL.runOutputsByCategory)
        .all(
          scope.runId,
          scope.sessionId,
          scope.workspaceKey,
          category,
          afterOrdinal,
          limit + 1,
        )) as unknown as readonly OrdinalRow[];
  assertRunScopeExists(database, scope);
  const page = splitPage(rows, limit);
  return ordinalPage(scope, page, "run_outputs", cursorScope, (row) => decodeRunOutputItem(row as RunOutputItemRow));
}

function runOutputGet(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  const scope = readRunScope(payload, ["sessionId", "runId", "outputItemId", "workspaceKey"]);
  const outputItemId = requiredString(payload.outputItemId, "outputItemId");
  const row = database
    .prepare(REPOSITORY_RUN_OUTPUT_ITEM_SQL)
    .get(outputItemId, scope.runId, scope.sessionId, scope.workspaceKey) as RunOutputItemRow | undefined;
  if (row === undefined) throw notFound();
  return {
    ...scope,
    item: decodeRunOutputItem(row),
  };
}

function decodeRunOutputItem(row: RunOutputItemRow): RunOutputListItem {
  if (
    !RUN_OUTPUT_CATEGORIES.includes(row.category as (typeof RUN_OUTPUT_CATEGORIES)[number]) ||
    (row.completion_state !== "complete" && row.completion_state !== "partial")
  ) {
    throw persistenceContractViolation();
  }
  const base = {
    id: row.id,
    runId: row.run_id,
    ordinal: row.ordinal,
    category: row.category as RunOutputListItem["category"],
    kind: row.kind,
    summary: row.summary,
    completionState: row.completion_state,
    createdAt: row.created_at,
  } as const;
  if (
    row.payload_state === "none" &&
    row.payload_original_byte_length === null &&
    row.stored_payload_id === null &&
    row.redaction_state === "not_required"
  ) {
    return { ...base, payloadState: "none", redactionState: "not_required" };
  }
  if (
    (row.payload_state === "pending" ||
      row.payload_state === "omitted_size_limit" ||
      row.payload_state === "omitted_persistence") &&
    isNonNegativeInteger(row.payload_original_byte_length) &&
    row.stored_payload_id === null &&
    (row.redaction_state === "not_required" || row.redaction_state === "redacted")
  ) {
    return {
      ...base,
      payloadState: row.payload_state,
      payloadOriginalByteLength: row.payload_original_byte_length,
      redactionState: row.redaction_state,
    };
  }
  if (
    row.payload_state === "stored" &&
    isNonNegativeInteger(row.payload_original_byte_length) &&
    row.stored_payload_id === row.id &&
    (row.redaction_state === "not_required" || row.redaction_state === "redacted")
  ) {
    return {
      ...base,
      payloadState: "stored",
      payloadOriginalByteLength: row.payload_original_byte_length,
      storedPayloadId: row.stored_payload_id,
      redactionState: row.redaction_state,
    };
  }
  if (
    row.payload_state === "omitted_redaction" &&
    isNonNegativeInteger(row.payload_original_byte_length) &&
    row.stored_payload_id === null &&
    row.redaction_state === "unknown"
  ) {
    return {
      ...base,
      payloadState: "omitted_redaction",
      payloadOriginalByteLength: row.payload_original_byte_length,
      redactionState: "unknown",
    };
  }
  throw persistenceContractViolation();
}

function runOutputPayloadMetadata(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  const scope = readRunScope(payload, ["sessionId", "runId", "outputItemId", "workspaceKey"]);
  const outputItemId = requiredString(payload.outputItemId, "outputItemId");
  const row = database
    .prepare(
      `
      SELECT o.id AS output_item_id, p.payload_format, p.media_type, p.byte_length,
             p.content_sha256, p.created_at, s.workspace_key
      FROM run_output_items o
      JOIN runs r ON r.id = o.run_id
      JOIN sessions s ON s.id = r.session_id
      JOIN run_output_payloads p ON p.output_item_id = o.id
      WHERE o.id = ? AND o.run_id = ? AND r.session_id = ? AND s.workspace_key = ?
    `,
    )
    .get(outputItemId, scope.runId, scope.sessionId, scope.workspaceKey) as Record<string, unknown> | undefined;
  if (row === undefined) throw notFound();
  return { ...scope, ...snakeToCamel(row) };
}

function childResultsPage(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  assertExactKeys(payload, ["parentSessionId", "workspaceKey", "delegationId", "cursor", "limit"]);
  const parentSessionId = requiredString(payload.parentSessionId, "parentSessionId");
  const workspaceKey = requiredString(payload.workspaceKey, "workspaceKey");
  const delegationId = requiredString(payload.delegationId, "delegationId");
  const limit = readLimit(payload.limit, REPOSITORY_READ_LIMITS.childResults);
  const cursorScope = scopeDigest({ workspaceKey, parentSessionId, delegationId });
  const afterOrdinal = decodeOrdinalCursor(payload.cursor, "child_results", cursorScope);
  const rows = database
    .prepare(
      `
      SELECT d.id, d.delegation_id, d.ordinal, d.child_run_id, d.availability_state,
             d.terminal_phase_snapshot, d.result_summary, d.available_at,
             d.first_collected_by_parent_run_id, d.first_collected_at, d.created_at, d.updated_at,
             rel.parent_session_id, rel.child_session_id, rel.orchestration_root_session_id,
             s.workspace_key
      FROM child_result_deliveries d
      JOIN delegations g ON g.id = d.delegation_id
      JOIN session_relations rel ON rel.id = g.session_relation_id
      JOIN sessions s ON s.id = rel.parent_session_id
      JOIN sessions child ON child.id = rel.child_session_id AND child.workspace_key = s.workspace_key
      JOIN sessions root ON root.id = rel.orchestration_root_session_id AND root.workspace_key = s.workspace_key
      JOIN runs child_run ON child_run.id = d.child_run_id AND child_run.session_id = rel.child_session_id
      WHERE d.delegation_id = ? AND rel.parent_session_id = ? AND s.workspace_key = ? AND d.ordinal > ?
      ORDER BY d.ordinal ASC LIMIT ?
    `,
    )
    .all(delegationId, parentSessionId, workspaceKey, afterOrdinal, limit + 1) as unknown as readonly OrdinalRow[];
  if (rows.length === 0) {
    const exists = database
      .prepare(
        `
      SELECT 1 FROM delegations g JOIN session_relations rel ON rel.id = g.session_relation_id
      JOIN sessions s ON s.id = rel.parent_session_id
      JOIN sessions child ON child.id = rel.child_session_id AND child.workspace_key = s.workspace_key
      JOIN sessions root ON root.id = rel.orchestration_root_session_id AND root.workspace_key = s.workspace_key
      WHERE g.id = ? AND rel.parent_session_id = ? AND s.workspace_key = ?
    `,
      )
      .get(delegationId, parentSessionId, workspaceKey);
    if (exists === undefined) throw notFound();
  }
  const page = splitPage(rows, limit);
  return ordinalPage({ parentSessionId, workspaceKey, delegationId }, page, "child_results", cursorScope, (row) => ({
    id: row.id,
    delegationId: row.delegation_id,
    ordinal: row.ordinal,
    childRunId: row.child_run_id,
    availabilityState: row.availability_state,
    ...(row.terminal_phase_snapshot === null ? {} : { terminalPhaseSnapshot: row.terminal_phase_snapshot }),
    ...(row.result_summary === null ? {} : { resultSummary: row.result_summary }),
    ...(row.available_at === null ? {} : { availableAt: row.available_at }),
    ...(row.first_collected_by_parent_run_id === null
      ? {}
      : { firstCollectedByParentRunId: row.first_collected_by_parent_run_id }),
    ...(row.first_collected_at === null ? {} : { firstCollectedAt: row.first_collected_at }),
    parentSessionId: row.parent_session_id,
    childSessionId: row.child_session_id,
    orchestrationRootSessionId: row.orchestration_root_session_id,
    workspaceKey: row.workspace_key,
  }));
}

function sessionDeletionCleanupPage(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  assertExactKeys(payload, ["cleanupToken", "workspaceKey", "cursor", "limit"]);
  const cleanupToken = requiredString(payload.cleanupToken, "cleanupToken");
  if (!isCanonicalUuid(cleanupToken)) throw invalidRequest("cleanupToken");
  const workspaceKey = requiredString(payload.workspaceKey, "workspaceKey");
  const limit = readLimit(payload.limit, REPOSITORY_READ_LIMITS.sessionDeletionItems);
  const cursorScope = scopeDigest({ cleanupToken, workspaceKey });
  const afterOrdinal = decodeOrdinalCursor(payload.cursor, "session_deletion_items", cursorScope);
  const manifest = database
    .prepare(
      `
      SELECT deleted_session_count FROM session_deletion_manifests
      WHERE deletion_id = ? AND workspace_key = ?
    `,
    )
    .get(cleanupToken, workspaceKey) as { deleted_session_count: number } | undefined;
  if (manifest === undefined) throw notFound();
  const rows = database
    .prepare(
      `
      SELECT ordinal, session_id FROM session_deletion_items
      WHERE deletion_id = ? AND ordinal > ?
      ORDER BY ordinal ASC LIMIT ?
    `,
    )
    .all(cleanupToken, afterOrdinal, limit + 1) as unknown as ReadonlyArray<OrdinalRow & { session_id: string }>;
  const page = splitPage(rows, limit);
  return ordinalPage(
    {
      cleanupToken,
      deletedSessionCount: manifest.deleted_session_count,
      localOnly: true,
    },
    page,
    "session_deletion_items",
    cursorScope,
    (row) => ({ ordinal: row.ordinal, sessionId: row.session_id }),
  );
}

function sessionDeletionStatusGet(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  assertExactKeys(payload, ["cleanupToken"]);
  const cleanupToken = requiredString(payload.cleanupToken, "cleanupToken");
  if (!isCanonicalUuid(cleanupToken)) throw invalidRequest("cleanupToken");
  const rows = database
    .prepare(
      `
      SELECT workspace_key, deleted_session_count, 'pending' AS status
      FROM session_deletion_manifests
      WHERE deletion_id = ?
      UNION ALL
      SELECT workspace_key, deleted_session_count, 'completed' AS status
      FROM session_deletion_completion_tombstones
      WHERE deletion_id = ?
    `,
    )
    .all(cleanupToken, cleanupToken) as unknown as readonly Readonly<{
    workspace_key: string;
    deleted_session_count: number;
    status: "pending" | "completed";
  }>[];
  if (rows.length === 0) throw notFound();
  if (rows.length !== 1) throw new Error("Session deletion status is ambiguous.");
  const row = rows[0]!;
  return {
    cleanupToken,
    workspaceKey: row.workspace_key,
    deletedSessionCount: row.deleted_session_count,
    localOnly: true,
    status: row.status,
  };
}

function recoveryGet(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  const scope = readRunScope(payload, ["sessionId", "runId", "workspaceKey"]);
  const row = database
    .prepare(
      `
    SELECT r.id AS run_id, r.session_id, r.phase AS run_phase, r.updated_at AS run_updated_at,
           a.id AS attempt_id, a.ordinal AS attempt_ordinal, a.attempt_state,
           a.external_execution_id, b.id AS binding_id, b.provider_id, b.persistence_mode,
           b.binding_state, b.external_conversation_id, d.dispatch_state,
           d.provider_idempotency_key, s.workspace_key
    FROM runs r JOIN sessions s ON s.id = r.session_id
    LEFT JOIN run_attempts a ON a.id = (
      SELECT id FROM run_attempts WHERE run_id = r.id ORDER BY ordinal DESC LIMIT 1)
    LEFT JOIN provider_bindings b ON b.id = COALESCE(
      a.provider_binding_id,
      (
        SELECT pb.id FROM provider_bindings pb
        WHERE pb.created_by_run_attempt_id = a.id
        ORDER BY CASE pb.binding_state
          WHEN 'creating' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
          pb.ordinal DESC
        LIMIT 1
      )
    )
      AND b.session_id = r.session_id
      AND b.provider_id = s.provider_id
      AND EXISTS (
        SELECT 1
        FROM run_attempts creator_a
        JOIN runs creator_r ON creator_r.id = creator_a.run_id
        WHERE creator_a.id = b.created_by_run_attempt_id
          AND creator_r.session_id = r.session_id
      )
      AND (b.persistence_mode = 'persistent' OR b.created_by_run_attempt_id = a.id)
    LEFT JOIN run_dispatches d ON d.run_attempt_id = a.id
    WHERE r.id = ? AND r.session_id = ? AND s.workspace_key = ?
  `,
    )
    .get(scope.runId, scope.sessionId, scope.workspaceKey) as Record<string, unknown> | undefined;
  if (row === undefined) throw notFound();
  return snakeToCamelWithNulls(row);
}

type RecoveryCandidateRow = Readonly<{
  run_id: string;
  session_id: string;
  workspace_key: string;
  session_provider_id: string;
  run_phase: "queued" | "starting" | "active" | "canceling" | "finalizing";
  run_version: number;
  initiating_message_id: string;
  run_created_at: number;
  run_updated_at: number;
  cancel_requested_at: number | null;
  external_side_effect_state: "none" | "present" | "unknown";
  current_attempt_count: number;
  attempt_id: string | null;
  attempt_ordinal: number | null;
  attempt_state: "preparing" | "active" | null;
  attempt_provider_binding_id: string | null;
  external_execution_id: string | null;
  binding_candidate_count: number;
  binding_id: string | null;
  binding_session_id: string | null;
  binding_provider_id: string | null;
  persistence_mode: "persistent" | "ephemeral" | null;
  binding_state: "creating" | "active" | "invalidated" | "superseded" | null;
  binding_creator_attempt_id: string | null;
  binding_creator_run_id: string | null;
  binding_creator_session_id: string | null;
  external_conversation_id: string | null;
  dispatch_count: number;
  dispatch_state: "pending" | "dispatching" | "accepted" | "rejected" | "ambiguous" | "aborted" | null;
  provider_idempotency_key: string | null;
}>;

function recoveryCandidatesPage(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  assertExactKeys(payload, ["cursor", "limit"]);
  const limit = readLimit(payload.limit, REPOSITORY_READ_LIMITS.recoveryCandidates);
  const cursorScope = scopeDigest({ collection: "runtime_recovery_candidates" });
  const cursor = decodeCursor(payload.cursor, "recovery_candidates", cursorScope, 2);
  if (
    cursor !== undefined &&
    (!Number.isSafeInteger(cursor[0]) || (cursor[0] as number) < 0 || typeof cursor[1] !== "string")
  ) {
    throw invalidCursor();
  }
  const afterCreatedAt = cursor?.[0] as number | undefined;
  const afterRunId = cursor?.[1] as string | undefined;
  const rows = database
    .prepare(REPOSITORY_RECOVERY_CANDIDATE_SQL)
    .all(
      afterCreatedAt ?? null,
      afterCreatedAt ?? null,
      afterCreatedAt ?? null,
      afterRunId ?? null,
      limit + 1,
    ) as unknown as readonly RecoveryCandidateRow[];
  const page = splitPage(rows, limit);
  return budgetPage(
    page,
    (row) => snakeToCamelWithNulls(row),
    (budgeted) => ({
      items: budgeted.items,
      ...(budgeted.hasMore && budgeted.lastRow !== undefined
        ? {
            nextCursor: encodeCursor("recovery_candidates", cursorScope, [
              budgeted.lastRow.run_created_at,
              budgeted.lastRow.run_id,
            ]),
          }
        : {}),
    }),
  );
}

function readSessionScope(payload: Readonly<Record<string, unknown>>, keys: readonly string[]) {
  assertExactKeys(payload, keys);
  return {
    sessionId: requiredString(payload.sessionId, "sessionId"),
    workspaceKey: requiredString(payload.workspaceKey, "workspaceKey"),
  };
}

function readRunScope(payload: Readonly<Record<string, unknown>>, keys: readonly string[]) {
  const scope = readSessionScope(payload, keys);
  return { ...scope, runId: requiredString(payload.runId, "runId") };
}

function assertRunScopeExists(
  database: DatabaseSync,
  scope: Readonly<{ sessionId: string; runId: string; workspaceKey: string }>,
): void {
  if (
    database
      .prepare(
        `
    SELECT 1 FROM runs r JOIN sessions s ON s.id = r.session_id
    WHERE r.id = ? AND r.session_id = ? AND s.workspace_key = ?
  `,
      )
      .get(scope.runId, scope.sessionId, scope.workspaceKey) === undefined
  )
    throw notFound();
}

function ordinalPage<T extends OrdinalRow, R extends Readonly<Record<string, unknown>>>(
  scope: object,
  page: Readonly<{ items: readonly T[]; hasMore: boolean }>,
  kind: string,
  cursorScope: string,
  map: (row: T) => R,
): unknown {
  return budgetPage(page, map, (budgeted) => ({
    ...scope,
    items: budgeted.items,
    ...(budgeted.hasMore && budgeted.lastRow !== undefined
      ? { nextCursor: encodeCursor(kind, cursorScope, [budgeted.lastRow.ordinal]) }
      : {}),
  }));
}

type PageOmission = Readonly<{ omitted: true; reason: "response_size_limit"; ordinal?: number }>;
type BudgetedPage<T, R> = Readonly<{
  items: readonly (R | PageOmission)[];
  hasMore: boolean;
  lastRow?: T;
}>;
type PageProjection = Readonly<Record<string, unknown> & { items: readonly unknown[] }>;

function budgetPage<
  T extends Readonly<Record<string, unknown>>,
  R extends Readonly<Record<string, unknown>>,
  P extends PageProjection,
>(
  page: Readonly<{ items: readonly T[]; hasMore: boolean }>,
  map: (row: T) => R,
  project: (budgeted: BudgetedPage<T, R>) => P,
): P {
  const items: (R | PageOmission)[] = [];
  let itemsJsonBytes = 0;
  let consumed = 0;
  for (let index = 0; index < page.items.length; index += 1) {
    const row = page.items[index]!;
    const item = map(row);
    const itemJsonBytes = jsonBytes(item);
    const candidate = budgetedPage(page, [...items, item], index + 1);
    if (pageJsonBytes(project, candidate, itemsJsonBytes + itemJsonBytes) <= MAX_PAGE_JSON_BYTES) {
      items.push(item);
      itemsJsonBytes += itemJsonBytes;
      consumed = index + 1;
      continue;
    }

    const itemOnly = budgetedPage(page, [item], index + 1);
    if (pageJsonBytes(project, itemOnly, itemJsonBytes) <= MAX_PAGE_JSON_BYTES) break;

    const ordinal = typeof row.ordinal === "number" ? row.ordinal : undefined;
    const omission: PageOmission = {
      omitted: true,
      reason: "response_size_limit",
      ...(ordinal === undefined ? {} : { ordinal }),
    };
    const omissionJsonBytes = jsonBytes(omission);
    const omittedCandidate = budgetedPage(page, [...items, omission], index + 1);
    if (pageJsonBytes(project, omittedCandidate, itemsJsonBytes + omissionJsonBytes) > MAX_PAGE_JSON_BYTES) break;
    items.push(omission);
    itemsJsonBytes += omissionJsonBytes;
    consumed = index + 1;
  }

  const result = project(budgetedPage(page, items, consumed));
  if (jsonBytes(result) > MAX_PAGE_JSON_BYTES) throw persistenceContractViolation();
  return result;
}

function budgetedPage<T, R>(
  page: Readonly<{ items: readonly T[]; hasMore: boolean }>,
  items: readonly (R | PageOmission)[],
  consumed: number,
): BudgetedPage<T, R> {
  return {
    items,
    hasMore: page.hasMore || consumed < page.items.length,
    ...(consumed === 0 ? {} : { lastRow: page.items[consumed - 1] }),
  };
}

function pageJsonBytes<T, R, P extends PageProjection>(
  project: (budgeted: BudgetedPage<T, R>) => P,
  budgeted: BudgetedPage<T, R>,
  itemsJsonBytes: number,
): number {
  const emptyItemsProjection = project({ ...budgeted, items: [] });
  return jsonBytes(emptyItemsProjection) + itemsJsonBytes + Math.max(0, budgeted.items.length - 1);
}

function jsonBytes(value: Readonly<Record<string, unknown>>): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function splitPage<T>(rows: readonly T[], limit: number): Readonly<{ items: readonly T[]; hasMore: boolean }> {
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

function encodeCursor(kind: string, scope: string, key: readonly (string | number)[]): string {
  return `v1.${Buffer.from(JSON.stringify({ v: 1, q: kind, s: scope, k: key })).toString("base64url")}`;
}

function decodeCursor(value: unknown, kind: string, scope: string, keyLength: number): readonly unknown[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 2_048 || !value.startsWith("v1.")) throw invalidCursor();
  try {
    const decoded = JSON.parse(Buffer.from(value.slice(3), "base64url").toString("utf8")) as unknown;
    if (!isPlainObject(decoded) || Object.keys(decoded).sort().join(",") !== "k,q,s,v") throw invalidCursor();
    if (
      decoded.v !== 1 ||
      decoded.q !== kind ||
      decoded.s !== scope ||
      !Array.isArray(decoded.k) ||
      decoded.k.length !== keyLength
    ) {
      throw invalidCursor();
    }
    if (encodeCursor(kind, scope, decoded.k as readonly (string | number)[]) !== value) throw invalidCursor();
    if (!decoded.k.every((item) => typeof item === "string" || Number.isSafeInteger(item))) throw invalidCursor();
    return decoded.k;
  } catch (error) {
    if (error instanceof RepositoryReadError) throw error;
    throw invalidCursor();
  }
}

function decodeOrdinalCursor(value: unknown, kind: string, scope: string): number {
  const cursor = decodeCursor(value, kind, scope, 1);
  if (cursor === undefined) return 0;
  if (!Number.isSafeInteger(cursor[0]) || (cursor[0] as number) < 0) throw invalidCursor();
  return cursor[0] as number;
}

function readLimit(value: unknown, limits: Readonly<{ default: number; max: number }>): number {
  if (value === undefined) return limits.default;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > limits.max) {
    throw invalidRequest("limit");
  }
  return value as number;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) throw invalidRequest(field);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field);
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) throw invalidRequest("enum");
  return value as T;
}

function optionalLocalRepositoryKeys(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > SESSION_METADATA_LIMITS.repositoryFilterMaxItems ||
    value.some((item) => !isLocalRepositoryKey(item))
  ) {
    throw invalidRequest("localRepositoryKeys");
  }
  return [...new Set(value as string[])].sort();
}

function optionalQuerySearchKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > SESSION_METADATA_LIMITS.queryMaxLength * 3 ||
    value.includes("\0") ||
    sessionSearchKey(value) !== value
  ) {
    throw invalidRequest("querySearchKey");
  }
  return value;
}

function decodeRepositoryNames(value: string): readonly string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new TypeError("Repository names projection is invalid.");
  }
  return parsed;
}

function assertExactKeys(payload: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  if (Object.keys(payload).some((key) => !allowed.includes(key))) throw invalidRequest("payload");
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function snakeToCamel(row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([, value]) => value !== null)
      .map(([key, value]) => [key.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase()), value]),
  );
}

function snakeToCamelWithNulls(row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase()),
      value,
    ]),
  );
}

function runCursorScope(scope: Readonly<{ workspaceKey: string; sessionId: string; runId: string }>): string {
  return scopeDigest(scope);
}

function scopeDigest(scope: Readonly<Record<string, unknown>>): string {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(scope).sort(([left], [right]) => left.localeCompare(right))),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

function invalidRequest(field: string): RepositoryReadError {
  return new RepositoryReadError("request_invalid", `Repository read request field is invalid: ${field}.`);
}

function invalidCursor(): RepositoryReadError {
  return new RepositoryReadError("cursor_invalid", "Repository read cursor is invalid.");
}

function notFound(): RepositoryReadError {
  return new RepositoryReadError("not_found", "Repository resource was not found.");
}

function persistenceContractViolation(): TypeError {
  return new TypeError("Repository projection violates the persistence contract.");
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

type OrdinalRow = Readonly<Record<string, unknown> & { ordinal: number }>;
type RunInputIdempotencyRow = Readonly<{
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
type RunInputReplayRow = Readonly<{
  message_id: string;
  message_ordinal: number;
  run_id: string;
  run_attempt_id: string;
  provider_binding_id: string | null;
  delivery_state: RunInputAdmissionResult["deliveryState"];
  resolution_code: RunInputAdmissionResult["resolutionCode"];
  created_at: number;
  dispatching_at: number | null;
  resolved_at: number | null;
}>;
type RunCancelReplayRow = Readonly<{
  phase: string;
  cancel_requested_at: number | null;
  cancel_acknowledged_at: number | null;
  terminal_at: number | null;
}>;
type RunOutputItemRow = Readonly<{
  id: string;
  run_id: string;
  ordinal: number;
  category: string;
  kind: string;
  summary: string;
  completion_state: string;
  payload_state: string;
  payload_original_byte_length: number | null;
  stored_payload_id: string | null;
  redaction_state: string;
  created_at: number;
}>;
type RunInputDeliveryRow = Readonly<Record<string, unknown>> &
  Readonly<{
    message_id: string;
    run_id: string;
    attempt_id: string;
    binding_id: string | null;
    delivery_state: "pending" | "dispatching";
    created_at: number;
    dispatching_at: number | null;
  }>;
type MessageRow = Readonly<{
  id: string;
  session_id: string;
  ordinal: number;
  role: string;
  content_byte_length: number;
  inline_content: string | null;
  created_at: number;
  workspace_key: string;
}>;
type MessageQueryRow = Readonly<Record<string, unknown>> & Readonly<{ scope_only: number }>;
type RunHistoryRow = Readonly<{
  run_id: string;
  session_id: string;
  ordinal: number;
  initiating_message_id: string;
  final_assistant_message_id: string | null;
  retry_of_run_id: string | null;
  phase: string;
  failure_origin: string | null;
  error_summary: string | null;
  cancel_requested_at: number | null;
  cancel_acknowledged_at: number | null;
  created_at: number;
  started_at: number | null;
  terminal_at: number | null;
  updated_at: number;
  workspace_key: string;
}>;
type RunHistoryQueryRow = Readonly<Record<string, unknown>> & Readonly<{ scope_only: number }>;
type SessionPageRow = Readonly<{
  id: string;
  title: string;
  workspace_key: string;
  workspace_path: string;
  local_repository_key: string | null;
  repository_name: string | null;
  default_character_id: string;
  lifecycle_status: string;
  created_at: number;
  updated_at: number;
  last_activity_at: number;
  active_run_id: string | null;
  active_run_created_at: number | null;
  latest_run_id: string | null;
  latest_run_phase: string | null;
  latest_run_terminal_at: number | null;
}>;
type LocalRepositoryPageRow = Readonly<{
  local_repository_key: string;
  repository_names_json: string;
  repository_name_count: number;
  session_count: number;
  last_activity_at: number;
}>;
type SessionDetailRow = Omit<SessionPageRow, "active_run_created_at" | "latest_run_terminal_at"> &
  Readonly<{
    provider_id: string;
    directories_byte_length: number;
    inline_directories: string | null;
    max_concurrent_child_runs: number;
  }>;

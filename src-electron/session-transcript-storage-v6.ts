import type { DatabaseSync } from "node:sqlite";

import type {
  PublicTranscriptAttachmentV1,
  PublicTranscriptInteractionV1,
  PublicTranscriptMessageV1,
  PublicTranscriptStreamV1,
  PublicTranscriptTurnOptionsV1,
  PublicTranscriptTurnV1,
} from "../src/session-transcript.js";
import { PUBLIC_TRANSCRIPT_SCHEMA_VERSION } from "../src/session-transcript.js";
import { ensureV6Schema } from "./database-schema-v6.js";
import { openAppDatabase } from "./sqlite-connection.js";

type TranscriptExportRow = {
  request_fingerprint: string;
  session_id: string;
  relative_path: string;
  temp_name: string;
  state: "pending" | "applied" | "rejected";
  output_sha256: string | null;
  byte_length: number | null;
  result_json: string | null;
};

type StoredTranscriptTurnRow = {
  turn_id: number;
  phase: "running" | "completed" | "failed" | "canceled";
  started_at: string;
  completed_at: string | null;
  execution_id: string | null;
  effective_turn_json: string | null;
  attachments_json: string | null;
  execution_state: PublicTranscriptTurnV1["state"] | null;
  assistant_text: string | null;
  truncated: number | null;
};

type InteractionProjectionRow = {
  sequence: number;
  id: string;
  execution_id: string;
  kind: "approval" | "elicitation";
  state: "pending" | "answered" | "expired";
  public_payload_json: string;
  response_action: string | null;
  response_submitted_fields_json: string | null;
  expiry_reason: string | null;
  created_at: string;
  resolved_at: string | null;
};

export type SessionTranscriptBaseProjection = {
  session: {
    sessionId: string;
    title: string;
    createdAt: string;
    updatedAt: string;
  };
  messages: PublicTranscriptMessageV1[];
  legacyTurns: PublicTranscriptTurnV1[];
  publicTurns: PublicTranscriptTurnV1[];
  interactions: PublicTranscriptInteractionV1[];
};

export type UpsertSessionTurnPublicContextInput = {
  turnId: number;
  sessionId: string;
  executionId: string;
  effectiveOptions: PublicTranscriptTurnOptionsV1;
  attachments: readonly PublicTranscriptAttachmentV1[];
  createdAt: string;
  updatedAt: string;
};

export type SessionTranscriptExportReplay =
  | {
    kind: "pending";
    sessionId: string;
    relativePath: string;
    tempName: string;
    outputSha256: string | null;
    byteLength: number | null;
    resumed: boolean;
  }
  | { kind: "replay"; result: unknown }
  | { kind: "rejected"; error: unknown };

export class SessionTranscriptIdempotencyConflictError extends Error {
  constructor() {
    super("The transcript export idempotency key was already used with different input.");
    this.name = "SessionTranscriptIdempotencyConflictError";
  }
}

export class SessionTranscriptStorageV6 {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    ensureV6Schema(this.db);
  }

  readBaseProjection(sessionId: string): SessionTranscriptBaseProjection | null {
    const session = this.db.prepare(`
      SELECT id, title, created_at, updated_at
      FROM sessions_v6
      WHERE id = ? AND session_kind = 'default'
    `).get(sessionId) as {
      id: string;
      title: string;
      created_at: string;
      updated_at: string;
    } | undefined;
    if (!session) return null;

    const messageRows = this.db.prepare(`
      SELECT seq, role, body, created_at
      FROM session_messages_v6
      WHERE session_id = ? AND role IN ('user', 'assistant')
      ORDER BY seq ASC
    `).all(sessionId) as Array<{
      seq: number;
      role: "user" | "assistant";
      body: string;
      created_at: string;
    }>;
    const legacyTurnRows = this.db.prepare(`
      SELECT
        turns.id, turns.phase, turns.started_at, turns.completed_at
      FROM session_turns_v6 AS turns
      LEFT JOIN session_turn_public_context_v6 AS context
        ON context.turn_id = turns.id
      WHERE turns.session_id = ? AND context.turn_id IS NULL
      ORDER BY turns.id ASC
    `).all(sessionId) as Array<{
      id: number;
      phase: "running" | "completed" | "failed" | "canceled";
      started_at: string;
      completed_at: string | null;
    }>;
    const publicTurnRows = this.db.prepare(`
      SELECT
        turns.id AS turn_id,
        context.execution_id,
        executions.state,
        context.effective_turn_json,
        context.attachments_json,
        turns.started_at,
        turns.completed_at,
        progress.assistant_text,
        progress.truncated
      FROM session_turn_public_context_v6 AS context
      INNER JOIN session_turns_v6 AS turns
        ON turns.id = context.turn_id AND turns.session_id = context.session_id
      INNER JOIN session_executions_v6 AS executions
        ON executions.id = context.execution_id AND executions.session_id = context.session_id
      LEFT JOIN session_execution_public_progress_v6 AS progress
        ON progress.execution_id = executions.id
      WHERE context.session_id = ?
      ORDER BY turns.id ASC
    `).all(sessionId) as Array<{
      turn_id: number;
      execution_id: string;
      state: PublicTranscriptTurnV1["state"];
      effective_turn_json: string;
      attachments_json: string;
      started_at: string;
      completed_at: string | null;
      assistant_text: string | null;
      truncated: number | null;
    }>;
    const interactionRows = this.db.prepare(`
      SELECT
        interactions.sequence,
        interactions.id,
        interactions.execution_id,
        interactions.kind,
        interactions.state,
        interactions.public_payload_json,
        interactions.response_action,
        interactions.response_submitted_fields_json,
        interactions.expiry_reason,
        interactions.created_at,
        interactions.resolved_at
      FROM session_interactions_v6 AS interactions
      INNER JOIN session_executions_v6 AS executions
        ON executions.id = interactions.execution_id
      WHERE executions.session_id = ?
      ORDER BY interactions.sequence ASC
    `).all(sessionId) as Array<{
      sequence: number;
      id: string;
      execution_id: string;
      kind: "approval" | "elicitation";
      state: "pending" | "answered" | "expired";
      public_payload_json: string;
      response_action: string | null;
      response_submitted_fields_json: string | null;
      expiry_reason: string | null;
      created_at: string;
      resolved_at: string | null;
    }>;

    return {
      session: {
        sessionId: session.id,
        title: session.title,
        createdAt: session.created_at,
        updatedAt: session.updated_at,
      },
      messages: messageRows.map((row) => ({
        sequence: row.seq,
        role: row.role,
        text: decodeMessageText(row.body),
        createdAt: row.created_at,
      })),
      legacyTurns: legacyTurnRows.map((row) => ({
        sequence: row.id,
        projectionCompleteness: "legacy_partial",
        executionId: null,
        state: row.phase,
        effectiveOptions: null,
        attachments: [],
        progress: null,
        toolEvents: [],
        startedAt: row.started_at,
        completedAt: row.completed_at,
      })),
      publicTurns: publicTurnRows.map((row) => projectContextTurn(row)),
      interactions: interactionRows.map((row) => projectInteraction(row)),
    };
  }

  readBaseProjectionStream(sessionId: string): PublicTranscriptStreamV1 | null {
    const session = this.db.prepare(`
      SELECT id, title, created_at, updated_at
      FROM sessions_v6
      WHERE id = ? AND session_kind = 'default'
    `).get(sessionId) as {
      id: string;
      title: string;
      created_at: string;
      updated_at: string;
    } | undefined;
    if (!session) return null;
    const legacy = this.db.prepare(`
      SELECT EXISTS (
        SELECT 1
        FROM session_turns_v6 AS turns
        LEFT JOIN session_turn_public_context_v6 AS context ON context.turn_id = turns.id
        WHERE turns.session_id = ? AND context.turn_id IS NULL
      ) AS value
    `).get(sessionId) as { value: number };
    const db = this.db;
    return {
      schemaVersion: PUBLIC_TRANSCRIPT_SCHEMA_VERSION,
      completeness: legacy.value === 1 ? "legacy_partial" : "complete",
      session: {
        sessionId: session.id,
        title: session.title,
        createdAt: session.created_at,
        updatedAt: session.updated_at,
      },
      messages: {
        *[Symbol.iterator](): Iterator<PublicTranscriptMessageV1> {
          const rows = db.prepare(`
            SELECT seq, role, body, created_at
            FROM session_messages_v6
            WHERE session_id = ? AND role IN ('user', 'assistant')
            ORDER BY seq ASC
          `).iterate(sessionId) as IterableIterator<{
            seq: number;
            role: "user" | "assistant";
            body: string;
            created_at: string;
          }>;
          for (const row of rows) {
            yield {
              sequence: row.seq,
              role: row.role,
              text: decodeMessageText(row.body),
              createdAt: row.created_at,
            };
          }
        },
      },
      turns: {
        *[Symbol.iterator](): Iterator<PublicTranscriptTurnV1> {
          const rows = db.prepare(`
            SELECT
              turns.id AS turn_id,
              turns.phase,
              turns.started_at,
              turns.completed_at,
              context.execution_id,
              context.effective_turn_json,
              context.attachments_json,
              executions.state AS execution_state,
              progress.assistant_text,
              progress.truncated
            FROM session_turns_v6 AS turns
            LEFT JOIN session_turn_public_context_v6 AS context
              ON context.turn_id = turns.id AND context.session_id = turns.session_id
            LEFT JOIN session_executions_v6 AS executions
              ON executions.id = context.execution_id AND executions.session_id = context.session_id
            LEFT JOIN session_execution_public_progress_v6 AS progress
              ON progress.execution_id = context.execution_id
            WHERE turns.session_id = ?
            ORDER BY turns.id ASC
          `).iterate(sessionId) as IterableIterator<StoredTranscriptTurnRow>;
          for (const row of rows) yield projectStoredTurn(row);
        },
      },
      interactions: {
        *[Symbol.iterator](): Iterator<PublicTranscriptInteractionV1> {
          const rows = db.prepare(`
            SELECT
              interactions.sequence,
              interactions.id,
              interactions.execution_id,
              interactions.kind,
              interactions.state,
              interactions.public_payload_json,
              interactions.response_action,
              interactions.response_submitted_fields_json,
              interactions.expiry_reason,
              interactions.created_at,
              interactions.resolved_at
            FROM session_interactions_v6 AS interactions
            INNER JOIN session_executions_v6 AS executions
              ON executions.id = interactions.execution_id
            WHERE executions.session_id = ?
            ORDER BY interactions.sequence ASC
          `).iterate(sessionId) as IterableIterator<InteractionProjectionRow>;
          for (const row of rows) yield projectInteraction(row);
        },
      },
    };
  }

  upsertPublicTurnContext(input: UpsertSessionTurnPublicContextInput): void {
    const effectiveTurnJson = JSON.stringify(normalizeEffectiveOptions(input.effectiveOptions));
    const attachmentsJson = JSON.stringify(input.attachments.map(normalizeAttachment));
    this.transaction(() => {
      const ownership = this.db.prepare(`
        SELECT
          turns.session_id AS turn_session_id,
          executions.session_id AS execution_session_id
        FROM session_turns_v6 AS turns
        INNER JOIN session_executions_v6 AS executions
          ON executions.id = ?
        WHERE turns.id = ?
      `).get(input.executionId, input.turnId) as {
        turn_session_id: string | null;
        execution_session_id: string;
      } | undefined;
      if (
        !ownership
        || ownership.turn_session_id !== input.sessionId
        || ownership.execution_session_id !== input.sessionId
      ) {
        throw new Error("Public turn context owner tuple does not match its turn and execution.");
      }
      this.db.prepare(`
        INSERT INTO session_turn_public_context_v6 (
          turn_id, session_id, execution_id, effective_turn_json,
          attachments_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(turn_id) DO UPDATE SET
          effective_turn_json = excluded.effective_turn_json,
          attachments_json = excluded.attachments_json,
          updated_at = excluded.updated_at
        WHERE session_turn_public_context_v6.session_id = excluded.session_id
          AND session_turn_public_context_v6.execution_id = excluded.execution_id
      `).run(
        input.turnId,
        input.sessionId,
        input.executionId,
        effectiveTurnJson,
        attachmentsJson,
        input.createdAt,
        input.updatedAt,
      );
      const stored = this.db.prepare(`
        SELECT session_id, execution_id
        FROM session_turn_public_context_v6
        WHERE turn_id = ?
      `).get(input.turnId) as { session_id: string; execution_id: string } | undefined;
      if (stored?.session_id !== input.sessionId || stored.execution_id !== input.executionId) {
        throw new Error("Public turn context identity cannot be reassigned.");
      }
    });
  }

  prepareExport(input: {
    idempotencyKey: string;
    requestFingerprint: string;
    sessionId: string;
    relativePath: string;
    tempName: string;
    createdAt: string;
    expiresAt: string;
  }): SessionTranscriptExportReplay {
    return this.transaction(() => {
      this.cleanupTerminalExports(input.createdAt);
      const existing = this.findExport(input.idempotencyKey);
      if (existing) return resolveExport(existing, input.requestFingerprint, true);
      this.db.prepare(`
        INSERT INTO session_transcript_export_idempotency_v6 (
          operation, idempotency_key, request_fingerprint, session_id,
          relative_path, temp_name, state, created_at, expires_at
        ) VALUES ('transcript.export', ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        input.idempotencyKey,
        input.requestFingerprint,
        input.sessionId,
        input.relativePath,
        input.tempName,
        input.createdAt,
        input.expiresAt,
      );
      return {
        kind: "pending",
        sessionId: input.sessionId,
        relativePath: input.relativePath,
        tempName: input.tempName,
        outputSha256: null,
        byteLength: null,
        resumed: false,
      };
    });
  }

  recordPreparedOutput(input: {
    idempotencyKey: string;
    requestFingerprint: string;
    outputSha256: string;
    byteLength: number;
  }): void {
    this.transaction(() => {
      const existing = this.findExportRequired(input.idempotencyKey);
      const resolved = resolveExport(existing, input.requestFingerprint, true);
      if (resolved.kind !== "pending") return;
      if (
        (resolved.outputSha256 !== null && resolved.outputSha256 !== input.outputSha256)
        || (resolved.byteLength !== null && resolved.byteLength !== input.byteLength)
      ) {
        throw new Error("Pending transcript export content changed between retries.");
      }
      this.db.prepare(`
        UPDATE session_transcript_export_idempotency_v6
        SET output_sha256 = ?, byte_length = ?
        WHERE operation = 'transcript.export' AND idempotency_key = ? AND state = 'pending'
      `).run(input.outputSha256, input.byteLength, input.idempotencyKey);
    });
  }

  completeExport(input: {
    idempotencyKey: string;
    requestFingerprint: string;
    outputSha256: string;
    byteLength: number;
    result: unknown;
    completedAt: string;
    expiresAt: string;
  }): unknown {
    return this.transaction(() => {
      const existing = this.findExportRequired(input.idempotencyKey);
      const resolved = resolveExport(existing, input.requestFingerprint, true);
      if (resolved.kind === "replay") return resolved.result;
      if (resolved.kind === "rejected") throw new Error("Rejected transcript export cannot become applied.");
      if (resolved.outputSha256 !== input.outputSha256 || resolved.byteLength !== input.byteLength) {
        throw new Error("Transcript export completion does not match the prepared output.");
      }
      const resultJson = serializeJson(input.result);
      this.db.prepare(`
        UPDATE session_transcript_export_idempotency_v6
        SET state = 'applied', result_json = ?, created_at = ?, expires_at = ?
        WHERE operation = 'transcript.export' AND idempotency_key = ? AND state = 'pending'
      `).run(resultJson, input.completedAt, input.expiresAt, input.idempotencyKey);
      return JSON.parse(resultJson) as unknown;
    });
  }

  rejectExport(input: {
    idempotencyKey: string;
    requestFingerprint: string;
    error: unknown;
    completedAt: string;
    expiresAt: string;
  }): unknown {
    return this.transaction(() => {
      const existing = this.findExportRequired(input.idempotencyKey);
      const resolved = resolveExport(existing, input.requestFingerprint, true);
      if (resolved.kind === "rejected") return resolved.error;
      if (resolved.kind === "replay") throw new Error("Applied transcript export cannot become rejected.");
      const resultJson = serializeJson(input.error);
      this.db.prepare(`
        UPDATE session_transcript_export_idempotency_v6
        SET state = 'rejected', result_json = ?, created_at = ?, expires_at = ?
        WHERE operation = 'transcript.export' AND idempotency_key = ? AND state = 'pending'
      `).run(resultJson, input.completedAt, input.expiresAt, input.idempotencyKey);
      return JSON.parse(resultJson) as unknown;
    });
  }

  cleanupTerminalExports(nowIso: string): number {
    const result = this.db.prepare(`
      DELETE FROM session_transcript_export_idempotency_v6
      WHERE state IN ('applied', 'rejected') AND expires_at <= ?
    `).run(nowIso);
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }

  private findExport(idempotencyKey: string): TranscriptExportRow | null {
    return (this.db.prepare(`
      SELECT request_fingerprint, session_id, relative_path, temp_name, state,
             output_sha256, byte_length, result_json
      FROM session_transcript_export_idempotency_v6
      WHERE operation = 'transcript.export' AND idempotency_key = ?
    `).get(idempotencyKey) as TranscriptExportRow | undefined) ?? null;
  }

  private findExportRequired(idempotencyKey: string): TranscriptExportRow {
    const row = this.findExport(idempotencyKey);
    if (!row) throw new Error("Prepared transcript export idempotency record is missing.");
    return row;
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
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

function resolveExport(
  row: TranscriptExportRow,
  requestFingerprint: string,
  resumed: boolean,
): SessionTranscriptExportReplay {
  if (row.request_fingerprint !== requestFingerprint) {
    throw new SessionTranscriptIdempotencyConflictError();
  }
  if (row.state === "applied") {
    if (!row.result_json) throw new Error("Applied transcript export is missing its canonical result.");
    return { kind: "replay", result: JSON.parse(row.result_json) as unknown };
  }
  if (row.state === "rejected") {
    if (!row.result_json) throw new Error("Rejected transcript export is missing its canonical error.");
    return { kind: "rejected", error: JSON.parse(row.result_json) as unknown };
  }
  return {
    kind: "pending",
    sessionId: row.session_id,
    relativePath: row.relative_path,
    tempName: row.temp_name,
    outputSha256: row.output_sha256,
    byteLength: row.byte_length,
    resumed,
  };
}

function decodeMessageText(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const text = (parsed as { text?: unknown }).text;
      if (typeof text === "string") return text;
    }
  } catch {
    // Legacy rows store the public message text directly.
  }
  return body;
}

function projectContextTurn(row: {
  turn_id: number;
  execution_id: string;
  state: PublicTranscriptTurnV1["state"];
  effective_turn_json: string;
  attachments_json: string;
  started_at: string;
  completed_at: string | null;
  assistant_text: string | null;
  truncated: number | null;
}): PublicTranscriptTurnV1 {
  const attachmentsValue = JSON.parse(row.attachments_json) as unknown;
  if (!Array.isArray(attachmentsValue)) {
    throw new Error(`Invalid public turn attachment projection: ${row.turn_id}`);
  }
  return {
    sequence: row.turn_id,
    projectionCompleteness: "complete",
    executionId: row.execution_id,
    state: row.state,
    effectiveOptions: normalizeEffectiveOptions(parseObject(row.effective_turn_json)),
    attachments: attachmentsValue.map(normalizeAttachment),
    progress: row.assistant_text === null ? null : {
      text: row.assistant_text,
      truncated: row.truncated === 1,
    },
    toolEvents: [],
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function normalizeEffectiveOptions(value: PublicTranscriptTurnOptionsV1 | Record<string, unknown>): PublicTranscriptTurnOptionsV1 {
  const provider = value.provider;
  if (provider !== "codex" && provider !== "copilot") {
    throw new TypeError("Public turn provider must be codex or copilot.");
  }
  const sandboxMode = requireNullableString(value.sandboxMode, "sandboxMode");
  const customAgentName = requireNullableString(value.customAgentName, "customAgentName", true);
  if (
    (provider === "codex" && (sandboxMode === null || customAgentName !== null))
    || (provider === "copilot" && (sandboxMode !== null || customAgentName === null))
  ) {
    throw new TypeError("Public turn provider options do not match the provider.");
  }
  return {
    provider,
    model: requireString(value.model, "model"),
    reasoningEffort: requireString(value.reasoningEffort, "reasoningEffort"),
    approvalMode: requireString(value.approvalMode, "approvalMode"),
    sandboxMode,
    customAgentName,
  };
}

function normalizeAttachment(value: PublicTranscriptAttachmentV1 | unknown): PublicTranscriptAttachmentV1 {
  const attachment = asObject(value);
  const kind = attachment?.kind;
  const relativePath = attachment?.relativePath;
  if (
    (kind !== "file" && kind !== "folder" && kind !== "image")
    || typeof relativePath !== "string"
    || !isPortableRelativePath(relativePath)
  ) {
    throw new TypeError("Public turn attachment must use an allowed kind and portable relative path.");
  }
  return { kind, relativePath };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Public turn ${field} must be a non-empty string.`);
  }
  return value;
}

function requireNullableString(value: unknown, field: string, allowEmpty = false): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`Public turn ${field} must be null or a non-empty string.`);
  }
  return value;
}

function projectStoredTurn(row: StoredTranscriptTurnRow): PublicTranscriptTurnV1 {
  if (row.execution_id === null) {
    return {
      sequence: row.turn_id,
      projectionCompleteness: "legacy_partial",
      executionId: null,
      state: row.phase,
      effectiveOptions: null,
      attachments: [],
      progress: null,
      toolEvents: [],
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }
  if (
    row.execution_state === null
    || row.effective_turn_json === null
    || row.attachments_json === null
  ) {
    throw new Error(`Public turn context is incomplete: ${row.turn_id}`);
  }
  return projectContextTurn({
    turn_id: row.turn_id,
    execution_id: row.execution_id,
    state: row.execution_state,
    effective_turn_json: row.effective_turn_json,
    attachments_json: row.attachments_json,
    started_at: row.started_at,
    completed_at: row.completed_at,
    assistant_text: row.assistant_text,
    truncated: row.truncated,
  });
}

function projectInteraction(row: InteractionProjectionRow): PublicTranscriptInteractionV1 {
  const payload = parseObject(row.public_payload_json);
  const prompt = [payload.prompt, payload.message, payload.title, payload.summary]
    .find((value): value is string => typeof value === "string") ?? "";
  const rawFields = Array.isArray(payload.fields) ? payload.fields : [];
  const fields = rawFields.flatMap((value) => {
    const field = asObject(value);
    const name = stringValue(field?.name);
    if (!name) return [];
    return [{
      name,
      label: stringValue(field?.title),
      type: stringValue(field?.type),
      required: field?.required === true,
    }];
  });
  return {
    sequence: row.sequence,
    interactionId: row.id,
    executionId: row.execution_id,
    kind: row.kind,
    state: row.state,
    prompt,
    fields,
    response: row.response_action === null ? null : {
      action: row.response_action,
      submittedFields: parseStringArray(row.response_submitted_fields_json),
    },
    expiryReason: row.expiry_reason,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function parseObject(value: string): Record<string, unknown> {
  try {
    return asObject(JSON.parse(value) as unknown) ?? {};
  } catch {
    return {};
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function isPortableRelativePath(value: string): boolean {
  return value.length > 0
    && !value.startsWith("/")
    && !value.startsWith("\\")
    && !/^[a-zA-Z]:/.test(value)
    && !value.split(/[\\/]/).some((segment) => segment === "" || segment === "." || segment === "..");
}

function serializeJson(value: unknown): string {
  const result = JSON.stringify(value);
  if (result === undefined) throw new TypeError("Transcript export result must be JSON serializable.");
  return result;
}

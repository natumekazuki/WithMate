import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { CREATE_V4_SCHEMA_SQL } from "./database-schema-v4.js";
import { ensureSourceTypeCheckSupportsMateTalk } from "./mate-source-type-migration.js";
import { openAppDatabase } from "./sqlite-connection.js";

const MATE_ID = "current";

type MateSourceType = "session" | "companion" | "manual" | "system" | "mate_talk";
type MateGrowthSourceType = "explicit_user_instruction" | "user_correction" | "repeated_user_behavior" | "assistant_inference" | "tool_or_file_observation";
type MateGrowthKind = "conversation" | "preference" | "relationship" | "work_style" | "boundary" | "project_context" | "curiosity" | "observation" | "correction";
type MateGrowthTargetSection = "bond" | "work_style" | "project_digest" | "core" | "none";
type MateRetention = "auto" | "force";
type MateRelation = "new" | "reinforces" | "updates" | "contradicts";
type MateGrowthEventState = "candidate" | "applied" | "corrected" | "superseded" | "disabled" | "forgotten" | "failed";

const SOURCE_TYPES = ["session", "companion", "manual", "system", "mate_talk"] as const;
const GROWTH_SOURCE_TYPES = [
  "explicit_user_instruction",
  "user_correction",
  "repeated_user_behavior",
  "assistant_inference",
  "tool_or_file_observation",
] as const;
const GROWTH_KINDS = [
  "conversation",
  "preference",
  "relationship",
  "work_style",
  "boundary",
  "project_context",
  "curiosity",
  "observation",
  "correction",
] as const;
const TARGET_SECTIONS = ["bond", "work_style", "project_digest", "core", "none"] as const;

export type MateGrowthRunInput = {
  sourceType: MateSourceType;
  sourceSessionId?: string | null;
  sourceAuditLogId?: number | null;
  projectDigestId?: string | null;
  triggerReason: string;
  providerId?: string;
  model?: string;
  reasoningEffort?: string;
  operationId?: string | null;
  inputHash?: string;
  candidateCount?: number;
};

export type MateGrowthRunUpdateInput = {
  outputRevisionId?: string | null;
  outputHash?: string;
  appliedCount?: number;
  invalidCount?: number;
  errorPreview?: string;
};

export type MateGrowthEventInput = {
  id?: string;
  sourceGrowthRunId?: number | null;
  sourceType: MateSourceType;
  sourceSessionId?: string | null;
  sourceAuditLogId?: number | null;
  projectDigestId?: string | null;
  growthSourceType: MateGrowthSourceType;
  kind: MateGrowthKind;
  targetSection: MateGrowthTargetSection;
  statement: string;
  statementFingerprint?: string;
  rationalePreview?: string;
  retention?: MateRetention;
  relation?: MateRelation;
  targetClaimKey?: string;
  confidence: number;
  salienceScore: number;
  recurrenceCount?: number;
  projectionAllowed?: boolean;
};

export type MateGrowthEvent = {
  id: string;
  mateId: string;
  sourceGrowthRunId: number | null;
  sourceType: MateSourceType;
  sourceSessionId: string | null;
  sourceAuditLogId: number | null;
  projectDigestId: string | null;
  growthSourceType: MateGrowthSourceType;
  kind: MateGrowthKind;
  targetSection: MateGrowthTargetSection;
  statement: string;
  statementFingerprint: string;
  rationalePreview: string;
  retention: MateRetention;
  relation: MateRelation;
  targetClaimKey: string;
  confidence: number;
  salienceScore: number;
  recurrenceCount: number;
  projectionAllowed: boolean;
  state: MateGrowthEventState;
  appliedRevisionId: string | null;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SavedMateGrowthEvent = {
  id: string;
  created: boolean;
  state: MateGrowthEventState;
};

export type ListPendingGrowthEventsOptions = {
  runId?: number;
  limit?: number;
};

type SavedEventRow = {
  state: MateGrowthEventState;
};

type EventRow = {
  id: string;
  mate_id: string;
  source_growth_run_id: number | null;
  source_type: MateSourceType;
  source_session_id: string | null;
  source_audit_log_id: number | null;
  project_digest_id: string | null;
  growth_source_type: MateGrowthSourceType;
  kind: MateGrowthKind;
  target_section: MateGrowthTargetSection;
  statement: string;
  statement_fingerprint: string;
  rationale_preview: string;
  retention: MateRetention;
  relation: MateRelation;
  target_claim_key: string;
  confidence: number;
  salience_score: number;
  recurrence_count: number;
  projection_allowed: number;
  state: MateGrowthEventState;
  applied_revision_id: string | null;
  applied_at: string | null;
  created_at: string;
  updated_at: string;
};

const UPDATE_RUN_SQL = `
  UPDATE mate_growth_runs
  SET
    status = ?,
    output_revision_id = COALESCE(?, output_revision_id),
    output_hash = COALESCE(?, output_hash),
    applied_count = COALESCE(?, applied_count),
    invalid_count = COALESCE(?, invalid_count),
    error_preview = ?,
    finished_at = ?
  WHERE id = ?
`;

const INSERT_EVENT_SQL = `
  INSERT INTO mate_growth_events (
    id,
    mate_id,
    source_growth_run_id,
    source_type,
    source_session_id,
    source_audit_log_id,
    project_digest_id,
    growth_source_type,
    kind,
    target_section,
    statement,
    statement_fingerprint,
    rationale_preview,
    retention,
    relation,
    target_claim_key,
    confidence,
    salience_score,
    recurrence_count,
    projection_allowed,
    state,
    first_seen_at,
    last_seen_at,
    created_at,
    updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?)
`;

const UPDATE_EVENT_SQL = `
  UPDATE mate_growth_events
  SET
    source_growth_run_id = ?,
    source_type = ?,
    source_session_id = ?,
    source_audit_log_id = ?,
    project_digest_id = ?,
    growth_source_type = ?,
    kind = ?,
    target_section = ?,
    statement = ?,
    statement_fingerprint = ?,
    rationale_preview = ?,
    retention = ?,
    relation = ?,
    target_claim_key = ?,
    confidence = ?,
    salience_score = ?,
    recurrence_count = ?,
    projection_allowed = ?,
    state = 'candidate',
    applied_revision_id = NULL,
    applied_at = NULL,
    disabled_revision_id = NULL,
    disabled_at = NULL,
    forgotten_revision_id = NULL,
    forgotten_at = NULL,
    corrected_by_event_id = NULL,
    superseded_by_event_id = NULL,
    last_seen_at = ?,
    updated_at = ?
  WHERE id = ?
`;

const SELECT_EVENT_BY_ID_SQL = `
  SELECT id, state FROM mate_growth_events WHERE id = ?
`;

const SELECT_EVENT_BY_FINGERPRINT_SQL = `
  SELECT id, state FROM mate_growth_events WHERE statement_fingerprint = ? LIMIT 1
`;

const SELECT_PENDING_EVENTS_SQL = `
  SELECT
    id,
    mate_id,
    source_growth_run_id,
    source_type,
    source_session_id,
    source_audit_log_id,
    project_digest_id,
    growth_source_type,
    kind,
    target_section,
    statement,
    statement_fingerprint,
    rationale_preview,
    retention,
    relation,
    target_claim_key,
    confidence,
    salience_score,
    recurrence_count,
    projection_allowed,
    state,
    applied_revision_id,
    applied_at,
    created_at,
    updated_at
  FROM mate_growth_events
  WHERE mate_id = ?
    AND state = 'candidate'
    AND (? IS NULL OR source_growth_run_id = ?)
  ORDER BY updated_at ASC, id ASC
  LIMIT ?
`;

const MARK_EVENT_APPLIED_SQL = `
  UPDATE mate_growth_events
  SET
    state = 'applied',
    applied_revision_id = ?,
    applied_at = ?,
    forgotten_revision_id = NULL,
    forgotten_at = NULL,
    disabled_revision_id = NULL,
    disabled_at = NULL,
    updated_at = ?
  WHERE id = ?
`;

const MARK_EVENT_SKIPPED_SQL = `
  UPDATE mate_growth_events
  SET
    state = 'disabled',
    applied_revision_id = NULL,
    applied_at = NULL,
    disabled_revision_id = NULL,
    disabled_at = ?,
    forgotten_revision_id = NULL,
    forgotten_at = NULL,
    updated_at = ?
  WHERE id = ?
`;

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeText(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new Error(`${field} が空だよ。`);
  }
  return text;
}

function normalizeOptionalText(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : null;
}

function normalizeInteger(value: unknown, fallback: number, field: string): number {
  const normalized = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`${field} が 0 以上の整数でないよ。`);
  }
  return normalized;
}

function normalizePercent(value: unknown, field: string): number {
  const normalized = normalizeInteger(value, Number.NaN, field);
  if (!Number.isFinite(normalized) || normalized > 100) {
    throw new Error(`${field} が 0-100 の整数でないよ。`);
  }
  return normalized;
}

function normalizePositiveInteger(value: unknown, fallback: number, field: string): number {
  const normalized = normalizeInteger(value, fallback, field);
  if (!Number.isFinite(normalized) || normalized < 1) {
    return fallback;
  }
  return normalized;
}

function normalizeOptionalInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null;
}

function normalizeHash(value: unknown): string {
  return normalizeOptionalText(value) ?? "";
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function resolveRevisionId(db: DatabaseSync, revisionId: string | null): string | null {
  if (revisionId === null) {
    return null;
  }

  const exists = db.prepare(`
    SELECT id
    FROM mate_profile_revisions
    WHERE id = ?
  `).get(revisionId) as { id: string } | undefined;
  return exists ? revisionId : null;
}

function assertOneOf<T extends string>(value: unknown, candidates: readonly T[], field: string): T {
  if (typeof value === "string" && (candidates as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(`${field} が不正です`);
}

function rowToEvent(row: EventRow): MateGrowthEvent {
  return {
    id: row.id,
    mateId: row.mate_id,
    sourceGrowthRunId: row.source_growth_run_id,
    sourceType: row.source_type,
    sourceSessionId: row.source_session_id,
    sourceAuditLogId: row.source_audit_log_id,
    projectDigestId: row.project_digest_id,
    growthSourceType: row.growth_source_type,
    kind: row.kind,
    targetSection: row.target_section,
    statement: row.statement,
    statementFingerprint: row.statement_fingerprint,
    rationalePreview: row.rationale_preview,
    retention: row.retention,
    relation: row.relation,
    targetClaimKey: row.target_claim_key,
    confidence: row.confidence,
    salienceScore: row.salience_score,
    recurrenceCount: row.recurrence_count,
    projectionAllowed: row.projection_allowed === 1,
    state: row.state,
    appliedRevisionId: row.applied_revision_id,
    appliedAt: row.applied_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MateGrowthStorage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    this.initializeSchema();
  }

  private initializeSchema(): void {
    const growthEventsSql = CREATE_V4_SCHEMA_SQL.find((statement) => statement.includes("CREATE TABLE IF NOT EXISTS mate_growth_events"));
    const growthRunsSql = CREATE_V4_SCHEMA_SQL.find((statement) => statement.includes("CREATE TABLE IF NOT EXISTS mate_growth_runs"));
    if (growthEventsSql) {
      ensureSourceTypeCheckSupportsMateTalk(this.db, "mate_growth_events", growthEventsSql);
    }
    if (growthRunsSql) {
      ensureSourceTypeCheckSupportsMateTalk(this.db, "mate_growth_runs", growthRunsSql);
    }
    for (const statement of CREATE_V4_SCHEMA_SQL) {
      this.db.exec(statement);
    }
  }

  private withTransaction<T>(runner: (db: DatabaseSync) => T): T {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION;");
    try {
      const result = runner(this.db);
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  createRun(input: MateGrowthRunInput): number {
    const sourceType = assertOneOf(input.sourceType, SOURCE_TYPES, "sourceType");
    const triggerReason = normalizeText(input.triggerReason, "triggerReason");
    const sourceSessionId = normalizeOptionalText(input.sourceSessionId);
    const sourceAuditLogId = normalizeOptionalInteger(input.sourceAuditLogId);
    const projectDigestId = normalizeOptionalText(input.projectDigestId);
    const providerId = normalizeOptionalText(input.providerId);
    const model = normalizeOptionalText(input.model);
    const reasoningEffort = normalizeOptionalText(input.reasoningEffort);
    const operationId = normalizeOptionalText(input.operationId);
    const inputHash = normalizeHash(input.inputHash);
    const candidateCount = normalizeInteger(input.candidateCount ?? 0, 0, "candidateCount");
    const now = nowIso();
    const result = this.db.prepare(`
      INSERT INTO mate_growth_runs (
        mate_id,
        source_type,
        source_session_id,
        source_audit_log_id,
        project_digest_id,
        trigger_reason,
        provider_id,
        model,
        reasoning_effort,
        status,
        operation_id,
        input_hash,
        candidate_count,
        started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
    `).run(
      MATE_ID,
      sourceType,
      sourceSessionId,
      sourceAuditLogId ?? null,
      projectDigestId,
      triggerReason,
      providerId ?? "",
      model ?? "",
      reasoningEffort ?? "",
      operationId ?? "",
      inputHash,
      candidateCount,
      now,
    );
    return result.lastInsertRowid as number;
  }

  finishRun(runId: number, input: MateGrowthRunUpdateInput = {}): void {
    const now = nowIso();
    const outputHash = normalizeOptionalText(input.outputHash);
    const outputRevisionId = resolveRevisionId(this.db, normalizeOptionalText(input.outputRevisionId));
    const appliedCount = normalizeInteger(input.appliedCount, 0, "appliedCount");
    const invalidCount = normalizeInteger(input.invalidCount, 0, "invalidCount");
    const errorPreview = normalizeOptionalText(input.errorPreview) ?? "";

    this.db.prepare(UPDATE_RUN_SQL).run(
      "completed",
      outputRevisionId,
      outputHash,
      appliedCount,
      invalidCount,
      errorPreview,
      now,
      runId,
    );
  }

  failRun(runId: number, errorPreview = ""): void {
    const now = nowIso();
    const normalizedErrorPreview = normalizeOptionalText(errorPreview) ?? "";
    this.db.prepare(UPDATE_RUN_SQL).run(
      "failed",
      null,
      null,
      null,
      null,
      normalizedErrorPreview,
      now,
      runId,
    );
  }

  upsertEvent(input: MateGrowthEventInput): SavedMateGrowthEvent {
    const sourceType = assertOneOf(input.sourceType, SOURCE_TYPES, "sourceType");
    const growthSourceType = assertOneOf(input.growthSourceType, GROWTH_SOURCE_TYPES, "growthSourceType");
    const kind = assertOneOf(input.kind, GROWTH_KINDS, "kind");
    const targetSection = assertOneOf(input.targetSection, TARGET_SECTIONS, "targetSection");
    const statement = normalizeText(input.statement, "statement");
    const statementFingerprint = normalizeOptionalText(input.statementFingerprint) ?? sha256Hex(statement);
    const rationalePreview = normalizeOptionalText(input.rationalePreview) ?? "";
    const retention: MateRetention = input.retention === "force" ? "force" : "auto";
    const relation: MateRelation = normalizeOptionalText(input.relation) === "reinforces" ? "reinforces"
      : normalizeOptionalText(input.relation) === "updates" ? "updates"
      : normalizeOptionalText(input.relation) === "contradicts" ? "contradicts"
      : "new";
    const targetClaimKey = normalizeOptionalText(input.targetClaimKey) ?? "";
    const confidence = normalizePercent(input.confidence, "confidence");
    const salienceScore = normalizePercent(input.salienceScore, "salienceScore");
    const recurrenceCount = normalizePositiveInteger(input.recurrenceCount, 1, "recurrenceCount");
    const projectionAllowed = input.projectionAllowed === true ? 1 : 0;
    const sourceGrowthRunId = input.sourceGrowthRunId ?? null;
    const sourceSessionId = normalizeOptionalText(input.sourceSessionId);
    const sourceAuditLogId = normalizeOptionalInteger(input.sourceAuditLogId);
    const projectDigestId = normalizeOptionalText(input.projectDigestId);
    const id = normalizeOptionalText(input.id) ?? randomUUID();
    const now = nowIso();

    const byIdStmt = this.db.prepare(SELECT_EVENT_BY_ID_SQL);
    const byFingerprintStmt = this.db.prepare(SELECT_EVENT_BY_FINGERPRINT_SQL);
    const insertStmt = this.db.prepare(INSERT_EVENT_SQL);
    const updateStmt = this.db.prepare(UPDATE_EVENT_SQL);

    const existingById = byIdStmt.get(id) as { id: string; state: string } | undefined;
    const existingByFingerprint = byFingerprintStmt.get(statementFingerprint) as { id: string; state: string } | undefined;
    const existing = existingById ?? existingByFingerprint;
    const targetId = existing?.id ?? id;

    this.withTransaction(() => {
      if (existing) {
        updateStmt.run(
          sourceGrowthRunId,
          sourceType,
          sourceSessionId,
          sourceAuditLogId,
          projectDigestId,
          growthSourceType,
          kind,
          targetSection,
          statement,
          statementFingerprint,
          rationalePreview,
          retention,
          relation,
          targetClaimKey,
          confidence,
          salienceScore,
          recurrenceCount,
          projectionAllowed,
          now,
          now,
          targetId,
        );
      } else {
        insertStmt.run(
          targetId,
          MATE_ID,
          sourceGrowthRunId,
          sourceType,
          sourceSessionId,
          sourceAuditLogId,
          projectDigestId,
          growthSourceType,
          kind,
          targetSection,
          statement,
          statementFingerprint,
          rationalePreview,
          retention,
          relation,
          targetClaimKey,
          confidence,
          salienceScore,
          recurrenceCount,
          projectionAllowed,
          now,
          now,
          now,
          now,
        );
      }
    });

    const saved = this.db.prepare("SELECT state FROM mate_growth_events WHERE id = ?").get(targetId) as SavedEventRow | undefined;
    if (!saved) {
      throw new Error("保存した growth event を読み直せなかったよ。");
    }

    return {
      id: targetId,
      created: existing === undefined,
      state: saved.state,
    };
  }

  listPendingEvents(options: ListPendingGrowthEventsOptions = {}): MateGrowthEvent[] {
    const runId = options.runId === undefined ? null : options.runId;
    const limit = normalizePositiveInteger(options.limit, 100, "limit");

    const rows = this.db.prepare(SELECT_PENDING_EVENTS_SQL).all(
      MATE_ID,
      runId,
      runId,
      limit,
    ) as EventRow[];
    return rows.map(rowToEvent);
  }

  markEventApplied(eventId: string, appliedRevisionId?: string): void {
    const targetId = normalizeText(eventId, "eventId");
    const now = nowIso();
    let revisionId = normalizeOptionalText(appliedRevisionId);
    if (revisionId !== null) {
      const revisionExists = this.db.prepare(`
        SELECT id
        FROM mate_profile_revisions
        WHERE id = ?
      `).get(revisionId) as { id: string } | undefined;

      if (!revisionExists) {
        revisionId = null;
      }
    }

    this.db.prepare(MARK_EVENT_APPLIED_SQL).run(
      revisionId,
      now,
      now,
      targetId,
    );
  }

  markEventSkipped(eventId: string): void {
    const targetId = normalizeText(eventId, "eventId");
    const now = nowIso();
    this.db.prepare(MARK_EVENT_SKIPPED_SQL).run(
      now,
      now,
      targetId,
    );
  }

  close(): void {
    this.db.close();
  }
}

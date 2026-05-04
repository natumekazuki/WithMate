import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { CREATE_V4_SCHEMA_SQL } from "./database-schema-v4.js";
import { ensureSourceTypeCheckSupportsMateTalk } from "./mate-source-type-migration.js";
import { openAppDatabase } from "./sqlite-connection.js";

const MATE_ID = "current";

type MateGrowthEventState = "candidate" | "applied" | "corrected" | "superseded" | "disabled" | "forgotten" | "failed";
type MateSourceType = "session" | "companion" | "manual" | "system" | "mate_talk";
type MateGrowthSourceType = "explicit_user_instruction" | "user_correction" | "repeated_user_behavior" | "assistant_inference" | "tool_or_file_observation";
type MateMemoryKind = "conversation" | "preference" | "relationship" | "work_style" | "boundary" | "project_context" | "curiosity" | "observation" | "correction";
type MateTargetSection = "bond" | "work_style" | "project_digest" | "core" | "none";
type MateRetention = "auto" | "force";
type MateRelation = "new" | "reinforces" | "updates" | "contradicts";
type MateMemoryTagCatalogState = "active" | "disabled";
type MateMemoryTagCatalogCreatedBy = "app" | "llm" | "user";

const SOURCE_TYPES = ["session", "companion", "manual", "system", "mate_talk"] as const;
const GROWTH_SOURCE_TYPES = [
  "explicit_user_instruction",
  "user_correction",
  "repeated_user_behavior",
  "assistant_inference",
  "tool_or_file_observation",
] as const;
const MEMORY_KINDS = [
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

type SavedTagInput = {
  type: string;
  value: string;
};

export type MateGeneratedMemoryInput = {
  sourceType: MateSourceType;
  sourceSessionId?: string | null;
  sourceAuditLogId?: number | null;
  projectDigestId?: string | null;
  growthSourceType: MateGrowthSourceType;
  kind: MateMemoryKind;
  targetSection: MateTargetSection;
  statement: string;
  rationalePreview?: string;
  retention?: MateRetention;
  relation?: MateRelation;
  targetClaimKey?: string;
  confidence: number;
  salienceScore: number;
  recurrenceCount?: number;
  projectionAllowed?: boolean;
  tags?: SavedTagInput[];
  id?: string;
  statementFingerprint?: string;
};

export type SaveGeneratedMemoriesInput = {
  memories: MateGeneratedMemoryInput[];
};

type NormalizedTag = {
  type: string;
  value: string;
  typeNormalized: string;
  valueNormalized: string;
};

type NormalizedMemory = {
  id: string;
  sourceType: MateSourceType;
  sourceSessionId: string | null;
  sourceAuditLogId: number | null;
  projectDigestId: string | null;
  growthSourceType: MateGrowthSourceType;
  kind: MateMemoryKind;
  targetSection: MateTargetSection;
  statement: string;
  statementFingerprint: string;
  rationalePreview: string;
  retention: MateRetention;
  relation: MateRelation;
  targetClaimKey: string;
  confidence: number;
  salienceScore: number;
  recurrenceCount: number;
  projectionAllowed: 0 | 1;
  tags: NormalizedTag[];
};

export type SavedMateTag = {
  type: string;
  value: string;
  valueNormalized: string;
};

export type SavedMateMemory = {
  id: string;
  created: boolean;
  state: MateGrowthEventState;
  statementFingerprint: string;
  tags: SavedMateTag[];
};

export type MateMemoryTagCatalogItem = {
  id: number;
  tagType: string;
  tagValue: string;
  tagValueNormalized: string;
  description: string;
  aliases: string;
  state: MateMemoryTagCatalogState;
  usageCount: number;
  createdBy: MateMemoryTagCatalogCreatedBy;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOptionalText(value: unknown): string | null {
  const normalized = normalizeText(value);
  return normalized.length > 0 ? normalized : null;
}

function normalizeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
}

function normalizeNullableInteger(value: unknown): number | null {
  const normalized = normalizeInteger(value, Number.NaN);
  return Number.isFinite(normalized) ? normalized : null;
}

function normalizePercent(value: unknown, field: string): number {
  const normalized = normalizeInteger(value, Number.NaN);
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 100) {
    throw new Error(`${field} が 0-100 の整数でないよ。`);
  }
  return normalized;
}

function normalizePositive(value: unknown, fallback: number, field: string): number {
  const normalized = normalizeInteger(value, Number.NaN);
  if (!Number.isFinite(normalized) || normalized < 1) {
    return fallback;
  }
  return normalized;
}

function assertOneOf<T extends string>(value: unknown, candidates: readonly T[], field: string): T {
  if (typeof value === "string" && (candidates as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(`${field} が不正だよ。`);
}

function normalizeTagValue(value: unknown): string {
  return normalizeText(value).toLowerCase();
}

function normalizeTags(tags: unknown): NormalizedTag[] {
  if (!Array.isArray(tags)) {
    return [];
  }

  const unique = new Set<string>();
  const normalized: NormalizedTag[] = [];

  for (const tag of tags) {
    if (!tag || typeof tag !== "object") {
      continue;
    }
    const rawType = normalizeText((tag as { type?: unknown }).type);
    const rawValue = normalizeText((tag as { value?: unknown }).value);
    const normalizedType = normalizeTagValue(rawType);
    const normalizedValue = normalizeTagValue(rawValue);
    if (!normalizedType || !normalizedValue) {
      continue;
    }
    const key = `${normalizedType}\u0000${normalizedValue}`;
    if (unique.has(key)) {
      continue;
    }
    unique.add(key);
    normalized.push({
      type: rawType,
      value: rawValue,
      typeNormalized: normalizedType,
      valueNormalized: normalizedValue,
    });
  }

  return normalized;
}

function normalizeMemoryInput(input: MateGeneratedMemoryInput): NormalizedMemory {
  const sourceType = assertOneOf(input.sourceType, SOURCE_TYPES, "sourceType");
  const growthSourceType = assertOneOf(input.growthSourceType, GROWTH_SOURCE_TYPES, "growthSourceType");
  const kind = assertOneOf(input.kind, MEMORY_KINDS, "kind");
  const targetSection = assertOneOf(input.targetSection, TARGET_SECTIONS, "targetSection");

  const statement = normalizeText(input.statement);
  if (!statement) {
    throw new Error("statement が空だよ。");
  }

  const statementFingerprint = normalizeOptionalText(input.statementFingerprint) ?? sha256Hex(statement);
  const tags = normalizeTags(input.tags);
  const recurrenceCount = normalizePositive(input.recurrenceCount, 1, "recurrenceCount");
  const confidence = normalizePercent(input.confidence, "confidence");
  const salienceScore = normalizePercent(input.salienceScore, "salienceScore");

  return {
    id: normalizeText(input.id) || randomUUID(),
    sourceType,
    sourceSessionId: normalizeOptionalText(input.sourceSessionId),
    sourceAuditLogId: normalizeNullableInteger(input.sourceAuditLogId),
    projectDigestId: normalizeOptionalText(input.projectDigestId),
    growthSourceType,
    kind,
    targetSection,
    statement,
    statementFingerprint,
    rationalePreview: normalizeText(input.rationalePreview),
    retention: normalizeOptionalText(input.retention) === "force" ? "force" : "auto",
    relation: normalizeOptionalText(input.relation) === "reinforces" ? "reinforces"
      : normalizeOptionalText(input.relation) === "updates" ? "updates"
      : normalizeOptionalText(input.relation) === "contradicts" ? "contradicts"
      : "new",
    targetClaimKey: normalizeText(input.targetClaimKey),
    confidence,
    salienceScore,
    recurrenceCount,
    projectionAllowed: input.projectionAllowed === true ? 1 : 0,
    tags,
  };
}

type MemoryRow = {
  id: string;
  state: MateGrowthEventState;
};

type TagCatalogRow = {
  id: number;
  tag_type: string;
  tag_value: string;
  tag_value_normalized: string;
  description: string;
  aliases: string;
  state: MateMemoryTagCatalogState;
  usage_count: number;
  created_by: MateMemoryTagCatalogCreatedBy;
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
};

const INSERT_GROWTH_EVENT_SQL = `
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
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const UPDATE_GROWTH_EVENT_SQL = `
  UPDATE mate_growth_events
  SET
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
    forgotten_at = NULL,
    disabled_at = NULL,
    last_seen_at = ?,
    updated_at = ?
  WHERE id = ?
`;

const SELECT_MEMORY_ID_BY_ID_SQL = `
  SELECT id FROM mate_growth_events WHERE id = ?
`;

const SELECT_MEMORY_ID_BY_FINGERPRINT_SQL = `
  SELECT id FROM mate_growth_events WHERE statement_fingerprint = ? LIMIT 1
`;

const SELECT_MEMORY_SQL = `
  SELECT id, state
  FROM mate_growth_events
  WHERE id = ?
`;

const SELECT_MEMORY_TAGS_SQL = `
  SELECT tag_type, tag_value, tag_value_normalized
  FROM mate_memory_tags
  WHERE memory_id = ?
  ORDER BY id
`;

const INSERT_MEMORY_TAG_SQL = `
  INSERT INTO mate_memory_tags (
    memory_id,
    tag_type,
    tag_value,
    tag_value_normalized,
    created_at
  ) VALUES (?, ?, ?, ?, ?)
`;

const DELETE_MEMORY_TAGS_SQL = `
  DELETE FROM mate_memory_tags
  WHERE memory_id = ?
`;

const UPSERT_MEMORY_TAG_CATALOG_SQL = `
  INSERT INTO mate_memory_tag_catalog (
    tag_type,
    tag_value,
    tag_value_normalized,
    description,
    aliases,
    state,
    usage_count,
    created_by,
    created_at,
    updated_at
  ) VALUES (?, ?, ?, '', '', 'active', 1, 'llm', ?, ?)
  ON CONFLICT(tag_type, tag_value_normalized) DO UPDATE SET
    usage_count = usage_count + 1,
    updated_at = excluded.updated_at,
    tag_value = CASE
      WHEN length(excluded.tag_value) = 0 THEN mate_memory_tag_catalog.tag_value
      ELSE excluded.tag_value
    END
`;

const SELECT_MEMORY_TAG_CATALOG_SQL = `
  SELECT
    id,
    tag_type,
    tag_value,
    tag_value_normalized,
    description,
    aliases,
    state,
    usage_count,
    created_by,
    created_at,
    updated_at,
    disabled_at
  FROM mate_memory_tag_catalog
  WHERE state = 'active'
  ORDER BY tag_type, tag_value_normalized
`;

const FORGET_MEMORY_SQL = `
  UPDATE mate_growth_events
  SET
    state = 'forgotten',
    forgotten_at = ?,
    updated_at = ?
  WHERE id = ?
`;

export class MateMemoryStorage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    this.initializeSchema();
  }

  private initializeSchema(): void {
    const growthEventsSql = CREATE_V4_SCHEMA_SQL.find((statement) => statement.includes("CREATE TABLE IF NOT EXISTS mate_growth_events"));
    if (growthEventsSql) {
      ensureSourceTypeCheckSupportsMateTalk(this.db, "mate_growth_events", growthEventsSql);
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

  saveGeneratedMemories(input: SaveGeneratedMemoriesInput): SavedMateMemory[] {
    if (!input || !Array.isArray(input.memories)) {
      throw new Error("memories 配列が必要だよ。");
    }

    const now = nowIso();
    const normalizedInputs = input.memories.map((memory) => normalizeMemoryInput(memory));

    if (normalizedInputs.length === 0) {
      return [];
    }

    const findByIdStmt = this.db.prepare(SELECT_MEMORY_ID_BY_ID_SQL);
    const findByFingerprintStmt = this.db.prepare(SELECT_MEMORY_ID_BY_FINGERPRINT_SQL);
    const selectMemoryStmt = this.db.prepare(SELECT_MEMORY_SQL);
    const selectMemoryTagsStmt = this.db.prepare(SELECT_MEMORY_TAGS_SQL);
    const insertEventStmt = this.db.prepare(INSERT_GROWTH_EVENT_SQL);
    const updateEventStmt = this.db.prepare(UPDATE_GROWTH_EVENT_SQL);
    const insertTagStmt = this.db.prepare(INSERT_MEMORY_TAG_SQL);
    const deleteTagsStmt = this.db.prepare(DELETE_MEMORY_TAGS_SQL);
    const upsertTagCatalogStmt = this.db.prepare(UPSERT_MEMORY_TAG_CATALOG_SQL);

    const results = this.withTransaction(() => {
      const saved: SavedMateMemory[] = [];

      for (const memory of normalizedInputs) {
        const existingById = findByIdStmt.get(memory.id) as MemoryRow | undefined;
        const existingByFingerprint = findByFingerprintStmt.get(memory.statementFingerprint) as MemoryRow | undefined;
        const targetRow = existingById ?? existingByFingerprint;

        let created = false;
        const memoryId = targetRow?.id || memory.id;

        if (targetRow) {
          updateEventStmt.run(
            memory.sourceType,
            memory.sourceSessionId,
            Number.isFinite(memory.sourceAuditLogId) ? memory.sourceAuditLogId : null,
            memory.projectDigestId,
            memory.growthSourceType,
            memory.kind,
            memory.targetSection,
            memory.statement,
            memory.statementFingerprint,
            memory.rationalePreview,
            memory.retention,
            memory.relation,
            memory.targetClaimKey,
            memory.confidence,
            memory.salienceScore,
            memory.recurrenceCount,
            memory.projectionAllowed,
            now,
            now,
            memoryId,
          );
        } else {
          insertEventStmt.run(
            memoryId,
            MATE_ID,
            null,
            memory.sourceType,
            memory.sourceSessionId,
            Number.isFinite(memory.sourceAuditLogId) ? memory.sourceAuditLogId : null,
            memory.projectDigestId,
            memory.growthSourceType,
            memory.kind,
            memory.targetSection,
            memory.statement,
            memory.statementFingerprint,
            memory.rationalePreview,
            memory.retention,
            memory.relation,
            memory.targetClaimKey,
            memory.confidence,
            memory.salienceScore,
            memory.recurrenceCount,
            memory.projectionAllowed,
            "candidate",
            now,
            now,
            now,
            now,
          );
          created = true;
        }

        if (memory.tags) {
          deleteTagsStmt.run(memoryId);
          for (const tag of memory.tags) {
            insertTagStmt.run(
              memoryId,
              tag.typeNormalized,
              tag.value,
              tag.valueNormalized,
              now,
            );
            upsertTagCatalogStmt.run(
              tag.typeNormalized,
              tag.value,
              tag.valueNormalized,
              now,
              now,
            );
          }
        }

        const row = selectMemoryStmt.get(memoryId) as MemoryRow | undefined;
        if (!row) {
          throw new Error("保存した growth event を読み直せなかったよ。");
        }

        const tagRows = selectMemoryTagsStmt.all(memoryId) as Array<{
          tag_type: string;
          tag_value: string;
          tag_value_normalized: string;
        }>;

        saved.push({
          id: memoryId,
          created,
          state: row.state,
          statementFingerprint: memory.statementFingerprint,
          tags: tagRows.map((tagRow) => ({
            type: tagRow.tag_type,
            value: tagRow.tag_value,
            valueNormalized: tagRow.tag_value_normalized,
          })),
        });
      }

      return saved;
    });

    return results;
  }

  listMemoryTagCatalog(): MateMemoryTagCatalogItem[] {
    const rows = this.db.prepare(SELECT_MEMORY_TAG_CATALOG_SQL).all() as TagCatalogRow[];
    const unique = new Map<string, MateMemoryTagCatalogItem>();

    for (const row of rows) {
      const key = `${row.tag_type}\u0000${row.tag_value_normalized}`;
      if (unique.has(key)) {
        continue;
      }
      unique.set(key, {
        id: row.id,
        tagType: row.tag_type,
        tagValue: row.tag_value,
        tagValueNormalized: row.tag_value_normalized,
        description: row.description,
        aliases: row.aliases,
        state: row.state,
        usageCount: row.usage_count,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        disabledAt: row.disabled_at,
      });
    }

    return [...unique.values()];
  }

  deleteMemory(memoryId: string): void {
    if (!memoryId.trim()) {
      return;
    }

    const now = nowIso();
    this.db.prepare(FORGET_MEMORY_SQL).run(now, now, memoryId);
  }

  close(): void {
    this.db.close();
  }
}

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { CREATE_V4_SCHEMA_SQL } from "./database-schema-v4.js";
import { openAppDatabase } from "./sqlite-connection.js";

const MATE_ID = "current";

const SECTION_KEYS = ["core", "bond", "work_style", "notes", "project_digest"] as const;
const CATEGORIES = [
  "persona",
  "voice",
  "preference",
  "relationship",
  "work_style",
  "boundary",
  "project_context",
  "note",
] as const;
const SOURCE_LINK_TYPES = ["created_by", "reinforced_by", "corrected_by", "superseded_by"] as const;

export type MateProfileItemSectionKey = (typeof SECTION_KEYS)[number];
export type MateProfileItemCategory = (typeof CATEGORIES)[number];
type MateProfileItemState = "active" | "disabled" | "forgotten" | "superseded";
type SourceLinkType = (typeof SOURCE_LINK_TYPES)[number];

export type MateProfileItemTagInput = {
  type: string;
  value: string;
};

export type UpsertMateProfileItemInput = {
  id?: string;
  sectionKey: MateProfileItemSectionKey;
  projectDigestId?: string;
  category: MateProfileItemCategory;
  claimKey: string;
  claimValue?: string;
  renderedText: string;
  normalizedClaim?: string;
  confidence: number;
  salienceScore: number;
  recurrenceCount?: number;
  projectionAllowed?: boolean;
  sourceGrowthEventId?: string;
  createdRevisionId?: string;
  updatedRevisionId?: string;
  tags?: MateProfileItemTagInput[];
};

export type MateProfileItemTag = {
  type: string;
  value: string;
  valueNormalized: string;
};

export type MateProfileItem = {
  id: string;
  sectionKey: MateProfileItemSectionKey;
  projectDigestId: string | null;
  category: MateProfileItemCategory;
  claimKey: string;
  claimValue: string;
  claimValueNormalized: string;
  renderedText: string;
  normalizedClaim: string;
  confidence: number;
  salienceScore: number;
  recurrenceCount: number;
  projectionAllowed: boolean;
  state: MateProfileItemState;
  firstSeenAt: string;
  lastSeenAt: string;
  createdRevisionId: string | null;
  updatedRevisionId: string | null;
  disabledRevisionId: string | null;
  forgottenRevisionId: string | null;
  disabledAt: string | null;
  forgottenAt: string | null;
  createdAt: string;
  updatedAt: string;
  tags: MateProfileItemTag[];
};

export type ListProfileItemsRequest = {
  sectionKey?: MateProfileItemSectionKey;
  category?: MateProfileItemCategory;
  state?: MateProfileItemState;
  projectDigestId?: string | null;
};

type ProfileItemRow = {
  id: string;
  section_key: MateProfileItemSectionKey;
  project_digest_id: string | null;
  category: MateProfileItemCategory;
  claim_key: string;
  claim_value: string;
  claim_value_normalized: string;
  rendered_text: string;
  normalized_claim: string;
  confidence: number;
  salience_score: number;
  recurrence_count: number;
  projection_allowed: number;
  state: MateProfileItemState;
  first_seen_at: string;
  last_seen_at: string;
  created_revision_id: string | null;
  updated_revision_id: string | null;
  disabled_revision_id: string | null;
  forgotten_revision_id: string | null;
  disabled_at: string | null;
  forgotten_at: string | null;
  created_at: string;
  updated_at: string;
};

type TagRow = {
  profile_item_id: string;
  tag_type: string;
  tag_value: string;
  tag_value_normalized: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeText(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new Error(`${field} が空です`);
  }
  return text;
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value === "string") {
    const text = value.trim();
    return text.length > 0 ? text : null;
  }
  return null;
}

function normalizeInteger(value: unknown, fallback: number, field: string): number {
  const normalized = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 100) {
    throw new Error(`${field} が 0-100 の整数でないよ。`);
  }
  return normalized;
}

function normalizePositiveInteger(value: unknown, fallback: number, field: string): number {
  const normalized = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  if (!Number.isFinite(normalized) || normalized < 1) {
    return fallback;
  }
  return normalized;
}

function assertOneOf<T extends string>(value: unknown, candidates: readonly T[], field: string): T {
  if (typeof value === "string" && (candidates as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(`${field} が不正です`);
}

function normalizeTags(tags: unknown): MateProfileItemTagInput[] {
  if (!Array.isArray(tags)) {
    return [];
  }

  const unique = new Set<string>();
  const normalized: MateProfileItemTagInput[] = [];

  for (const item of tags) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const rawType = normalizeOptionalText((item as { type?: unknown }).type);
    const rawValue = normalizeOptionalText((item as { value?: unknown }).value);
    if (!rawType || !rawValue) {
      continue;
    }

    const key = `${rawType.toLowerCase()}\u0000${rawValue.toLowerCase()}`;
    if (unique.has(key)) {
      continue;
    }

    unique.add(key);
    normalized.push({
      type: rawType.toLowerCase(),
      value: rawValue,
    });
  }

  return normalized;
}

function mapTagRow(tagRow: TagRow): MateProfileItemTag {
  return {
    type: tagRow.tag_type,
    value: tagRow.tag_value,
    valueNormalized: tagRow.tag_value_normalized,
  };
}

function rowToItem(itemRow: ProfileItemRow, tags: MateProfileItemTag[]): MateProfileItem {
  return {
    id: itemRow.id,
    sectionKey: itemRow.section_key,
    projectDigestId: itemRow.project_digest_id,
    category: itemRow.category,
    claimKey: itemRow.claim_key,
    claimValue: itemRow.claim_value,
    claimValueNormalized: itemRow.claim_value_normalized,
    renderedText: itemRow.rendered_text,
    normalizedClaim: itemRow.normalized_claim,
    confidence: itemRow.confidence,
    salienceScore: itemRow.salience_score,
    recurrenceCount: itemRow.recurrence_count,
    projectionAllowed: itemRow.projection_allowed === 1,
    state: itemRow.state,
    firstSeenAt: itemRow.first_seen_at,
    lastSeenAt: itemRow.last_seen_at,
    createdRevisionId: itemRow.created_revision_id,
    updatedRevisionId: itemRow.updated_revision_id,
    disabledRevisionId: itemRow.disabled_revision_id,
    forgottenRevisionId: itemRow.forgotten_revision_id,
    disabledAt: itemRow.disabled_at,
    forgottenAt: itemRow.forgotten_at,
    createdAt: itemRow.created_at,
    updatedAt: itemRow.updated_at,
    tags,
  };
}

const SELECT_ACTIVE_BY_CLAIM_GLOBAL_SQL = `
  SELECT id
  FROM mate_profile_items
  WHERE mate_id = ?
    AND section_key = ?
    AND claim_key = ?
    AND project_digest_id IS NULL
    AND state = 'active'
  LIMIT 1
`;

const SELECT_ACTIVE_BY_CLAIM_PROJECT_SQL = `
  SELECT id
  FROM mate_profile_items
  WHERE mate_id = ?
    AND section_key = ?
    AND claim_key = ?
    AND project_digest_id = ?
    AND state = 'active'
  LIMIT 1
`;

export class MateProfileItemStorage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    this.initializeSchema();
  }

  private initializeSchema(): void {
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

  upsertProfileItem(input: UpsertMateProfileItemInput): MateProfileItem {
    const sectionKey = assertOneOf(input.sectionKey, SECTION_KEYS, "sectionKey");
    const category = assertOneOf(input.category, CATEGORIES, "category");

    const claimKey = normalizeText(input.claimKey, "claimKey");
    const claimValue = normalizeOptionalText(input.claimValue) ?? "";
    const claimValueNormalized = claimValue.trim().toLowerCase();
    const renderedText = normalizeText(input.renderedText, "renderedText");
    const normalizedClaim =
      normalizeOptionalText(input.normalizedClaim) ?? (claimValueNormalized.length > 0 ? claimValueNormalized : claimKey);
    const confidence = normalizeInteger(input.confidence, Number.NaN, "confidence");
    const salienceScore = normalizeInteger(input.salienceScore, Number.NaN, "salienceScore");
    const recurrenceCount = normalizePositiveInteger(input.recurrenceCount, 1, "recurrenceCount");
    const projectionAllowed = input.projectionAllowed === true;
    const sourceGrowthEventId = normalizeOptionalText(input.sourceGrowthEventId);
    const createdRevisionId = normalizeOptionalText(input.createdRevisionId);
    const updatedRevisionId = normalizeOptionalText(input.updatedRevisionId);
    const id = normalizeOptionalText(input.id);

    const resolvedProjectDigestId = sectionKey === "project_digest"
      ? normalizeOptionalText(input.projectDigestId)
      : null;

    if (sectionKey === "project_digest" && !resolvedProjectDigestId) {
      throw new Error("project_digest セクションでは projectDigestId が必要です");
    }

    const tags = input.tags === undefined ? null : normalizeTags(input.tags);
    const now = nowIso();

    const existingById = id
      ? this.db.prepare("SELECT id FROM mate_profile_items WHERE id = ?").get(id) as { id: string } | undefined
      : undefined;

    const targetByClaim = sectionKey === "project_digest"
      ? this.db
        .prepare(SELECT_ACTIVE_BY_CLAIM_PROJECT_SQL)
        .get(MATE_ID, sectionKey, claimKey, resolvedProjectDigestId) as { id: string } | undefined
      : this.db
        .prepare(SELECT_ACTIVE_BY_CLAIM_GLOBAL_SQL)
        .get(MATE_ID, sectionKey, claimKey) as { id: string } | undefined;

    const targetId = existingById?.id ?? targetByClaim?.id ?? id ?? randomUUID();
    const isInsert = existingById === undefined && targetByClaim === undefined;

    this.withTransaction(() => {
      if (isInsert) {
        this.db.prepare(`
          INSERT INTO mate_profile_items (
            id,
            mate_id,
            section_key,
            project_digest_id,
            category,
            claim_key,
            claim_value,
            claim_value_normalized,
            rendered_text,
            normalized_claim,
            confidence,
            salience_score,
            recurrence_count,
            projection_allowed,
            state,
            first_seen_at,
            last_seen_at,
            created_revision_id,
            updated_revision_id,
            disabled_revision_id,
            forgotten_revision_id,
            disabled_at,
            forgotten_at,
            content_redacted,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, ?, ?)
        `).run(
          targetId,
          MATE_ID,
          sectionKey,
          resolvedProjectDigestId,
          category,
          claimKey,
          claimValue,
          claimValueNormalized,
          renderedText,
          normalizedClaim,
          confidence,
          salienceScore,
          recurrenceCount,
          projectionAllowed ? 1 : 0,
          now,
          now,
          createdRevisionId,
          updatedRevisionId,
          now,
          now,
        );
      } else {
        this.db.prepare(`
          UPDATE mate_profile_items
          SET
            section_key = ?,
            project_digest_id = ?,
            category = ?,
            claim_key = ?,
            claim_value = ?,
            claim_value_normalized = ?,
            rendered_text = ?,
            normalized_claim = ?,
            confidence = ?,
            salience_score = ?,
            recurrence_count = ?,
            projection_allowed = ?,
            state = 'active',
            first_seen_at = first_seen_at,
            last_seen_at = ?,
            created_revision_id = COALESCE(?, created_revision_id),
            updated_revision_id = ?,
            disabled_revision_id = NULL,
            forgotten_revision_id = NULL,
            disabled_at = NULL,
            forgotten_at = NULL,
            updated_at = ?
          WHERE id = ?
        `).run(
          sectionKey,
          resolvedProjectDigestId,
          category,
          claimKey,
          claimValue,
          claimValueNormalized,
          renderedText,
          normalizedClaim,
          confidence,
          salienceScore,
          recurrenceCount,
          projectionAllowed ? 1 : 0,
          now,
          createdRevisionId,
          updatedRevisionId,
          now,
          targetId,
        );
      }

      if (tags !== null) {
        this.db.prepare("DELETE FROM mate_profile_item_tags WHERE profile_item_id = ?").run(targetId);

        const insertTag = this.db.prepare(`
          INSERT INTO mate_profile_item_tags (
            profile_item_id,
            tag_type,
            tag_value,
            tag_value_normalized,
            created_at
          ) VALUES (?, ?, ?, ?, ?)
        `);
        for (const tag of tags) {
          insertTag.run(
            targetId,
            tag.type,
            tag.value,
            tag.value.toLowerCase().trim(),
            now,
          );
        }
      }

      if (sourceGrowthEventId) {
        const linkType: SourceLinkType = isInsert ? "created_by" : "reinforced_by";
        this.db.prepare(`
          INSERT OR IGNORE INTO mate_profile_item_sources (
            profile_item_id,
            growth_event_id,
            link_type,
            created_revision_id,
            created_at
          ) VALUES (?, ?, ?, ?, ?)
        `).run(
          targetId,
          sourceGrowthEventId,
          linkType,
          isInsert ? createdRevisionId : updatedRevisionId,
          now,
        );
      }
    });

    const item = this.getProfileItem(targetId);
    if (!item) {
      throw new Error("保存した profile item を再読込できないよ。");
    }

    return item;
  }

  listProfileItems(request: ListProfileItemsRequest = {}): MateProfileItem[] {
    const clauses: string[] = ["mate_id = ?"];
    const params: Array<string | null> = [MATE_ID];

    if (request.sectionKey !== undefined) {
      const sectionKey = assertOneOf(request.sectionKey, SECTION_KEYS, "sectionKey");
      clauses.push("section_key = ?");
      params.push(sectionKey);
    }

    if (request.category !== undefined) {
      const category = assertOneOf(request.category, CATEGORIES, "category");
      clauses.push("category = ?");
      params.push(category);
    }

    if (request.state !== undefined) {
      const state = assertOneOf(request.state, ["active", "disabled", "forgotten", "superseded"], "state");
      clauses.push("state = ?");
      params.push(state);
    }

    if (request.projectDigestId !== undefined) {
      if (request.projectDigestId === null) {
        clauses.push("project_digest_id IS NULL");
      } else {
        const projectDigestId = normalizeText(request.projectDigestId, "projectDigestId");
        clauses.push("project_digest_id = ?");
        params.push(projectDigestId);
      }
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    const rows = this.db.prepare(`
      SELECT
        id,
        section_key,
        project_digest_id,
        category,
        claim_key,
        claim_value,
        claim_value_normalized,
        rendered_text,
        normalized_claim,
        confidence,
        salience_score,
        recurrence_count,
        projection_allowed,
        state,
        first_seen_at,
        last_seen_at,
        created_revision_id,
        updated_revision_id,
        disabled_revision_id,
        forgotten_revision_id,
        disabled_at,
        forgotten_at,
        created_at,
        updated_at
      FROM mate_profile_items
      ${where}
      ORDER BY updated_at DESC, id DESC
    `).all(...params) as ProfileItemRow[];

    return this.withTags(rows);
  }

  private withTags(rows: ProfileItemRow[]): MateProfileItem[] {
    if (rows.length === 0) {
      return [];
    }

    const ids = rows.map((row) => row.id);
    const tagRows = this.db.prepare(`
      SELECT
        profile_item_id,
        tag_type,
        tag_value,
        tag_value_normalized
      FROM mate_profile_item_tags
      WHERE profile_item_id IN (${ids.map(() => "?").join(", ")})
      ORDER BY id
    `).all(...ids) as TagRow[];

    const tagsByItem = new Map<string, MateProfileItemTag[]>();
    for (const tagRow of tagRows) {
      const existing = tagsByItem.get(tagRow.profile_item_id) ?? [];
      existing.push(mapTagRow(tagRow));
      tagsByItem.set(tagRow.profile_item_id, existing);
    }

    return rows.map((row) => {
      const tags = tagsByItem.get(row.id) ?? [];
      return rowToItem(row, tags);
    });
  }

  private getProfileItem(itemId: string): MateProfileItem | null {
    const row = this.db.prepare(`
      SELECT
        id,
        section_key,
        project_digest_id,
        category,
        claim_key,
        claim_value,
        claim_value_normalized,
        rendered_text,
        normalized_claim,
        confidence,
        salience_score,
        recurrence_count,
        projection_allowed,
        state,
        first_seen_at,
        last_seen_at,
        created_revision_id,
        updated_revision_id,
        disabled_revision_id,
        forgotten_revision_id,
        disabled_at,
        forgotten_at,
        created_at,
        updated_at
      FROM mate_profile_items
      WHERE id = ?
    `).get(itemId) as ProfileItemRow | undefined;

    if (!row) {
      return null;
    }

    const tags = this.db.prepare(`
      SELECT
        profile_item_id,
        tag_type,
        tag_value,
        tag_value_normalized
      FROM mate_profile_item_tags
      WHERE profile_item_id = ?
      ORDER BY id
    `).all(itemId) as TagRow[];

    return rowToItem(row, tags.map(mapTagRow));
  }

  forgetProfileItem(itemId: string, revisionId?: string): void {
    const targetId = normalizeOptionalText(itemId);
    if (!targetId) {
      return;
    }

    const forgottenRevisionId = normalizeOptionalText(revisionId);
    const now = nowIso();

    this.db.prepare(`
      UPDATE mate_profile_items
      SET
        state = 'forgotten',
        forgotten_revision_id = ?,
        forgotten_at = ?,
        disabled_revision_id = NULL,
        disabled_at = NULL,
        updated_at = ?
      WHERE id = ?
    `).run(forgottenRevisionId, now, now, targetId);
  }

  disableProfileItem(itemId: string, revisionId?: string): void {
    const targetId = normalizeOptionalText(itemId);
    if (!targetId) {
      return;
    }

    const disabledRevisionId = normalizeOptionalText(revisionId);
    const now = nowIso();

    this.db.prepare(`
      UPDATE mate_profile_items
      SET
        state = 'disabled',
        disabled_revision_id = ?,
        disabled_at = ?,
        forgotten_revision_id = NULL,
        forgotten_at = NULL,
        updated_at = ?
      WHERE id = ?
    `).run(disabledRevisionId, now, now, targetId);
  }

  close(): void {
    this.db.close();
  }
}

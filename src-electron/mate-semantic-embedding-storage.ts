import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { CREATE_V4_SCHEMA_SQL } from "./database-schema-v4.js";
import { openAppDatabase } from "./sqlite-connection.js";

const MATE_ID = "current";

type OwnerType = "growth_event" | "profile_item" | "tag_catalog";

type EmbeddingRow = {
  id: number;
  owner_type: OwnerType;
  owner_id: string;
  text_hash: string;
  embedding_backend_type: string;
  embedding_model_id: string;
  dimension: number;
  vector_blob: Buffer | Uint8Array;
  created_at: string;
  updated_at: string;
};

export type MateSemanticEmbedding = {
  id: number;
  ownerType: OwnerType;
  ownerId: string;
  textHash: string;
  embeddingBackendType: string;
  embeddingModelId: string;
  dimension: number;
  vector: number[];
  createdAt: string;
  updatedAt: string;
};

export type UpsertMateSemanticEmbeddingInput = {
  ownerType: OwnerType;
  ownerId: string;
  text: string;
  embeddingBackendType: string;
  embeddingModelId: string;
  vector: number[] | Float32Array;
};

export type GetMateSemanticEmbeddingInput = {
  ownerType: OwnerType;
  ownerId: string;
  text: string;
  embeddingBackendType: string;
  embeddingModelId: string;
};

export type ListMateSemanticEmbeddingsForModelRequest = {
  embeddingBackendType: string;
  embeddingModelId: string;
  ownerType?: OwnerType;
  dimension?: number;
  limit?: number;
};

const UPSERT_EMBEDDING_SQL = `
  INSERT INTO mate_semantic_embeddings (
    mate_id,
    owner_type,
    owner_id,
    text_hash,
    embedding_backend_type,
    embedding_model_id,
    dimension,
    vector_blob,
    created_at,
    updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (owner_type, owner_id, embedding_backend_type, embedding_model_id, text_hash)
  DO UPDATE SET
    vector_blob = excluded.vector_blob,
    dimension = excluded.dimension,
    updated_at = excluded.updated_at
`;

const SELECT_EMBEDDING_BY_KEY_SQL = `
  SELECT
    id,
    owner_type,
    owner_id,
    text_hash,
    embedding_backend_type,
    embedding_model_id,
    dimension,
    vector_blob,
    created_at,
    updated_at
  FROM mate_semantic_embeddings
  WHERE owner_type = ?
    AND owner_id = ?
    AND embedding_backend_type = ?
    AND embedding_model_id = ?
    AND text_hash = ?
  LIMIT 1
`;

const SELECT_EMBEDDINGS_FOR_OWNER_SQL = `
  SELECT
    id,
    owner_type,
    owner_id,
    text_hash,
    embedding_backend_type,
    embedding_model_id,
    dimension,
    vector_blob,
    created_at,
    updated_at
  FROM mate_semantic_embeddings
  WHERE owner_type = ?
    AND owner_id = ?
  ORDER BY id ASC
`;

const SELECT_EMBEDDINGS_FOR_MODEL_SQL = `
  SELECT
    id,
    owner_type,
    owner_id,
    text_hash,
    embedding_backend_type,
    embedding_model_id,
    dimension,
    vector_blob,
    created_at,
    updated_at
  FROM mate_semantic_embeddings
  WHERE embedding_backend_type = ?
    AND embedding_model_id = ?
`;

const DELETE_EMBEDDINGS_FOR_OWNER_SQL = `
  DELETE FROM mate_semantic_embeddings
  WHERE owner_type = ?
    AND owner_id = ?
`;

const DELETE_EMBEDDINGS_FOR_MODEL_SQL = `
  DELETE FROM mate_semantic_embeddings
  WHERE embedding_backend_type = ?
    AND embedding_model_id = ?
`;

function nowIso(): string {
  return new Date().toISOString();
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function normalizeOwnerType(value: unknown): OwnerType {
  if (
    value === "growth_event" ||
    value === "profile_item" ||
    value === "tag_catalog"
  ) {
    return value;
  }
  throw new Error("ownerType が不正です。growth_event / profile_item / tag_catalog のいずれかを指定してください。");
}

function normalizeText(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new Error(`${field} が空だよ。`);
  }
  return text;
}

function normalizeVector(input: number[] | Float32Array): { blob: Buffer; dimension: number } {
  const values = input instanceof Float32Array ? input : new Float32Array(input);
  if (values.length === 0) {
    throw new Error("vector が空だよ。");
  }

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!Number.isFinite(value)) {
      throw new Error("vector が有限数のみで構成されている必要があります。");
    }
  }

  const blob = Buffer.alloc(values.length * Float32Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < values.length; index += 1) {
    blob.writeFloatLE(values[index], index * Float32Array.BYTES_PER_ELEMENT);
  }

  return {
    blob,
    dimension: values.length,
  };
}

function normalizePositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} は1以上の整数のみ許可されています。`);
  }

  return value;
}

function readFloat32Vector(blob: Buffer | Uint8Array): number[] {
  const bytes = Buffer.from(blob);
  if (bytes.length % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("vector_blob が不正な長さです。");
  }

  const dimension = bytes.length / Float32Array.BYTES_PER_ELEMENT;
  const vector: number[] = [];
  for (let index = 0; index < dimension; index += 1) {
    vector.push(bytes.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT));
  }
  return vector;
}

function rowToEmbedding(row: EmbeddingRow): MateSemanticEmbedding {
  return {
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    textHash: row.text_hash,
    embeddingBackendType: row.embedding_backend_type,
    embeddingModelId: row.embedding_model_id,
    dimension: row.dimension,
    vector: readFloat32Vector(row.vector_blob),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MateSemanticEmbeddingStorage {
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

  upsertEmbedding(input: UpsertMateSemanticEmbeddingInput): MateSemanticEmbedding {
    const ownerType = normalizeOwnerType(input.ownerType);
    const ownerId = normalizeText(input.ownerId, "ownerId");
    const text = normalizeText(input.text, "text");
    const embeddingBackendType = normalizeText(input.embeddingBackendType, "embeddingBackendType");
    const embeddingModelId = normalizeText(input.embeddingModelId, "embeddingModelId");
    const { blob, dimension } = normalizeVector(input.vector);
    const now = nowIso();
    const textHash = sha256Hex(text);

    this.db.prepare(UPSERT_EMBEDDING_SQL).run(
      MATE_ID,
      ownerType,
      ownerId,
      textHash,
      embeddingBackendType,
      embeddingModelId,
      dimension,
      blob,
      now,
      now,
    );

    const row = this.db.prepare(SELECT_EMBEDDING_BY_KEY_SQL).get(
      ownerType,
      ownerId,
      embeddingBackendType,
      embeddingModelId,
      textHash,
    ) as EmbeddingRow | undefined;

    if (!row) {
      throw new Error("保存した埋め込みを読み直せなかったよ。");
    }

    return rowToEmbedding(row);
  }

  getEmbedding(request: GetMateSemanticEmbeddingInput): MateSemanticEmbedding | null {
    const ownerType = normalizeOwnerType(request.ownerType);
    const ownerId = normalizeText(request.ownerId, "ownerId");
    const text = normalizeText(request.text, "text");
    const embeddingBackendType = normalizeText(request.embeddingBackendType, "embeddingBackendType");
    const embeddingModelId = normalizeText(request.embeddingModelId, "embeddingModelId");
    const textHash = sha256Hex(text);

    const row = this.db.prepare(SELECT_EMBEDDING_BY_KEY_SQL).get(
      ownerType,
      ownerId,
      embeddingBackendType,
      embeddingModelId,
      textHash,
    ) as EmbeddingRow | undefined;

    return row ? rowToEmbedding(row) : null;
  }

  listEmbeddingsForOwner(ownerType: OwnerType, ownerId: string): MateSemanticEmbedding[] {
    const normalizedOwnerType = normalizeOwnerType(ownerType);
    const normalizedOwnerId = normalizeText(ownerId, "ownerId");
    const rows = this.db
      .prepare(SELECT_EMBEDDINGS_FOR_OWNER_SQL)
      .all(normalizedOwnerType, normalizedOwnerId) as EmbeddingRow[];

    return rows.map(rowToEmbedding);
  }

  listEmbeddingsForModel(request: ListMateSemanticEmbeddingsForModelRequest): MateSemanticEmbedding[] {
    const embeddingBackendType = normalizeText(request.embeddingBackendType, "embeddingBackendType");
    const embeddingModelId = normalizeText(request.embeddingModelId, "embeddingModelId");
    const ownerType = request.ownerType === undefined
      ? undefined
      : normalizeOwnerType(request.ownerType);
    const dimension = request.dimension === undefined
      ? undefined
      : normalizePositiveInteger(request.dimension, "dimension");
    const limit = request.limit === undefined
      ? undefined
      : normalizePositiveInteger(request.limit, "limit");

    let sql = SELECT_EMBEDDINGS_FOR_MODEL_SQL;
    const params: Array<string | number> = [embeddingBackendType, embeddingModelId];
    if (ownerType !== undefined) {
      sql += "    AND owner_type = ?\n";
      params.push(ownerType);
    }

    if (dimension !== undefined) {
      sql += "    AND dimension = ?\n";
      params.push(dimension);
    }

    sql += "  ORDER BY updated_at DESC, id DESC\n";

    if (limit !== undefined) {
      sql += "  LIMIT ?\n";
      params.push(limit);
    }

    const rows = this.db.prepare(sql).all(...params) as EmbeddingRow[];
    return rows.map(rowToEmbedding);
  }

  deleteEmbeddingsForOwner(ownerType: OwnerType, ownerId: string): number {
    const normalizedOwnerType = normalizeOwnerType(ownerType);
    const normalizedOwnerId = normalizeText(ownerId, "ownerId");
    const result = this.db.prepare(DELETE_EMBEDDINGS_FOR_OWNER_SQL).run(
      normalizedOwnerType,
      normalizedOwnerId,
    );

    return Number(result.changes);
  }

  deleteEmbeddingsForModel(embeddingBackendType: string, embeddingModelId: string): number {
    const normalizedBackendType = normalizeText(embeddingBackendType, "embeddingBackendType");
    const normalizedModelId = normalizeText(embeddingModelId, "embeddingModelId");
    const result = this.db.prepare(DELETE_EMBEDDINGS_FOR_MODEL_SQL).run(
      normalizedBackendType,
      normalizedModelId,
    );
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}


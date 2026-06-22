import {
  MEMORY_V6_SCHEMA_VERSION,
  type CharacterTargetRef,
  type MemoryAppendRequest,
  type MemoryEntryKind,
  type MemoryForgetReason,
  type MemoryForgetRequest,
  type MemorySearchRequest,
  type MemoryTag,
  type MemoryTargetSelector,
  type MemoryValidationResult,
  type ProjectTargetRef,
} from "./memory-contract.js";

const MEMORY_ENTRY_KINDS = new Set<MemoryEntryKind>([
  "decision",
  "constraint",
  "convention",
  "context",
  "deferred",
  "preference",
  "relationship",
  "boundary",
  "note",
]);

const MEMORY_FORGET_REASONS = new Set<MemoryForgetReason>([
  "user_request",
  "incorrect",
  "outdated",
  "privacy",
  "other",
]);

const SEARCH_REQUEST_KEYS = new Set(["schemaVersion", "targets", "query", "kinds", "tags", "limit", "cursor"]);
const APPEND_REQUEST_KEYS = new Set([
  "schemaVersion",
  "target",
  "kind",
  "title",
  "body",
  "preview",
  "tags",
  "supersedes",
  "sourceMessageId",
  "idempotencyKey",
]);
const FORGET_REQUEST_KEYS = new Set(["schemaVersion", "entryIds", "reason", "sourceMessageId", "idempotencyKey"]);
const PROJECT_TARGET_KEYS = new Set(["type", "id", "path", "alias"]);
const CHARACTER_TARGET_KEYS = new Set(["type", "id"]);
const MEMORY_TAG_KEYS = new Set(["type", "value"]);
const MEMORY_TARGET_KEYS = new Set(["owner", "scope", "project", "character"]);

const MAX_SEARCH_QUERY_LENGTH = 500;
const MAX_TITLE_LENGTH = 160;
const MAX_PREVIEW_LENGTH = 280;
const MAX_BODY_LENGTH = 8_000;
const MAX_TAG_TYPE_LENGTH = 48;
const MAX_TAG_VALUE_LENGTH = 96;
const MAX_ID_LENGTH = 200;
const MAX_CURSOR_LENGTH = 500;
const MAX_LIMIT = 50;
const MAX_TAGS = 20;
const MAX_SUPERSEDES = 20;
const MAX_FORGET_ENTRY_IDS = 50;

function error(code: string, message: string, field?: string): MemoryValidationResult<never> {
  return {
    ok: false,
    error: field ? { code, message, field } : { code, message },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowedKeys: Set<string>, field: string): MemoryValidationResult<void> {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      return error("MEMORY_UNKNOWN_FIELD", `Unknown field: ${field}.${key}`, `${field}.${key}`);
    }
  }

  return { ok: true, value: undefined };
}

function normalizeText(value: unknown, field: string, options: { maxLength: number; required?: boolean }): MemoryValidationResult<string> {
  if (typeof value !== "string") {
    if (options.required === false && value === undefined) {
      return { ok: true, value: "" };
    }
    return error("MEMORY_INVALID_FIELD", `${field} must be a string.`, field);
  }

  if (value.includes("\0")) {
    return error("MEMORY_INVALID_FIELD", `${field} must not contain null bytes.`, field);
  }

  const normalized = value.trim();
  if (options.required !== false && normalized.length === 0) {
    return error("MEMORY_INVALID_FIELD", `${field} must not be empty.`, field);
  }

  if (normalized.length > options.maxLength) {
    return error("MEMORY_FIELD_TOO_LARGE", `${field} is too long.`, field);
  }

  return { ok: true, value: normalized };
}

function normalizeOptionalText(value: unknown, field: string, maxLength = MAX_ID_LENGTH): MemoryValidationResult<string | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  const normalized = normalizeText(value, field, { maxLength });
  if (!normalized.ok) {
    return normalized;
  }

  return { ok: true, value: normalized.value };
}

function validateSchemaVersion(value: Record<string, unknown>): MemoryValidationResult<void> {
  if (value.schemaVersion !== MEMORY_V6_SCHEMA_VERSION) {
    return error("MEMORY_INVALID_SCHEMA_VERSION", "Unsupported memory schemaVersion.", "schemaVersion");
  }

  return { ok: true, value: undefined };
}

function normalizeStringArray(value: unknown, field: string, options: { maxItems: number; maxLength: number }): MemoryValidationResult<string[] | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  if (!Array.isArray(value)) {
    return error("MEMORY_INVALID_FIELD", `${field} must be an array.`, field);
  }

  if (value.length > options.maxItems) {
    return error("MEMORY_FIELD_TOO_LARGE", `${field} has too many items.`, field);
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = normalizeText(value[index], `${field}[${index}]`, { maxLength: options.maxLength });
    if (!item.ok) {
      return item;
    }
    if (seen.has(item.value)) {
      continue;
    }
    seen.add(item.value);
    normalized.push(item.value);
  }

  return { ok: true, value: normalized };
}

function validateMemoryKind(value: unknown, field: string): MemoryValidationResult<MemoryEntryKind> {
  if (typeof value !== "string" || !MEMORY_ENTRY_KINDS.has(value as MemoryEntryKind)) {
    return error("MEMORY_INVALID_FIELD", `${field} must be a valid memory kind.`, field);
  }

  return { ok: true, value: value as MemoryEntryKind };
}

function normalizeProjectTarget(value: unknown, field: string): MemoryValidationResult<ProjectTargetRef> {
  if (!isRecord(value)) {
    return error("MEMORY_INVALID_FIELD", `${field} must be an object.`, field);
  }
  const unknownKeys = rejectUnknownKeys(value, PROJECT_TARGET_KEYS, field);
  if (!unknownKeys.ok) {
    return unknownKeys;
  }

  if (value.type === "id") {
    const id = normalizeText(value.id, `${field}.id`, { maxLength: MAX_ID_LENGTH });
    return id.ok ? { ok: true, value: { type: "id", id: id.value } } : id;
  }
  if (value.type === "path") {
    const projectPath = normalizeText(value.path, `${field}.path`, { maxLength: 1_000 });
    return projectPath.ok ? { ok: true, value: { type: "path", path: projectPath.value } } : projectPath;
  }
  if (value.type === "alias") {
    const alias = normalizeText(value.alias, `${field}.alias`, { maxLength: MAX_ID_LENGTH });
    return alias.ok ? { ok: true, value: { type: "alias", alias: alias.value } } : alias;
  }

  return error("MEMORY_INVALID_FIELD", `${field}.type must be id, path, or alias.`, `${field}.type`);
}

function normalizeCharacterTarget(value: unknown, field: string): MemoryValidationResult<CharacterTargetRef> {
  if (!isRecord(value)) {
    return error("MEMORY_INVALID_FIELD", `${field} must be an object.`, field);
  }
  const unknownKeys = rejectUnknownKeys(value, CHARACTER_TARGET_KEYS, field);
  if (!unknownKeys.ok) {
    return unknownKeys;
  }

  if (value.type === "current") {
    return { ok: true, value: { type: "current" } };
  }
  if (value.type === "id") {
    const id = normalizeText(value.id, `${field}.id`, { maxLength: MAX_ID_LENGTH });
    return id.ok ? { ok: true, value: { type: "id", id: id.value } } : id;
  }

  return error("MEMORY_INVALID_FIELD", `${field}.type must be id or current.`, `${field}.type`);
}

function normalizeMemoryTarget(value: unknown, field: string): MemoryValidationResult<MemoryTargetSelector> {
  if (!isRecord(value)) {
    return error("MEMORY_INVALID_FIELD", `${field} must be an object.`, field);
  }
  const unknownKeys = rejectUnknownKeys(value, MEMORY_TARGET_KEYS, field);
  if (!unknownKeys.ok) {
    return unknownKeys;
  }

  if (value.owner === "project" && value.scope === "project") {
    const project = normalizeProjectTarget(value.project, `${field}.project`);
    return project.ok ? { ok: true, value: { owner: "project", scope: "project", project: project.value } } : project;
  }

  if (value.owner === "character" && value.scope === "character") {
    const character = normalizeCharacterTarget(value.character, `${field}.character`);
    return character.ok ? { ok: true, value: { owner: "character", scope: "character", character: character.value } } : character;
  }

  if (value.owner === "character" && value.scope === "project") {
    const character = normalizeCharacterTarget(value.character, `${field}.character`);
    if (!character.ok) {
      return character;
    }
    const project = normalizeProjectTarget(value.project, `${field}.project`);
    return project.ok
      ? { ok: true, value: { owner: "character", scope: "project", character: character.value, project: project.value } }
      : project;
  }

  return error("MEMORY_INVALID_TARGET", "Unsupported memory owner / scope combination.", field);
}

function normalizeTargets(value: unknown): MemoryValidationResult<MemoryTargetSelector[]> {
  if (!Array.isArray(value) || value.length === 0) {
    return error("MEMORY_TARGET_REQUIRED", "At least one memory target is required.", "targets");
  }

  const normalized: MemoryTargetSelector[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const target = normalizeMemoryTarget(value[index], `targets[${index}]`);
    if (!target.ok) {
      return target;
    }
    normalized.push(target.value);
  }

  return { ok: true, value: normalized };
}

function normalizeTags(value: unknown, field = "tags"): MemoryValidationResult<MemoryTag[]> {
  if (value === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value)) {
    return error("MEMORY_INVALID_FIELD", `${field} must be an array.`, field);
  }
  if (value.length > MAX_TAGS) {
    return error("MEMORY_FIELD_TOO_LARGE", `${field} has too many items.`, field);
  }

  const normalized: MemoryTag[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const tag = value[index];
    if (!isRecord(tag)) {
      return error("MEMORY_INVALID_FIELD", `${field}[${index}] must be an object.`, `${field}[${index}]`);
    }
    const unknownKeys = rejectUnknownKeys(tag, MEMORY_TAG_KEYS, `${field}[${index}]`);
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const type = normalizeText(tag.type, `${field}[${index}].type`, { maxLength: MAX_TAG_TYPE_LENGTH });
    if (!type.ok) {
      return type;
    }
    const tagValue = normalizeText(tag.value, `${field}[${index}].value`, { maxLength: MAX_TAG_VALUE_LENGTH });
    if (!tagValue.ok) {
      return tagValue;
    }
    const key = `${type.value.toLowerCase()}\0${tagValue.value.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({ type: type.value, value: tagValue.value });
  }

  return { ok: true, value: normalized };
}

function normalizeKinds(value: unknown): MemoryValidationResult<MemoryEntryKind[] | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(value)) {
    return error("MEMORY_INVALID_FIELD", "kinds must be an array.", "kinds");
  }

  const normalized: MemoryEntryKind[] = [];
  const seen = new Set<MemoryEntryKind>();
  for (let index = 0; index < value.length; index += 1) {
    const kind = validateMemoryKind(value[index], `kinds[${index}]`);
    if (!kind.ok) {
      return kind;
    }
    if (seen.has(kind.value)) {
      continue;
    }
    seen.add(kind.value);
    normalized.push(kind.value);
  }

  return { ok: true, value: normalized };
}

export function validateMemorySearchRequest(value: unknown): MemoryValidationResult<MemorySearchRequest> {
  if (!isRecord(value)) {
    return error("MEMORY_INVALID_REQUEST", "Search request must be an object.");
  }
  const unknownKeys = rejectUnknownKeys(value, SEARCH_REQUEST_KEYS, "request");
  if (!unknownKeys.ok) {
    return unknownKeys;
  }
  const schema = validateSchemaVersion(value);
  if (!schema.ok) {
    return schema;
  }
  const targets = normalizeTargets(value.targets);
  if (!targets.ok) {
    return targets;
  }
  const query = normalizeText(value.query, "query", { maxLength: MAX_SEARCH_QUERY_LENGTH });
  if (!query.ok) {
    return query;
  }
  const kinds = normalizeKinds(value.kinds);
  if (!kinds.ok) {
    return kinds;
  }
  const tags = normalizeTags(value.tags);
  if (!tags.ok) {
    return tags;
  }
  const cursor = normalizeOptionalText(value.cursor, "cursor", MAX_CURSOR_LENGTH);
  if (!cursor.ok) {
    return cursor;
  }

  let limit: number | undefined;
  if (value.limit !== undefined) {
    if (typeof value.limit !== "number" || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > MAX_LIMIT) {
      return error("MEMORY_INVALID_FIELD", `limit must be an integer from 1 to ${MAX_LIMIT}.`, "limit");
    }
    limit = value.limit;
  }

  return {
    ok: true,
    value: {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: targets.value,
      query: query.value,
      ...(kinds.value ? { kinds: kinds.value } : {}),
      ...(tags.value.length > 0 ? { tags: tags.value } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(cursor.value !== undefined ? { cursor: cursor.value } : {}),
    },
  };
}

export function validateMemoryAppendRequest(value: unknown): MemoryValidationResult<MemoryAppendRequest> {
  if (!isRecord(value)) {
    return error("MEMORY_INVALID_REQUEST", "Append request must be an object.");
  }
  const unknownKeys = rejectUnknownKeys(value, APPEND_REQUEST_KEYS, "request");
  if (!unknownKeys.ok) {
    return unknownKeys;
  }
  const schema = validateSchemaVersion(value);
  if (!schema.ok) {
    return schema;
  }
  const target = normalizeMemoryTarget(value.target, "target");
  if (!target.ok) {
    return target;
  }
  const kind = validateMemoryKind(value.kind, "kind");
  if (!kind.ok) {
    return kind;
  }
  const title = normalizeText(value.title, "title", { maxLength: MAX_TITLE_LENGTH });
  if (!title.ok) {
    return title;
  }
  const body = normalizeText(value.body, "body", { maxLength: MAX_BODY_LENGTH });
  if (!body.ok) {
    return body;
  }
  const preview = normalizeText(value.preview, "preview", { maxLength: MAX_PREVIEW_LENGTH });
  if (!preview.ok) {
    return preview;
  }
  const tags = normalizeTags(value.tags);
  if (!tags.ok) {
    return tags;
  }
  const supersedes = normalizeStringArray(value.supersedes, "supersedes", { maxItems: MAX_SUPERSEDES, maxLength: MAX_ID_LENGTH });
  if (!supersedes.ok) {
    return supersedes;
  }
  const sourceMessageId = normalizeOptionalText(value.sourceMessageId, "sourceMessageId");
  if (!sourceMessageId.ok) {
    return sourceMessageId;
  }
  const idempotencyKey = normalizeOptionalText(value.idempotencyKey, "idempotencyKey");
  if (!idempotencyKey.ok) {
    return idempotencyKey;
  }

  return {
    ok: true,
    value: {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: target.value,
      kind: kind.value,
      title: title.value,
      body: body.value,
      preview: preview.value,
      tags: tags.value,
      ...(supersedes.value && supersedes.value.length > 0 ? { supersedes: supersedes.value } : {}),
      ...(sourceMessageId.value !== undefined ? { sourceMessageId: sourceMessageId.value } : {}),
      ...(idempotencyKey.value !== undefined ? { idempotencyKey: idempotencyKey.value } : {}),
    },
  };
}

export function validateMemoryForgetRequest(value: unknown): MemoryValidationResult<MemoryForgetRequest> {
  if (!isRecord(value)) {
    return error("MEMORY_INVALID_REQUEST", "Forget request must be an object.");
  }
  const unknownKeys = rejectUnknownKeys(value, FORGET_REQUEST_KEYS, "request");
  if (!unknownKeys.ok) {
    return unknownKeys;
  }
  const schema = validateSchemaVersion(value);
  if (!schema.ok) {
    return schema;
  }
  const entryIds = normalizeStringArray(value.entryIds, "entryIds", { maxItems: MAX_FORGET_ENTRY_IDS, maxLength: MAX_ID_LENGTH });
  if (!entryIds.ok) {
    return entryIds;
  }
  if (!entryIds.value || entryIds.value.length === 0) {
    return error("MEMORY_INVALID_FIELD", "entryIds must not be empty.", "entryIds");
  }
  if (value.reason !== undefined && (typeof value.reason !== "string" || !MEMORY_FORGET_REASONS.has(value.reason as MemoryForgetReason))) {
    return error("MEMORY_INVALID_FIELD", "reason must be a valid forget reason.", "reason");
  }
  const sourceMessageId = normalizeOptionalText(value.sourceMessageId, "sourceMessageId");
  if (!sourceMessageId.ok) {
    return sourceMessageId;
  }
  const idempotencyKey = normalizeOptionalText(value.idempotencyKey, "idempotencyKey");
  if (!idempotencyKey.ok) {
    return idempotencyKey;
  }

  return {
    ok: true,
    value: {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      entryIds: entryIds.value,
      ...(value.reason !== undefined ? { reason: value.reason as MemoryForgetReason } : {}),
      ...(sourceMessageId.value !== undefined ? { sourceMessageId: sourceMessageId.value } : {}),
      ...(idempotencyKey.value !== undefined ? { idempotencyKey: idempotencyKey.value } : {}),
    },
  };
}

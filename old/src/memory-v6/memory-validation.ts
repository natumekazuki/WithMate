import {
  MEMORY_APPEND_FILE_ROLES,
  MEMORY_ENTRY_KINDS,
  MEMORY_FORGET_REASONS,
  MEMORY_V6_SCHEMA_VERSION,
  type CharacterTargetRef,
  type MemoryExportFilesRequest,
  type MemoryAppendFileInput,
  type MemoryAppendFileRole,
  type MemoryAppendRequest,
  type MemoryEntryKind,
  type MemoryForgetReason,
  type MemoryForgetRequest,
  type MemoryGetEntryRequest,
  type MemoryGetFileRequest,
  type MemoryListTagsRequest,
  type MemorySearchRequest,
  type MemoryTargetSelector,
  type MemoryValidationResult,
  type NormalizedMemoryTag,
  type ProjectTargetRef,
} from "./memory-contract.js";

const MEMORY_ENTRY_KIND_SET = new Set<MemoryEntryKind>(MEMORY_ENTRY_KINDS);
const MEMORY_APPEND_FILE_ROLE_SET = new Set<MemoryAppendFileRole>(MEMORY_APPEND_FILE_ROLES);
const MEMORY_FORGET_REASON_SET = new Set<MemoryForgetReason>(MEMORY_FORGET_REASONS);

const SEARCH_REQUEST_KEYS = new Set(["schemaVersion", "targets", "query", "kinds", "tags", "limit", "cursor"]);
const GET_ENTRY_REQUEST_KEYS = new Set(["schemaVersion", "entryId", "target"]);
const GET_FILE_REQUEST_KEYS = new Set(["schemaVersion", "target", "objectId", "outputPath"]);
const EXPORT_FILES_REQUEST_KEYS = new Set(["schemaVersion", "target", "entryId", "outputDirectoryPath"]);
const LIST_TAGS_REQUEST_KEYS = new Set(["schemaVersion", "targets"]);
const APPEND_REQUEST_KEYS = new Set([
  "schemaVersion",
  "target",
  "kind",
  "title",
  "body",
  "preview",
  "tags",
  "supersedes",
  "files",
  "sourceMessageId",
  "idempotencyKey",
]);
const FORGET_REQUEST_KEYS = new Set(["schemaVersion", "target", "entryIds", "reason", "sourceMessageId", "idempotencyKey"]);
const PROJECT_TARGET_ID_KEYS = new Set(["type", "id"]);
const PROJECT_TARGET_PATH_KEYS = new Set(["type", "path"]);
const CHARACTER_TARGET_ID_KEYS = new Set(["type", "id"]);
const MEMORY_TAG_KEYS = new Set(["type", "value"]);
const APPEND_FILE_KEYS = new Set(["path", "summary", "role", "displayName", "contentType"]);
const PROJECT_PROJECT_TARGET_KEYS = new Set(["owner", "scope", "project"]);
const CHARACTER_CHARACTER_TARGET_KEYS = new Set(["owner", "scope", "character"]);
const CHARACTER_PROJECT_TARGET_KEYS = new Set(["owner", "scope", "character", "project"]);
const USER_GLOBAL_TARGET_KEYS = new Set(["owner", "scope"]);

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
const MAX_APPEND_FILES = 10;
const MAX_FILE_PATH_LENGTH = 1_000;
const MAX_OBJECT_ID_LENGTH = 64;
const MAX_FILE_SUMMARY_LENGTH = 500;
const MAX_FILE_DISPLAY_NAME_LENGTH = 255;
const MAX_FILE_CONTENT_TYPE_LENGTH = 120;
const MAX_FORGET_ENTRY_IDS = 50;
const MAX_TARGETS = 5;

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

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }

  return false;
}

export function canonicalizeMemoryTagPart(value: string): string {
  return value.normalize("NFC").toLowerCase();
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
  if (hasUnpairedSurrogate(value)) {
    return error("MEMORY_INVALID_FIELD", `${field} must be well-formed Unicode.`, field);
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

function normalizeAbsolutePath(value: unknown, field: string): MemoryValidationResult<string> {
  const normalized = normalizeText(value, field, { maxLength: MAX_FILE_PATH_LENGTH });
  if (!normalized.ok) {
    return normalized;
  }
  if (!isAbsolutePathLike(normalized.value)) {
    return error("MEMORY_INVALID_FIELD", `${field} must be an absolute path.`, field);
  }
  return normalized;
}

function isAbsolutePathLike(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
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
  if (typeof value !== "string" || !MEMORY_ENTRY_KIND_SET.has(value as MemoryEntryKind)) {
    return error("MEMORY_INVALID_FIELD", `${field} must be a valid memory kind.`, field);
  }

  return { ok: true, value: value as MemoryEntryKind };
}

function validateAppendFileRole(value: unknown, field: string): MemoryValidationResult<MemoryAppendFileRole | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "string" || !MEMORY_APPEND_FILE_ROLE_SET.has(value as MemoryAppendFileRole)) {
    return error("MEMORY_INVALID_FIELD", `${field} must be a valid file role.`, field);
  }

  return { ok: true, value: value as MemoryAppendFileRole };
}

function normalizeAppendFiles(value: unknown): MemoryValidationResult<MemoryAppendFileInput[] | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(value)) {
    return error("MEMORY_INVALID_FIELD", "files must be an array.", "files");
  }
  if (value.length === 0) {
    return { ok: true, value: undefined };
  }
  if (value.length > MAX_APPEND_FILES) {
    return error("MEMORY_FIELD_TOO_LARGE", `files supports at most ${MAX_APPEND_FILES} items.`, "files");
  }

  const normalized: MemoryAppendFileInput[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const file = value[index];
    const field = `files[${index}]`;
    if (!isRecord(file)) {
      return error("MEMORY_INVALID_FIELD", `${field} must be an object.`, field);
    }
    const unknownKeys = rejectUnknownKeys(file, APPEND_FILE_KEYS, field);
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const filePath = normalizeAbsolutePath(file.path, `${field}.path`);
    if (!filePath.ok) {
      return filePath;
    }
    const summary = normalizeText(file.summary, `${field}.summary`, { maxLength: MAX_FILE_SUMMARY_LENGTH });
    if (!summary.ok) {
      return summary;
    }
    const role = validateAppendFileRole(file.role, `${field}.role`);
    if (!role.ok) {
      return role;
    }
    const displayName = normalizeOptionalText(file.displayName, `${field}.displayName`, MAX_FILE_DISPLAY_NAME_LENGTH);
    if (!displayName.ok) {
      return displayName;
    }
    const contentType = normalizeOptionalText(file.contentType, `${field}.contentType`, MAX_FILE_CONTENT_TYPE_LENGTH);
    if (!contentType.ok) {
      return contentType;
    }

    normalized.push({
      path: filePath.value,
      summary: summary.value,
      ...(role.value !== undefined ? { role: role.value } : {}),
      ...(displayName.value !== undefined ? { displayName: displayName.value } : {}),
      ...(contentType.value !== undefined ? { contentType: contentType.value } : {}),
    });
  }

  return { ok: true, value: normalized };
}

function normalizeProjectTarget(value: unknown, field: string): MemoryValidationResult<ProjectTargetRef> {
  if (!isRecord(value)) {
    return error("MEMORY_INVALID_FIELD", `${field} must be an object.`, field);
  }

  if (value.type === "id") {
    const unknownKeys = rejectUnknownKeys(value, PROJECT_TARGET_ID_KEYS, field);
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const id = normalizeText(value.id, `${field}.id`, { maxLength: MAX_ID_LENGTH });
    return id.ok ? { ok: true, value: { type: "id", id: id.value } } : id;
  }
  if (value.type === "path") {
    const unknownKeys = rejectUnknownKeys(value, PROJECT_TARGET_PATH_KEYS, field);
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const projectPath = normalizeText(value.path, `${field}.path`, { maxLength: 1_000 });
    return projectPath.ok ? { ok: true, value: { type: "path", path: projectPath.value } } : projectPath;
  }
  return error("MEMORY_INVALID_FIELD", `${field}.type must be id or path.`, `${field}.type`);
}

function normalizeCharacterTarget(value: unknown, field: string): MemoryValidationResult<CharacterTargetRef> {
  if (!isRecord(value)) {
    return error("MEMORY_INVALID_FIELD", `${field} must be an object.`, field);
  }

  if (value.type === "id") {
    const unknownKeys = rejectUnknownKeys(value, CHARACTER_TARGET_ID_KEYS, field);
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const id = normalizeText(value.id, `${field}.id`, { maxLength: MAX_ID_LENGTH });
    return id.ok ? { ok: true, value: { type: "id", id: id.value } } : id;
  }

  return error("MEMORY_INVALID_FIELD", `${field}.type must be id.`, `${field}.type`);
}

function normalizeMemoryTarget(value: unknown, field: string): MemoryValidationResult<MemoryTargetSelector> {
  if (!isRecord(value)) {
    return error("MEMORY_INVALID_FIELD", `${field} must be an object.`, field);
  }

  if (value.owner === "user" && value.scope === "global") {
    const unknownKeys = rejectUnknownKeys(value, USER_GLOBAL_TARGET_KEYS, field);
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    return { ok: true, value: { owner: "user", scope: "global" } };
  }

  if (value.owner === "project" && value.scope === "project") {
    const unknownKeys = rejectUnknownKeys(value, PROJECT_PROJECT_TARGET_KEYS, field);
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const project = normalizeProjectTarget(value.project, `${field}.project`);
    return project.ok ? { ok: true, value: { owner: "project", scope: "project", project: project.value } } : project;
  }

  if (value.owner === "character" && value.scope === "character") {
    const unknownKeys = rejectUnknownKeys(value, CHARACTER_CHARACTER_TARGET_KEYS, field);
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const character = normalizeCharacterTarget(value.character, `${field}.character`);
    return character.ok ? { ok: true, value: { owner: "character", scope: "character", character: character.value } } : character;
  }

  if (value.owner === "character" && value.scope === "project") {
    const unknownKeys = rejectUnknownKeys(value, CHARACTER_PROJECT_TARGET_KEYS, field);
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
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
  if (value.length > MAX_TARGETS) {
    return error("MEMORY_FIELD_TOO_LARGE", `targets supports at most ${MAX_TARGETS} items.`, "targets");
  }

  const normalized: MemoryTargetSelector[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const target = normalizeMemoryTarget(value[index], `targets[${index}]`);
    if (!target.ok) {
      return target;
    }
    const key = JSON.stringify(target.value);
    if (seen.has(key)) {
      return error("MEMORY_DUPLICATE_TARGET", "targets must not contain duplicates.", `targets[${index}]`);
    }
    seen.add(key);
    normalized.push(target.value);
  }

  return { ok: true, value: normalized };
}

function normalizeTags(value: unknown, field = "tags", options: { required?: boolean } = {}): MemoryValidationResult<NormalizedMemoryTag[]> {
  if (value === undefined) {
    if (options.required) {
      return error("MEMORY_INVALID_FIELD", `${field} is required.`, field);
    }
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value)) {
    return error("MEMORY_INVALID_FIELD", `${field} must be an array.`, field);
  }
  if (value.length > MAX_TAGS) {
    return error("MEMORY_FIELD_TOO_LARGE", `${field} has too many items.`, field);
  }

  const normalized: NormalizedMemoryTag[] = [];
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
    const canonicalType = canonicalizeMemoryTagPart(type.value);
    const canonicalValue = canonicalizeMemoryTagPart(tagValue.value);
    const key = `${canonicalType}\0${canonicalValue}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({ type: type.value, value: tagValue.value, canonicalType, canonicalValue });
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
  if (value.length > MEMORY_ENTRY_KINDS.length) {
    return error("MEMORY_FIELD_TOO_LARGE", "kinds has too many items.", "kinds");
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

  return { ok: true, value: normalized.length > 0 ? normalized : undefined };
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

export function validateMemoryGetEntryRequest(value: unknown): MemoryValidationResult<MemoryGetEntryRequest> {
  if (!isRecord(value)) {
    return error("MEMORY_INVALID_REQUEST", "Get entry request must be an object.");
  }
  const unknownKeys = rejectUnknownKeys(value, GET_ENTRY_REQUEST_KEYS, "request");
  if (!unknownKeys.ok) {
    return unknownKeys;
  }
  const schema = validateSchemaVersion(value);
  if (!schema.ok) {
    return schema;
  }
  const entryId = normalizeText(value.entryId, "entryId", { maxLength: MAX_ID_LENGTH });
  if (!entryId.ok) {
    return entryId;
  }
  const target = normalizeMemoryTarget(value.target, "target");
  if (!target.ok) {
    return target;
  }

  return {
    ok: true,
    value: {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      entryId: entryId.value,
      target: target.value,
    },
  };
}

export function validateMemoryGetFileRequest(value: unknown): MemoryValidationResult<MemoryGetFileRequest> {
  if (!isRecord(value)) {
    return error("MEMORY_INVALID_REQUEST", "Get file request must be an object.");
  }
  const unknownKeys = rejectUnknownKeys(value, GET_FILE_REQUEST_KEYS, "request");
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
  const objectId = normalizeText(value.objectId, "objectId", { maxLength: MAX_OBJECT_ID_LENGTH });
  if (!objectId.ok) {
    return objectId;
  }
  const outputPath = normalizeAbsolutePath(value.outputPath, "outputPath");
  if (!outputPath.ok) {
    return outputPath;
  }

  return {
    ok: true,
    value: {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: target.value,
      objectId: objectId.value,
      outputPath: outputPath.value,
    },
  };
}

export function validateMemoryExportFilesRequest(value: unknown): MemoryValidationResult<MemoryExportFilesRequest> {
  if (!isRecord(value)) {
    return error("MEMORY_INVALID_REQUEST", "Export files request must be an object.");
  }
  const unknownKeys = rejectUnknownKeys(value, EXPORT_FILES_REQUEST_KEYS, "request");
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
  const entryId = normalizeText(value.entryId, "entryId", { maxLength: MAX_ID_LENGTH });
  if (!entryId.ok) {
    return entryId;
  }
  const outputDirectoryPath = normalizeAbsolutePath(value.outputDirectoryPath, "outputDirectoryPath");
  if (!outputDirectoryPath.ok) {
    return outputDirectoryPath;
  }

  return {
    ok: true,
    value: {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: target.value,
      entryId: entryId.value,
      outputDirectoryPath: outputDirectoryPath.value,
    },
  };
}

export function validateMemoryListTagsRequest(value: unknown): MemoryValidationResult<MemoryListTagsRequest> {
  if (!isRecord(value)) {
    return error("MEMORY_INVALID_REQUEST", "List tags request must be an object.");
  }
  const unknownKeys = rejectUnknownKeys(value, LIST_TAGS_REQUEST_KEYS, "request");
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

  return {
    ok: true,
    value: {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: targets.value,
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
  const tags = normalizeTags(value.tags, "tags", { required: true });
  if (!tags.ok) {
    return tags;
  }
  const supersedes = normalizeStringArray(value.supersedes, "supersedes", { maxItems: MAX_SUPERSEDES, maxLength: MAX_ID_LENGTH });
  if (!supersedes.ok) {
    return supersedes;
  }
  const files = normalizeAppendFiles(value.files);
  if (!files.ok) {
    return files;
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
      ...(files.value && files.value.length > 0 ? { files: files.value } : {}),
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
  const target = normalizeMemoryTarget(value.target, "target");
  if (!target.ok) {
    return target;
  }
  const entryIds = normalizeStringArray(value.entryIds, "entryIds", { maxItems: MAX_FORGET_ENTRY_IDS, maxLength: MAX_ID_LENGTH });
  if (!entryIds.ok) {
    return entryIds;
  }
  if (!entryIds.value || entryIds.value.length === 0) {
    return error("MEMORY_INVALID_FIELD", "entryIds must not be empty.", "entryIds");
  }
  if (value.reason !== undefined && (typeof value.reason !== "string" || !MEMORY_FORGET_REASON_SET.has(value.reason as MemoryForgetReason))) {
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
      target: target.value,
      entryIds: entryIds.value,
      ...(value.reason !== undefined ? { reason: value.reason as MemoryForgetReason } : {}),
      ...(sourceMessageId.value !== undefined ? { sourceMessageId: sourceMessageId.value } : {}),
      ...(idempotencyKey.value !== undefined ? { idempotencyKey: idempotencyKey.value } : {}),
    },
  };
}

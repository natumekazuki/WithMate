import {
  MEMORY_APPEND_FILE_ROLES,
  MEMORY_ENTRY_KINDS,
  MEMORY_FORGET_REASONS,
  MEMORY_RESULT_LIMIT_MAX,
  MEMORY_V6_SCHEMA_VERSION,
  type CharacterTargetRef,
  type MemoryExportFilesRequest,
  type MemoryAppendFileInput,
  type MemoryAppendFileRole,
  type MemoryAppendRequest,
  type MemoryAppendEntriesRequest,
  type MemoryEntryKind,
  type MemoryEntryContent,
  type MemoryForgetReason,
  type MemoryForgetRequest,
  type MemoryAuditRequest,
  type MemoryGetEntryRequest,
  type MemoryGetFileRequest,
  type MemoryListEntriesRequest,
  type MemoryListTagsRequest,
  type MemoryListTargetsRequest,
  type MemoryMoveEntryRequest,
  type MemorySearchRequest,
  type MemoryTargetSelector,
  type MemoryValidationResult,
  type NormalizedMemoryTag,
  type ProjectTargetRef,
} from "./memory-contract.js";

const MEMORY_ENTRY_KIND_SET = new Set<MemoryEntryKind>(MEMORY_ENTRY_KINDS);
const MEMORY_APPEND_FILE_ROLE_SET = new Set<MemoryAppendFileRole>(
  MEMORY_APPEND_FILE_ROLES,
);
const MEMORY_FORGET_REASON_SET = new Set<MemoryForgetReason>(
  MEMORY_FORGET_REASONS,
);

const SEARCH_REQUEST_KEYS = new Set([
  "schemaVersion",
  "targets",
  "query",
  "kinds",
  "tags",
  "limit",
  "cursor",
]);
const GET_ENTRY_REQUEST_KEYS = new Set(["schemaVersion", "entryId", "target"]);
const GET_FILE_REQUEST_KEYS = new Set([
  "schemaVersion",
  "target",
  "objectId",
  "outputPath",
]);
const EXPORT_FILES_REQUEST_KEYS = new Set([
  "schemaVersion",
  "target",
  "entryId",
  "outputDirectoryPath",
]);
const LIST_TARGETS_REQUEST_KEYS = new Set([
  "schemaVersion",
  "owner",
  "scope",
  "project",
  "character",
  "includeEmpty",
  "limit",
  "cursor",
]);
const LIST_ENTRIES_REQUEST_KEYS = new Set([
  "schemaVersion",
  "target",
  "states",
  "kinds",
  "tags",
  "includeBody",
  "limit",
  "cursor",
]);
const AUDIT_REQUEST_KEYS = new Set([
  "schemaVersion",
  "allTargets",
  "targets",
  "staleBefore",
  "limit",
  "cursor",
]);
const LIST_TAGS_REQUEST_KEYS = new Set([
  "schemaVersion",
  "targets",
  "withCounts",
  "sampleLimit",
  "limit",
  "cursor",
]);
const APPEND_REQUEST_KEYS = new Set([
  "schemaVersion",
  "target",
  "kind",
  "title",
  "body",
  "preview",
  "tags",
  "supersedes",
  "mutationReason",
  "files",
  "sourceMessageId",
  "idempotencyKey",
]);
const FORGET_REQUEST_KEYS = new Set([
  "schemaVersion",
  "target",
  "entryIds",
  "reason",
  "sourceMessageId",
  "idempotencyKey",
  "dryRun",
]);
const APPEND_ENTRY_KEYS = new Set(
  [...APPEND_REQUEST_KEYS].filter(
    (key) => key !== "schemaVersion" && key !== "target",
  ),
);
const APPEND_ENTRIES_REQUEST_KEYS = new Set([
  "schemaVersion",
  "target",
  "entries",
]);
const MOVE_ENTRY_REQUEST_KEYS = new Set([
  "schemaVersion",
  "entryId",
  "from",
  "to",
  "reason",
  "sourceMessageId",
  "idempotencyKey",
]);
const PROJECT_TARGET_ID_KEYS = new Set(["type", "id"]);
const PROJECT_TARGET_PATH_KEYS = new Set(["type", "path"]);
const CHARACTER_TARGET_ID_KEYS = new Set(["type", "id"]);
const MEMORY_TAG_KEYS = new Set(["type", "value"]);
const APPEND_FILE_KEYS = new Set([
  "path",
  "summary",
  "role",
  "displayName",
  "contentType",
]);
const PROJECT_PROJECT_TARGET_KEYS = new Set(["owner", "scope", "project"]);
const CHARACTER_CHARACTER_TARGET_KEYS = new Set([
  "owner",
  "scope",
  "character",
]);
const CHARACTER_PROJECT_TARGET_KEYS = new Set([
  "owner",
  "scope",
  "character",
  "project",
]);
const USER_GLOBAL_TARGET_KEYS = new Set(["owner", "scope"]);

const MAX_SEARCH_QUERY_LENGTH = 500;
const MAX_TITLE_LENGTH = 160;
const MAX_PREVIEW_LENGTH = 280;
const MAX_BODY_LENGTH = 8_000;
const MAX_REASON_LENGTH = 1_000;
const MAX_TAG_TYPE_LENGTH = 48;
const MAX_TAG_VALUE_LENGTH = 96;
const MAX_ID_LENGTH = 200;
const MAX_CURSOR_LENGTH = 500;
const MAX_MAINTENANCE_LIMIT = 200;
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
const MEMORY_ENTRY_STATES = new Set([
  "active",
  "superseded",
  "forgotten",
] as const);

/** タグ一覧の再開位置。利用件数、最終更新時刻、タグ種別と値の正規形で直前の項目を示す。 */
export type MemoryListTagsCursor = {
  usageCount: number;
  latestUpdatedAt: string;
  canonicalType: string;
  canonicalValue: string;
};

/** タグ一覧の再開位置を版付き文字列に変換し、区切りと混同しないよう文字列フィールドを URI エンコードする。 */
export function encodeMemoryListTagsCursor(
  cursor: MemoryListTagsCursor,
): string {
  return [
    "tag-v1",
    String(cursor.usageCount),
    encodeURIComponent(cursor.latestUpdatedAt),
    encodeURIComponent(cursor.canonicalType),
    encodeURIComponent(cursor.canonicalValue),
  ].join(":");
}

/** タグ一覧のカーソルを復元する。版・日時・タグ・再エンコード結果が正規形式に合わなければ null を返す。 */
export function decodeMemoryListTagsCursor(
  value: string,
): MemoryListTagsCursor | null {
  const parts = value.split(":");
  if (
    parts.length !== 5 ||
    parts[0] !== "tag-v1" ||
    !/^\d+$/.test(parts[1] ?? "")
  ) {
    return null;
  }
  try {
    const usageCount = Number(parts[1]);
    const latestUpdatedAt = decodeURIComponent(parts[2] ?? "");
    const canonicalType = decodeURIComponent(parts[3] ?? "");
    const canonicalValue = decodeURIComponent(parts[4] ?? "");
    const normalizedType = normalizeText(canonicalType, "cursor.tagType", {
      maxLength: MAX_TAG_TYPE_LENGTH,
    });
    const normalizedValue = normalizeText(canonicalValue, "cursor.tagValue", {
      maxLength: MAX_TAG_VALUE_LENGTH,
    });
    if (
      !Number.isSafeInteger(usageCount) ||
      usageCount <= 0 ||
      !latestUpdatedAt ||
      !normalizedType.ok ||
      normalizedType.value !== canonicalType ||
      !normalizedValue.ok ||
      normalizedValue.value !== canonicalValue ||
      new Date(latestUpdatedAt).toISOString() !== latestUpdatedAt ||
      canonicalizeMemoryTagPart(canonicalType) !== canonicalType ||
      canonicalizeMemoryTagPart(canonicalValue) !== canonicalValue
    ) {
      return null;
    }
    const cursor = {
      usageCount,
      latestUpdatedAt,
      canonicalType,
      canonicalValue,
    };
    return encodeMemoryListTagsCursor(cursor) === value ? cursor : null;
  } catch {
    return null;
  }
}

/** 入力検証時のエラーを組み立てる。まだ保存していないため効果は常に none とする。 */
function error(
  code: string,
  message: string,
  field?: string,
): MemoryValidationResult<never> {
  return {
    ok: false,
    error: field
      ? { code, message, field, effect: "none" }
      : { code, message, effect: "none" },
  };
}

/** null と配列を除外し、名前付きフィールドを持つ形式として検証できる入力に絞る。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 許可リストにない最初のキーを検出し、外側の項目名も含むフィールドパスで返す。 */
function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: Set<string>,
  field: string,
): MemoryValidationResult<void> {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      return error(
        "MEMORY_UNKNOWN_FIELD",
        `Unknown field: ${field}.${key}`,
        `${field}.${key}`,
      );
    }
  }

  return { ok: true, value: undefined };
}

/** 上位・下位のどちらかだけの UTF-16 サロゲートを検出し、正しいペアは読み飛ばす。 */
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

/** タグを照合するための表記を NFC と小文字化で統一する。表示用の元の表記は別に保持する。 */
export function canonicalizeMemoryTagPart(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

/** NUL と不正なサロゲートを拒否し、前後の空白を除いた後で必須条件と長さを確認する。 */
function normalizeText(
  value: unknown,
  field: string,
  options: { maxLength: number; required?: boolean },
): MemoryValidationResult<string> {
  if (typeof value !== "string") {
    if (options.required === false && value === undefined) {
      return { ok: true, value: "" };
    }
    return error("MEMORY_INVALID_FIELD", `${field} must be a string.`, field);
  }

  if (value.includes("\0")) {
    return error(
      "MEMORY_INVALID_FIELD",
      `${field} must not contain null bytes.`,
      field,
    );
  }
  if (hasUnpairedSurrogate(value)) {
    return error(
      "MEMORY_INVALID_FIELD",
      `${field} must be well-formed Unicode.`,
      field,
    );
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

/** 文字列を検証したうえで絶対パスの書式を要求する。パスの存在やアクセス権は確認しない。 */
function normalizeAbsolutePath(
  value: unknown,
  field: string,
  maxLength = MAX_FILE_PATH_LENGTH,
): MemoryValidationResult<string> {
  const normalized = normalizeText(value, field, { maxLength });
  if (!normalized.ok) {
    return normalized;
  }
  if (!isAbsolutePathLike(normalized.value)) {
    return error(
      "MEMORY_INVALID_FIELD",
      `${field} must be an absolute path.`,
      field,
    );
  }
  return normalized;
}

/** Unix 形式、Windows のドライブ付き形式と UNC 形式の先頭を判定するパターン。 */
export const MEMORY_ABSOLUTE_PATH_PATTERN = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

/** パスが絶対パスの書式で始まるかだけを判定する。実体の解決は行わない。 */
function isAbsolutePathLike(value: string): boolean {
  return MEMORY_ABSOLUTE_PATH_PATTERN.test(value);
}

/** 省略と空文字列を区別し、指定された場合だけ必須文字列と同じ条件で検査する。 */
function normalizeOptionalText(
  value: unknown,
  field: string,
  maxLength = MAX_ID_LENGTH,
): MemoryValidationResult<string | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  const normalized = normalizeText(value, field, { maxLength });
  if (!normalized.ok) {
    return normalized;
  }

  return { ok: true, value: normalized.value };
}

/** 省略を保ち、指定された値は真偽値だけ受け付ける。文字列などから変換しない。 */
function normalizeOptionalBoolean(
  value: unknown,
  field: string,
): MemoryValidationResult<boolean | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  return typeof value === "boolean"
    ? { ok: true, value }
    : error("MEMORY_INVALID_FIELD", `${field} must be a boolean.`, field);
}

/** 省略を保ち、指定された件数が 1 以上かつ操作ごとの上限以内の整数かを確認する。 */
function normalizeOptionalLimit(
  value: unknown,
  field = "limit",
  max = MEMORY_RESULT_LIMIT_MAX,
): MemoryValidationResult<number | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > max
  ) {
    return error(
      "MEMORY_INVALID_FIELD",
      `${field} must be an integer from 1 to ${max}.`,
      field,
    );
  }
  return { ok: true, value };
}

/** 対応する公開形式の版と厳密に一致することを確かめる。欠落や異なる版は受け付けない。 */
function validateSchemaVersion(
  value: Record<string, unknown>,
): MemoryValidationResult<void> {
  if (value.schemaVersion !== MEMORY_V6_SCHEMA_VERSION) {
    return error(
      "MEMORY_INVALID_SCHEMA_VERSION",
      "Unsupported memory schemaVersion.",
      "schemaVersion",
    );
  }

  return { ok: true, value: undefined };
}

/** 任意の文字列配列の項目数と各項目の長さを検査し、正規化後の重複を初出順で除く。 */
function normalizeStringArray(
  value: unknown,
  field: string,
  options: { maxItems: number; maxLength: number },
): MemoryValidationResult<string[] | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  if (!Array.isArray(value)) {
    return error("MEMORY_INVALID_FIELD", `${field} must be an array.`, field);
  }

  if (value.length > options.maxItems) {
    return error(
      "MEMORY_FIELD_TOO_LARGE",
      `${field} has too many items.`,
      field,
    );
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = normalizeText(value[index], `${field}[${index}]`, {
      maxLength: options.maxLength,
    });
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

/** 指定値をエントリー分類の許可リストで検査し、違反時は指定されたフィールドを示す。 */
function validateMemoryKind(
  value: unknown,
  field: string,
): MemoryValidationResult<MemoryEntryKind> {
  if (
    typeof value !== "string" ||
    !MEMORY_ENTRY_KIND_SET.has(value as MemoryEntryKind)
  ) {
    return error(
      "MEMORY_INVALID_FIELD",
      `${field} must be a valid memory kind.`,
      field,
    );
  }

  return { ok: true, value: value as MemoryEntryKind };
}

/** 添付ファイルの役割は省略できるが、指定時は既定の分類値だけを許可する。 */
function validateAppendFileRole(
  value: unknown,
  field: string,
): MemoryValidationResult<MemoryAppendFileRole | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (
    typeof value !== "string" ||
    !MEMORY_APPEND_FILE_ROLE_SET.has(value as MemoryAppendFileRole)
  ) {
    return error(
      "MEMORY_INVALID_FIELD",
      `${field} must be a valid file role.`,
      field,
    );
  }

  return { ok: true, value: value as MemoryAppendFileRole };
}

/** 添付の絶対パスと要約、任意の表示情報を項目ごとに検査する。空配列は添付なしとして扱う。 */
function normalizeAppendFiles(
  value: unknown,
): MemoryValidationResult<MemoryAppendFileInput[] | undefined> {
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
    return error(
      "MEMORY_FIELD_TOO_LARGE",
      `files supports at most ${MAX_APPEND_FILES} items.`,
      "files",
    );
  }

  const normalized: MemoryAppendFileInput[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const file = value[index];
    const field = `files[${index}]`;
    if (!isRecord(file)) {
      return error(
        "MEMORY_INVALID_FIELD",
        `${field} must be an object.`,
        field,
      );
    }
    const unknownKeys = rejectUnknownKeys(file, APPEND_FILE_KEYS, field);
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const filePath = normalizeAbsolutePath(file.path, `${field}.path`);
    if (!filePath.ok) {
      return filePath;
    }
    const summary = normalizeText(file.summary, `${field}.summary`, {
      maxLength: MAX_FILE_SUMMARY_LENGTH,
    });
    if (!summary.ok) {
      return summary;
    }
    const role = validateAppendFileRole(file.role, `${field}.role`);
    if (!role.ok) {
      return role;
    }
    const displayName = normalizeOptionalText(
      file.displayName,
      `${field}.displayName`,
      MAX_FILE_DISPLAY_NAME_LENGTH,
    );
    if (!displayName.ok) {
      return displayName;
    }
    const contentType = normalizeOptionalText(
      file.contentType,
      `${field}.contentType`,
      MAX_FILE_CONTENT_TYPE_LENGTH,
    );
    if (!contentType.ok) {
      return contentType;
    }

    normalized.push({
      path: filePath.value,
      summary: summary.value,
      ...(role.value !== undefined ? { role: role.value } : {}),
      ...(displayName.value !== undefined
        ? { displayName: displayName.value }
        : {}),
      ...(contentType.value !== undefined
        ? { contentType: contentType.value }
        : {}),
    });
  }

  return { ok: true, value: normalized };
}

/** プロジェクト参照を ID または絶対パスとして検査し、選んでいない形式のフィールドは拒否する。 */
function normalizeProjectTarget(
  value: unknown,
  field: string,
): MemoryValidationResult<ProjectTargetRef> {
  if (!isRecord(value)) {
    return error("MEMORY_INVALID_FIELD", `${field} must be an object.`, field);
  }

  if (value.type === "id") {
    const unknownKeys = rejectUnknownKeys(value, PROJECT_TARGET_ID_KEYS, field);
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const id = normalizeText(value.id, `${field}.id`, {
      maxLength: MAX_ID_LENGTH,
    });
    return id.ok ? { ok: true, value: { type: "id", id: id.value } } : id;
  }
  if (value.type === "path") {
    const unknownKeys = rejectUnknownKeys(
      value,
      PROJECT_TARGET_PATH_KEYS,
      field,
    );
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const projectPath = normalizeAbsolutePath(
      value.path,
      `${field}.path`,
      1_000,
    );
    return projectPath.ok
      ? { ok: true, value: { type: "path", path: projectPath.value } }
      : projectPath;
  }
  return error(
    "MEMORY_INVALID_FIELD",
    `${field}.type must be id or path.`,
    `${field}.type`,
  );
}

/** キャラクター参照は ID 形式のみ受け付け、追加フィールドや空の ID を拒否する。 */
function normalizeCharacterTarget(
  value: unknown,
  field: string,
): MemoryValidationResult<CharacterTargetRef> {
  if (!isRecord(value)) {
    return error("MEMORY_INVALID_FIELD", `${field} must be an object.`, field);
  }

  if (value.type === "id") {
    const unknownKeys = rejectUnknownKeys(
      value,
      CHARACTER_TARGET_ID_KEYS,
      field,
    );
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const id = normalizeText(value.id, `${field}.id`, {
      maxLength: MAX_ID_LENGTH,
    });
    return id.ok ? { ok: true, value: { type: "id", id: id.value } } : id;
  }

  return error(
    "MEMORY_INVALID_FIELD",
    `${field}.type must be id.`,
    `${field}.type`,
  );
}

/** 対象の所有者と適用範囲の組み合わせを照合し、その範囲に必要な参照だけを受け付ける。 */
function normalizeMemoryTarget(
  value: unknown,
  field: string,
): MemoryValidationResult<MemoryTargetSelector> {
  if (!isRecord(value)) {
    return error("MEMORY_INVALID_FIELD", `${field} must be an object.`, field);
  }

  if (value.owner === "user" && value.scope === "global") {
    const unknownKeys = rejectUnknownKeys(
      value,
      USER_GLOBAL_TARGET_KEYS,
      field,
    );
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    return { ok: true, value: { owner: "user", scope: "global" } };
  }

  if (value.owner === "project" && value.scope === "project") {
    const unknownKeys = rejectUnknownKeys(
      value,
      PROJECT_PROJECT_TARGET_KEYS,
      field,
    );
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const project = normalizeProjectTarget(value.project, `${field}.project`);
    return project.ok
      ? {
          ok: true,
          value: { owner: "project", scope: "project", project: project.value },
        }
      : project;
  }

  if (value.owner === "character" && value.scope === "character") {
    const unknownKeys = rejectUnknownKeys(
      value,
      CHARACTER_CHARACTER_TARGET_KEYS,
      field,
    );
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const character = normalizeCharacterTarget(
      value.character,
      `${field}.character`,
    );
    return character.ok
      ? {
          ok: true,
          value: {
            owner: "character",
            scope: "character",
            character: character.value,
          },
        }
      : character;
  }

  if (value.owner === "character" && value.scope === "project") {
    const unknownKeys = rejectUnknownKeys(
      value,
      CHARACTER_PROJECT_TARGET_KEYS,
      field,
    );
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const character = normalizeCharacterTarget(
      value.character,
      `${field}.character`,
    );
    if (!character.ok) {
      return character;
    }
    const project = normalizeProjectTarget(value.project, `${field}.project`);
    return project.ok
      ? {
          ok: true,
          value: {
            owner: "character",
            scope: "project",
            character: character.value,
            project: project.value,
          },
        }
      : project;
  }

  return error(
    "MEMORY_INVALID_TARGET",
    "Unsupported memory owner / scope combination.",
    field,
  );
}

/** 対象一覧に 1 件以上を要求し、上限超過や正規化後に同じ指定が重複する場合は拒否する。 */
function normalizeTargets(
  value: unknown,
): MemoryValidationResult<MemoryTargetSelector[]> {
  if (!Array.isArray(value) || value.length === 0) {
    return error(
      "MEMORY_TARGET_REQUIRED",
      "At least one memory target is required.",
      "targets",
    );
  }
  if (value.length > MAX_TARGETS) {
    return error(
      "MEMORY_FIELD_TOO_LARGE",
      `targets supports at most ${MAX_TARGETS} items.`,
      "targets",
    );
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
      return error(
        "MEMORY_DUPLICATE_TARGET",
        "targets must not contain duplicates.",
        `targets[${index}]`,
      );
    }
    seen.add(key);
    normalized.push(target.value);
  }

  return { ok: true, value: normalized };
}

/** タグの表示用表記を残しつつ正規形を加え、種別と値の正規形が一致する重複は初出だけを残す。 */
function normalizeTags(
  value: unknown,
  field = "tags",
): MemoryValidationResult<NormalizedMemoryTag[]> {
  if (value === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value)) {
    return error("MEMORY_INVALID_FIELD", `${field} must be an array.`, field);
  }
  if (value.length > MAX_TAGS) {
    return error(
      "MEMORY_FIELD_TOO_LARGE",
      `${field} has too many items.`,
      field,
    );
  }

  const normalized: NormalizedMemoryTag[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const tag = value[index];
    if (!isRecord(tag)) {
      return error(
        "MEMORY_INVALID_FIELD",
        `${field}[${index}] must be an object.`,
        `${field}[${index}]`,
      );
    }
    const unknownKeys = rejectUnknownKeys(
      tag,
      MEMORY_TAG_KEYS,
      `${field}[${index}]`,
    );
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const type = normalizeText(tag.type, `${field}[${index}].type`, {
      maxLength: MAX_TAG_TYPE_LENGTH,
    });
    if (!type.ok) {
      return type;
    }
    const tagValue = normalizeText(tag.value, `${field}[${index}].value`, {
      maxLength: MAX_TAG_VALUE_LENGTH,
    });
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
    normalized.push({
      type: type.value,
      value: tagValue.value,
      canonicalType,
      canonicalValue,
    });
  }

  return { ok: true, value: normalized };
}

/** 分類フィルターを許可値に絞って重複を除き、空配列はフィルター未指定として扱う。 */
function normalizeKinds(
  value: unknown,
): MemoryValidationResult<MemoryEntryKind[] | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(value)) {
    return error("MEMORY_INVALID_FIELD", "kinds must be an array.", "kinds");
  }
  if (value.length > MEMORY_ENTRY_KINDS.length) {
    return error(
      "MEMORY_FIELD_TOO_LARGE",
      "kinds has too many items.",
      "kinds",
    );
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

/** 検索対象と空でない検索語を必須とし、任意のフィルター、件数、カーソルを整える。 */
export function validateMemorySearchRequest(
  value: unknown,
): MemoryValidationResult<MemorySearchRequest> {
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
  const query = normalizeText(value.query, "query", {
    maxLength: MAX_SEARCH_QUERY_LENGTH,
  });
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
  const cursor = normalizeOptionalText(
    value.cursor,
    "cursor",
    MAX_CURSOR_LENGTH,
  );
  if (!cursor.ok) {
    return cursor;
  }

  let limit: number | undefined;
  if (value.limit !== undefined) {
    if (
      typeof value.limit !== "number" ||
      !Number.isInteger(value.limit) ||
      value.limit < 1 ||
      value.limit > MEMORY_RESULT_LIMIT_MAX
    ) {
      return error(
        "MEMORY_INVALID_FIELD",
        `limit must be an integer from 1 to ${MEMORY_RESULT_LIMIT_MAX}.`,
        "limit",
      );
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

/** 詳細取得に必要なエントリー ID と所属先を検証する。エントリーの照会は行わない。 */
export function validateMemoryGetEntryRequest(
  value: unknown,
): MemoryValidationResult<MemoryGetEntryRequest> {
  if (!isRecord(value)) {
    return error(
      "MEMORY_INVALID_REQUEST",
      "Get entry request must be an object.",
    );
  }
  const unknownKeys = rejectUnknownKeys(
    value,
    GET_ENTRY_REQUEST_KEYS,
    "request",
  );
  if (!unknownKeys.ok) {
    return unknownKeys;
  }
  const schema = validateSchemaVersion(value);
  if (!schema.ok) {
    return schema;
  }
  const entryId = normalizeText(value.entryId, "entryId", {
    maxLength: MAX_ID_LENGTH,
  });
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

/** 添付取得に必要な対象、オブジェクト ID、絶対出力パスを検証する。ファイルは読み書きしない。 */
export function validateMemoryGetFileRequest(
  value: unknown,
): MemoryValidationResult<MemoryGetFileRequest> {
  if (!isRecord(value)) {
    return error(
      "MEMORY_INVALID_REQUEST",
      "Get file request must be an object.",
    );
  }
  const unknownKeys = rejectUnknownKeys(
    value,
    GET_FILE_REQUEST_KEYS,
    "request",
  );
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
  const objectId = normalizeText(value.objectId, "objectId", {
    maxLength: MAX_OBJECT_ID_LENGTH,
  });
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

/** 一括出力に必要な対象、エントリー ID、絶対ディレクトリパスを検証する。 */
export function validateMemoryExportFilesRequest(
  value: unknown,
): MemoryValidationResult<MemoryExportFilesRequest> {
  if (!isRecord(value)) {
    return error(
      "MEMORY_INVALID_REQUEST",
      "Export files request must be an object.",
    );
  }
  const unknownKeys = rejectUnknownKeys(
    value,
    EXPORT_FILES_REQUEST_KEYS,
    "request",
  );
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
  const entryId = normalizeText(value.entryId, "entryId", {
    maxLength: MAX_ID_LENGTH,
  });
  if (!entryId.ok) {
    return entryId;
  }
  const outputDirectoryPath = normalizeAbsolutePath(
    value.outputDirectoryPath,
    "outputDirectoryPath",
  );
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

/** 対象一覧の所有者・適用範囲などの任意フィルターと管理用ページ件数を検証する。 */
export function validateMemoryListTargetsRequest(
  value: unknown,
): MemoryValidationResult<MemoryListTargetsRequest> {
  if (!isRecord(value)) {
    return error(
      "MEMORY_INVALID_REQUEST",
      "List targets request must be an object.",
    );
  }
  const unknownKeys = rejectUnknownKeys(
    value,
    LIST_TARGETS_REQUEST_KEYS,
    "request",
  );
  if (!unknownKeys.ok) {
    return unknownKeys;
  }
  const schema = validateSchemaVersion(value);
  if (!schema.ok) {
    return schema;
  }
  if (
    value.owner !== undefined &&
    !["user", "project", "character"].includes(String(value.owner))
  ) {
    return error(
      "MEMORY_INVALID_FIELD",
      "owner must be user, project, or character.",
      "owner",
    );
  }
  if (
    value.scope !== undefined &&
    !["global", "project", "character"].includes(String(value.scope))
  ) {
    return error(
      "MEMORY_INVALID_FIELD",
      "scope must be global, project, or character.",
      "scope",
    );
  }
  const project =
    value.project === undefined
      ? undefined
      : normalizeProjectTarget(value.project, "project");
  if (project && !project.ok) {
    return project;
  }
  const character =
    value.character === undefined
      ? undefined
      : normalizeCharacterTarget(value.character, "character");
  if (character && !character.ok) {
    return character;
  }
  const includeEmpty = normalizeOptionalBoolean(
    value.includeEmpty,
    "includeEmpty",
  );
  if (!includeEmpty.ok) {
    return includeEmpty;
  }
  const limit = normalizeOptionalLimit(
    value.limit,
    "limit",
    MAX_MAINTENANCE_LIMIT,
  );
  if (!limit.ok) {
    return limit;
  }
  const cursor = normalizeOptionalText(
    value.cursor,
    "cursor",
    MAX_CURSOR_LENGTH,
  );
  if (!cursor.ok) {
    return cursor;
  }
  return {
    ok: true,
    value: {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      ...(value.owner === undefined
        ? {}
        : { owner: value.owner as MemoryListTargetsRequest["owner"] }),
      ...(value.scope === undefined
        ? {}
        : { scope: value.scope as MemoryListTargetsRequest["scope"] }),
      ...(project?.ok ? { project: project.value } : {}),
      ...(character?.ok ? { character: character.value } : {}),
      ...(includeEmpty.value === undefined
        ? {}
        : { includeEmpty: includeEmpty.value }),
      ...(limit.value === undefined ? {} : { limit: limit.value }),
      ...(cursor.value === undefined ? {} : { cursor: cursor.value }),
    },
  };
}

/** 単一対象の一覧条件を検証する。状態が指定されていれば空配列を拒み、重複を除く。 */
export function validateMemoryListEntriesRequest(
  value: unknown,
): MemoryValidationResult<MemoryListEntriesRequest> {
  if (!isRecord(value)) {
    return error(
      "MEMORY_INVALID_REQUEST",
      "List entries request must be an object.",
    );
  }
  const unknownKeys = rejectUnknownKeys(
    value,
    LIST_ENTRIES_REQUEST_KEYS,
    "request",
  );
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
  let states: MemoryListEntriesRequest["states"];
  if (value.states !== undefined) {
    if (!Array.isArray(value.states) || value.states.length === 0) {
      return error(
        "MEMORY_INVALID_FIELD",
        "states must be a non-empty array.",
        "states",
      );
    }
    states = [];
    for (let index = 0; index < value.states.length; index += 1) {
      const state = value.states[index];
      if (
        typeof state !== "string" ||
        !MEMORY_ENTRY_STATES.has(state as "active" | "superseded" | "forgotten")
      ) {
        return error(
          "MEMORY_INVALID_FIELD",
          `states[${index}] must be a valid memory state.`,
          `states[${index}]`,
        );
      }
      if (!states.includes(state as "active" | "superseded" | "forgotten")) {
        states.push(state as "active" | "superseded" | "forgotten");
      }
    }
  }
  const kinds = normalizeKinds(value.kinds);
  if (!kinds.ok) {
    return kinds;
  }
  const tags = normalizeTags(value.tags);
  if (!tags.ok) {
    return tags;
  }
  const includeBody = normalizeOptionalBoolean(
    value.includeBody,
    "includeBody",
  );
  if (!includeBody.ok) {
    return includeBody;
  }
  const limit = normalizeOptionalLimit(
    value.limit,
    "limit",
    MAX_MAINTENANCE_LIMIT,
  );
  if (!limit.ok) {
    return limit;
  }
  const cursor = normalizeOptionalText(
    value.cursor,
    "cursor",
    MAX_CURSOR_LENGTH,
  );
  if (!cursor.ok) {
    return cursor;
  }
  return {
    ok: true,
    value: {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: target.value,
      ...(states ? { states } : {}),
      ...(kinds.value ? { kinds: kinds.value } : {}),
      ...(tags.value.length > 0 ? { tags: tags.value } : {}),
      ...(includeBody.value === undefined
        ? {}
        : { includeBody: includeBody.value }),
      ...(limit.value === undefined ? {} : { limit: limit.value }),
      ...(cursor.value === undefined ? {} : { cursor: cursor.value }),
    },
  };
}

/** 全対象または個別対象のどちらか一方を要求し、指定された基準日時を ISO 形式へそろえる。 */
export function validateMemoryAuditRequest(
  value: unknown,
): MemoryValidationResult<MemoryAuditRequest> {
  if (!isRecord(value)) {
    return error("MEMORY_INVALID_REQUEST", "Audit request must be an object.");
  }
  const unknownKeys = rejectUnknownKeys(value, AUDIT_REQUEST_KEYS, "request");
  if (!unknownKeys.ok) {
    return unknownKeys;
  }
  const schema = validateSchemaVersion(value);
  if (!schema.ok) {
    return schema;
  }
  const allTargets = normalizeOptionalBoolean(value.allTargets, "allTargets");
  if (!allTargets.ok) {
    return allTargets;
  }
  const targets =
    value.targets === undefined ? undefined : normalizeTargets(value.targets);
  if (targets && !targets.ok) {
    return targets;
  }
  if ((allTargets.value === true) === Boolean(targets?.ok)) {
    return error(
      "MEMORY_INVALID_FIELD",
      "Specify exactly one of allTargets=true or targets.",
      "allTargets",
    );
  }
  const staleBefore = normalizeOptionalText(
    value.staleBefore,
    "staleBefore",
    64,
  );
  if (!staleBefore.ok) {
    return staleBefore;
  }
  if (
    staleBefore.value !== undefined &&
    Number.isNaN(Date.parse(staleBefore.value))
  ) {
    return error(
      "MEMORY_INVALID_FIELD",
      "staleBefore must be an ISO 8601 timestamp.",
      "staleBefore",
    );
  }
  const limit = normalizeOptionalLimit(
    value.limit,
    "limit",
    MAX_MAINTENANCE_LIMIT,
  );
  if (!limit.ok) {
    return limit;
  }
  const cursor = normalizeOptionalText(
    value.cursor,
    "cursor",
    MAX_CURSOR_LENGTH,
  );
  if (!cursor.ok) {
    return cursor;
  }
  return {
    ok: true,
    value: {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      ...(allTargets.value ? { allTargets: true } : {}),
      ...(targets?.ok ? { targets: targets.value } : {}),
      ...(staleBefore.value === undefined
        ? {}
        : { staleBefore: new Date(staleBefore.value).toISOString() }),
      ...(limit.value === undefined ? {} : { limit: limit.value }),
      ...(cursor.value === undefined ? {} : { cursor: cursor.value }),
    },
  };
}

/** タグ一覧には対象を 1 件だけ要求し、サンプル数と集計指定の依存関係、再開カーソルの形式を検査する。 */
export function validateMemoryListTagsRequest(
  value: unknown,
): MemoryValidationResult<MemoryListTagsRequest> {
  if (!isRecord(value)) {
    return error(
      "MEMORY_INVALID_REQUEST",
      "List tags request must be an object.",
    );
  }
  const unknownKeys = rejectUnknownKeys(
    value,
    LIST_TAGS_REQUEST_KEYS,
    "request",
  );
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
  if (targets.value.length !== 1) {
    return error(
      "MEMORY_INVALID_TARGET",
      "List tags requires exactly one target.",
      "targets",
    );
  }

  const withCounts = normalizeOptionalBoolean(value.withCounts, "withCounts");
  if (!withCounts.ok) {
    return withCounts;
  }
  const sampleLimit = normalizeOptionalLimit(value.sampleLimit, "sampleLimit");
  if (!sampleLimit.ok) {
    return sampleLimit;
  }
  if (sampleLimit.value !== undefined && withCounts.value !== true) {
    return error(
      "MEMORY_INVALID_FIELD",
      "sampleLimit requires withCounts=true.",
      "sampleLimit",
    );
  }
  const limit = normalizeOptionalLimit(
    value.limit,
    "limit",
    MAX_MAINTENANCE_LIMIT,
  );
  if (!limit.ok) {
    return limit;
  }
  const cursor = normalizeOptionalText(
    value.cursor,
    "cursor",
    MAX_CURSOR_LENGTH,
  );
  if (!cursor.ok) {
    return cursor;
  }
  if (cursor.value !== undefined && !decodeMemoryListTagsCursor(cursor.value)) {
    return error(
      "MEMORY_INVALID_FIELD",
      "cursor must be a valid list-tags continuation cursor.",
      "cursor",
    );
  }

  return {
    ok: true,
    value: {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: targets.value,
      ...(withCounts.value === undefined
        ? {}
        : { withCounts: withCounts.value }),
      ...(sampleLimit.value === undefined
        ? {}
        : { sampleLimit: sampleLimit.value }),
      ...(limit.value === undefined ? {} : { limit: limit.value }),
      ...(cursor.value === undefined ? {} : { cursor: cursor.value }),
    },
  };
}

/** 外側の構造を検証した後に行う、append とアプリ管理の生成で共通の内容の正規化。 */
export function validateMemoryEntryContent(
  value: Record<string, unknown>,
): MemoryValidationResult<MemoryEntryContent> {
  const kind = validateMemoryKind(value.kind, "kind");
  if (!kind.ok) return kind;
  const title = normalizeText(value.title, "title", {
    maxLength: MAX_TITLE_LENGTH,
  });
  if (!title.ok) return title;
  const body = normalizeText(value.body, "body", {
    maxLength: MAX_BODY_LENGTH,
  });
  if (!body.ok) return body;
  const preview = normalizeText(value.preview, "preview", {
    maxLength: MAX_PREVIEW_LENGTH,
  });
  if (!preview.ok) return preview;
  const tags = normalizeTags(value.tags);
  if (!tags.ok) return tags;
  return {
    ok: true,
    value: {
      kind: kind.value,
      title: title.value,
      body: body.value,
      preview: preview.value,
      tags: tags.value,
    },
  };
}

/** 追加する内容、対象、任意の置換元や添付、再送時の冪等キーを検証して保存用の入力に整える。 */
export function validateMemoryAppendRequest(
  value: unknown,
): MemoryValidationResult<MemoryAppendRequest> {
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
  const content = validateMemoryEntryContent(value);
  if (!content.ok) return content;
  const supersedes = normalizeStringArray(value.supersedes, "supersedes", {
    maxItems: MAX_SUPERSEDES,
    maxLength: MAX_ID_LENGTH,
  });
  if (!supersedes.ok) {
    return supersedes;
  }
  const mutationReason = normalizeOptionalText(
    value.mutationReason,
    "mutationReason",
  );
  if (!mutationReason.ok) {
    return mutationReason;
  }
  const files = normalizeAppendFiles(value.files);
  if (!files.ok) {
    return files;
  }
  const sourceMessageId = normalizeOptionalText(
    value.sourceMessageId,
    "sourceMessageId",
  );
  if (!sourceMessageId.ok) {
    return sourceMessageId;
  }
  const idempotencyKey = normalizeOptionalText(
    value.idempotencyKey,
    "idempotencyKey",
  );
  if (!idempotencyKey.ok) {
    return idempotencyKey;
  }

  return {
    ok: true,
    value: {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: target.value,
      ...content.value,
      ...(supersedes.value && supersedes.value.length > 0
        ? { supersedes: supersedes.value }
        : {}),
      ...(mutationReason.value !== undefined
        ? { mutationReason: mutationReason.value }
        : {}),
      ...(files.value && files.value.length > 0 ? { files: files.value } : {}),
      ...(sourceMessageId.value !== undefined
        ? { sourceMessageId: sourceMessageId.value }
        : {}),
      ...(idempotencyKey.value !== undefined
        ? { idempotencyKey: idempotencyKey.value }
        : {}),
    },
  };
}

/** 内訳ごとに単件追加と同じ入力条件を適用し、冪等キーを必須とする。違反箇所は項目番号付きで返す。 */
export function validateMemoryAppendEntriesRequest(
  value: unknown,
): MemoryValidationResult<MemoryAppendEntriesRequest> {
  if (!isRecord(value))
    return error(
      "MEMORY_INVALID_REQUEST",
      "Append entries request must be an object.",
    );
  const keys = rejectUnknownKeys(value, APPEND_ENTRIES_REQUEST_KEYS, "request");
  if (!keys.ok) return keys;
  const schema = validateSchemaVersion(value);
  if (!schema.ok) return schema;
  const target = normalizeMemoryTarget(value.target, "target");
  if (!target.ok) return target;
  if (!Array.isArray(value.entries) || value.entries.length === 0) {
    return error(
      "MEMORY_INVALID_FIELD",
      "entries must be a non-empty array.",
      "entries",
    );
  }
  const entries: MemoryAppendEntriesRequest["entries"] = [];
  for (const [index, item] of value.entries.entries()) {
    if (!isRecord(item))
      return error(
        "MEMORY_INVALID_FIELD",
        "Each entry must be an object.",
        `entries[${index}]`,
      );
    const itemKeys = rejectUnknownKeys(
      item,
      APPEND_ENTRY_KEYS,
      `entries[${index}]`,
    );
    if (!itemKeys.ok) return itemKeys;
    const validated = validateMemoryAppendRequest({
      ...item,
      schemaVersion: value.schemaVersion,
      target: value.target,
    });
    if (!validated.ok)
      return {
        ok: false,
        error: {
          ...validated.error,
          field: `entries[${index}]${validated.error.field ? `.${validated.error.field}` : ""}`,
        },
      };
    if (!validated.value.idempotencyKey)
      return error(
        "MEMORY_INVALID_FIELD",
        "Each entry requires an idempotency key.",
        `entries[${index}].idempotencyKey`,
      );
    const {
      schemaVersion: _schemaVersion,
      target: _target,
      ...entry
    } = validated.value;
    entries.push({ ...entry, idempotencyKey: validated.value.idempotencyKey });
  }
  return {
    ok: true,
    value: {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: target.value,
      entries,
    },
  };
}

/** 忘却対象の ID を 1 件以上要求して重複を除き、任意の理由と書き込み前の確認指定を検証する。 */
export function validateMemoryForgetRequest(
  value: unknown,
): MemoryValidationResult<MemoryForgetRequest> {
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
  const entryIds = normalizeStringArray(value.entryIds, "entryIds", {
    maxItems: MAX_FORGET_ENTRY_IDS,
    maxLength: MAX_ID_LENGTH,
  });
  if (!entryIds.ok) {
    return entryIds;
  }
  if (!entryIds.value || entryIds.value.length === 0) {
    return error(
      "MEMORY_INVALID_FIELD",
      "entryIds must not be empty.",
      "entryIds",
    );
  }
  if (
    value.reason !== undefined &&
    (typeof value.reason !== "string" ||
      !MEMORY_FORGET_REASON_SET.has(value.reason as MemoryForgetReason))
  ) {
    return error(
      "MEMORY_INVALID_FIELD",
      "reason must be a valid forget reason.",
      "reason",
    );
  }
  const sourceMessageId = normalizeOptionalText(
    value.sourceMessageId,
    "sourceMessageId",
  );
  if (!sourceMessageId.ok) {
    return sourceMessageId;
  }
  const idempotencyKey = normalizeOptionalText(
    value.idempotencyKey,
    "idempotencyKey",
  );
  if (!idempotencyKey.ok) {
    return idempotencyKey;
  }

  const dryRun = normalizeOptionalBoolean(value.dryRun, "dryRun");
  if (!dryRun.ok) {
    return dryRun;
  }

  return {
    ok: true,
    value: {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: target.value,
      entryIds: entryIds.value,
      ...(value.reason !== undefined
        ? { reason: value.reason as MemoryForgetReason }
        : {}),
      ...(sourceMessageId.value !== undefined
        ? { sourceMessageId: sourceMessageId.value }
        : {}),
      ...(idempotencyKey.value !== undefined
        ? { idempotencyKey: idempotencyKey.value }
        : {}),
      ...(dryRun.value === undefined ? {} : { dryRun: dryRun.value }),
    },
  };
}

/** 移動理由を必須とし、正規化後の指定で移動元と移動先が同一なら拒否する。実際の対象解決は行わない。 */
export function validateMemoryMoveEntryRequest(
  value: unknown,
): MemoryValidationResult<MemoryMoveEntryRequest> {
  if (!isRecord(value)) {
    return error(
      "MEMORY_INVALID_REQUEST",
      "Move entry request must be an object.",
    );
  }
  const unknownKeys = rejectUnknownKeys(
    value,
    MOVE_ENTRY_REQUEST_KEYS,
    "request",
  );
  if (!unknownKeys.ok) {
    return unknownKeys;
  }
  const schema = validateSchemaVersion(value);
  if (!schema.ok) {
    return schema;
  }
  const entryId = normalizeText(value.entryId, "entryId", {
    maxLength: MAX_ID_LENGTH,
  });
  if (!entryId.ok) {
    return entryId;
  }
  const from = normalizeMemoryTarget(value.from, "from");
  if (!from.ok) {
    return from;
  }
  const to = normalizeMemoryTarget(value.to, "to");
  if (!to.ok) {
    return to;
  }
  if (JSON.stringify(from.value) === JSON.stringify(to.value)) {
    return error(
      "MEMORY_INVALID_FIELD",
      "from and to must identify different targets.",
      "to",
    );
  }
  const reason = normalizeText(value.reason, "reason", {
    maxLength: MAX_REASON_LENGTH,
  });
  if (!reason.ok) {
    return reason;
  }
  const sourceMessageId = normalizeOptionalText(
    value.sourceMessageId,
    "sourceMessageId",
  );
  if (!sourceMessageId.ok) {
    return sourceMessageId;
  }
  const idempotencyKey = normalizeOptionalText(
    value.idempotencyKey,
    "idempotencyKey",
  );
  if (!idempotencyKey.ok) {
    return idempotencyKey;
  }
  return {
    ok: true,
    value: {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      entryId: entryId.value,
      from: from.value,
      to: to.value,
      reason: reason.value,
      ...(sourceMessageId.value === undefined
        ? {}
        : { sourceMessageId: sourceMessageId.value }),
      ...(idempotencyKey.value === undefined
        ? {}
        : { idempotencyKey: idempotencyKey.value }),
    },
  };
}

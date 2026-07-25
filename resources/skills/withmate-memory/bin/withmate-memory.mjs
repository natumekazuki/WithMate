// Generated from scripts/withmate-memory.ts. Do not edit directly.
import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
//#region src/memory-v6/memory-contract.ts
var MEMORY_V6_SCHEMA_VERSION = "withmate-memory-v1";
var MEMORY_ENTRY_KINDS = [
	"decision",
	"constraint",
	"convention",
	"context",
	"deferred",
	"preference",
	"relationship",
	"boundary",
	"note"
];
var MEMORY_APPEND_FILE_ROLES = [
	"evidence",
	"source",
	"snapshot",
	"artifact",
	"reference",
	"other"
];
var MEMORY_FORGET_REASONS = [
	"user_request",
	"incorrect",
	"outdated",
	"privacy",
	"other"
];
//#endregion
//#region src/memory-v6/memory-discovery.ts
var WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION = "withmate-memory-discovery-v1";
var WITHMATE_MEMORY_DISCOVERY_FILE_NAME = "memory-v6-api.json";
function isLoopbackHostname(hostname) {
	const normalized = hostname.toLowerCase();
	if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") return true;
	const ipv4Parts = normalized.split(".");
	return ipv4Parts.length === 4 && ipv4Parts[0] === "127" && ipv4Parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255);
}
function normalizeWithMateMemoryApiBaseUrl(value) {
	const trimmed = value.trim();
	if (!trimmed) return null;
	try {
		const url = new URL(trimmed);
		if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)) return null;
		url.pathname = url.pathname.replace(/\/+$/, "");
		url.search = "";
		url.hash = "";
		return url.toString().replace(/\/$/, "");
	} catch {
		return null;
	}
}
function resolveDefaultWithMateMemoryRuntimeDirectory(env = process.env) {
	const runtimeDirectoryPath = env.WITHMATE_MEMORY_RUNTIME_DIR?.trim();
	if (runtimeDirectoryPath) return path.resolve(runtimeDirectoryPath);
	const ownerSegment = typeof process.getuid === "function" ? `uid-${process.getuid()}` : "local-user";
	return path.join(tmpdir(), "withmate-memory", ownerSegment);
}
function resolveDefaultWithMateMemoryDiscoveryFilePath(env = process.env) {
	return path.join(resolveDefaultWithMateMemoryRuntimeDirectory(env), WITHMATE_MEMORY_DISCOVERY_FILE_NAME);
}
//#endregion
//#region src/memory-v6/memory-response-contract.ts
function createMemoryErrorResponse(error) {
	return {
		schemaVersion: MEMORY_V6_SCHEMA_VERSION,
		error
	};
}
//#endregion
//#region src/memory-v6/memory-validation.ts
var MEMORY_ENTRY_KIND_SET = new Set(MEMORY_ENTRY_KINDS);
var MEMORY_APPEND_FILE_ROLE_SET = new Set(MEMORY_APPEND_FILE_ROLES);
var MEMORY_FORGET_REASON_SET = new Set(MEMORY_FORGET_REASONS);
var SEARCH_REQUEST_KEYS = /* @__PURE__ */ new Set([
	"schemaVersion",
	"targets",
	"query",
	"kinds",
	"tags",
	"limit",
	"cursor"
]);
var GET_ENTRY_REQUEST_KEYS = /* @__PURE__ */ new Set([
	"schemaVersion",
	"entryId",
	"target"
]);
var GET_FILE_REQUEST_KEYS = /* @__PURE__ */ new Set([
	"schemaVersion",
	"target",
	"objectId",
	"outputPath"
]);
var EXPORT_FILES_REQUEST_KEYS = /* @__PURE__ */ new Set([
	"schemaVersion",
	"target",
	"entryId",
	"outputDirectoryPath"
]);
var LIST_TAGS_REQUEST_KEYS = /* @__PURE__ */ new Set(["schemaVersion", "targets"]);
var APPEND_REQUEST_KEYS = /* @__PURE__ */ new Set([
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
	"idempotencyKey"
]);
var FORGET_REQUEST_KEYS = /* @__PURE__ */ new Set([
	"schemaVersion",
	"target",
	"entryIds",
	"reason",
	"sourceMessageId",
	"idempotencyKey"
]);
var PROJECT_TARGET_ID_KEYS = /* @__PURE__ */ new Set(["type", "id"]);
var PROJECT_TARGET_PATH_KEYS = /* @__PURE__ */ new Set(["type", "path"]);
var CHARACTER_TARGET_ID_KEYS = /* @__PURE__ */ new Set(["type", "id"]);
var MEMORY_TAG_KEYS = /* @__PURE__ */ new Set(["type", "value"]);
var APPEND_FILE_KEYS = /* @__PURE__ */ new Set([
	"path",
	"summary",
	"role",
	"displayName",
	"contentType"
]);
var PROJECT_PROJECT_TARGET_KEYS = /* @__PURE__ */ new Set([
	"owner",
	"scope",
	"project"
]);
var CHARACTER_CHARACTER_TARGET_KEYS = /* @__PURE__ */ new Set([
	"owner",
	"scope",
	"character"
]);
var CHARACTER_PROJECT_TARGET_KEYS = /* @__PURE__ */ new Set([
	"owner",
	"scope",
	"character",
	"project"
]);
var USER_GLOBAL_TARGET_KEYS = /* @__PURE__ */ new Set(["owner", "scope"]);
var MAX_SEARCH_QUERY_LENGTH = 500;
var MAX_TITLE_LENGTH = 160;
var MAX_PREVIEW_LENGTH = 280;
var MAX_BODY_LENGTH = 8e3;
var MAX_TAG_TYPE_LENGTH = 48;
var MAX_TAG_VALUE_LENGTH = 96;
var MAX_ID_LENGTH = 200;
var MAX_CURSOR_LENGTH = 500;
var MAX_LIMIT = 50;
var MAX_TAGS = 20;
var MAX_SUPERSEDES = 20;
var MAX_APPEND_FILES = 10;
var MAX_FILE_PATH_LENGTH = 1e3;
var MAX_OBJECT_ID_LENGTH = 64;
var MAX_FILE_SUMMARY_LENGTH = 500;
var MAX_FILE_DISPLAY_NAME_LENGTH = 255;
var MAX_FILE_CONTENT_TYPE_LENGTH = 120;
var MAX_FORGET_ENTRY_IDS = 50;
var MAX_TARGETS = 5;
function error(code, message, field) {
	return {
		ok: false,
		error: field ? {
			code,
			message,
			field
		} : {
			code,
			message
		}
	};
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function rejectUnknownKeys(value, allowedKeys, field) {
	for (const key of Object.keys(value)) if (!allowedKeys.has(key)) return error("MEMORY_UNKNOWN_FIELD", `Unknown field: ${field}.${key}`, `${field}.${key}`);
	return {
		ok: true,
		value: void 0
	};
}
function hasUnpairedSurrogate(value) {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 55296 && code <= 56319) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 56320 && next <= 57343)) return true;
			index += 1;
			continue;
		}
		if (code >= 56320 && code <= 57343) return true;
	}
	return false;
}
function canonicalizeMemoryTagPart(value) {
	return value.normalize("NFC").toLowerCase();
}
function normalizeText(value, field, options) {
	if (typeof value !== "string") {
		if (options.required === false && value === void 0) return {
			ok: true,
			value: ""
		};
		return error("MEMORY_INVALID_FIELD", `${field} must be a string.`, field);
	}
	if (value.includes("\0")) return error("MEMORY_INVALID_FIELD", `${field} must not contain null bytes.`, field);
	if (hasUnpairedSurrogate(value)) return error("MEMORY_INVALID_FIELD", `${field} must be well-formed Unicode.`, field);
	const normalized = value.trim();
	if (options.required !== false && normalized.length === 0) return error("MEMORY_INVALID_FIELD", `${field} must not be empty.`, field);
	if (normalized.length > options.maxLength) return error("MEMORY_FIELD_TOO_LARGE", `${field} is too long.`, field);
	return {
		ok: true,
		value: normalized
	};
}
function normalizeAbsolutePath(value, field) {
	const normalized = normalizeText(value, field, { maxLength: MAX_FILE_PATH_LENGTH });
	if (!normalized.ok) return normalized;
	if (!isAbsolutePathLike(normalized.value)) return error("MEMORY_INVALID_FIELD", `${field} must be an absolute path.`, field);
	return normalized;
}
function isAbsolutePathLike(value) {
	return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}
function normalizeOptionalText(value, field, maxLength = MAX_ID_LENGTH) {
	if (value === void 0) return {
		ok: true,
		value: void 0
	};
	const normalized = normalizeText(value, field, { maxLength });
	if (!normalized.ok) return normalized;
	return {
		ok: true,
		value: normalized.value
	};
}
function validateSchemaVersion(value) {
	if (value.schemaVersion !== "withmate-memory-v1") return error("MEMORY_INVALID_SCHEMA_VERSION", "Unsupported memory schemaVersion.", "schemaVersion");
	return {
		ok: true,
		value: void 0
	};
}
function normalizeStringArray(value, field, options) {
	if (value === void 0) return {
		ok: true,
		value: void 0
	};
	if (!Array.isArray(value)) return error("MEMORY_INVALID_FIELD", `${field} must be an array.`, field);
	if (value.length > options.maxItems) return error("MEMORY_FIELD_TOO_LARGE", `${field} has too many items.`, field);
	const normalized = [];
	const seen = /* @__PURE__ */ new Set();
	for (let index = 0; index < value.length; index += 1) {
		const item = normalizeText(value[index], `${field}[${index}]`, { maxLength: options.maxLength });
		if (!item.ok) return item;
		if (seen.has(item.value)) continue;
		seen.add(item.value);
		normalized.push(item.value);
	}
	return {
		ok: true,
		value: normalized
	};
}
function validateMemoryKind(value, field) {
	if (typeof value !== "string" || !MEMORY_ENTRY_KIND_SET.has(value)) return error("MEMORY_INVALID_FIELD", `${field} must be a valid memory kind.`, field);
	return {
		ok: true,
		value
	};
}
function validateAppendFileRole(value, field) {
	if (value === void 0) return {
		ok: true,
		value: void 0
	};
	if (typeof value !== "string" || !MEMORY_APPEND_FILE_ROLE_SET.has(value)) return error("MEMORY_INVALID_FIELD", `${field} must be a valid file role.`, field);
	return {
		ok: true,
		value
	};
}
function normalizeAppendFiles(value) {
	if (value === void 0) return {
		ok: true,
		value: void 0
	};
	if (!Array.isArray(value)) return error("MEMORY_INVALID_FIELD", "files must be an array.", "files");
	if (value.length === 0) return {
		ok: true,
		value: void 0
	};
	if (value.length > MAX_APPEND_FILES) return error("MEMORY_FIELD_TOO_LARGE", `files supports at most ${MAX_APPEND_FILES} items.`, "files");
	const normalized = [];
	for (let index = 0; index < value.length; index += 1) {
		const file = value[index];
		const field = `files[${index}]`;
		if (!isRecord(file)) return error("MEMORY_INVALID_FIELD", `${field} must be an object.`, field);
		const unknownKeys = rejectUnknownKeys(file, APPEND_FILE_KEYS, field);
		if (!unknownKeys.ok) return unknownKeys;
		const filePath = normalizeAbsolutePath(file.path, `${field}.path`);
		if (!filePath.ok) return filePath;
		const summary = normalizeText(file.summary, `${field}.summary`, { maxLength: MAX_FILE_SUMMARY_LENGTH });
		if (!summary.ok) return summary;
		const role = validateAppendFileRole(file.role, `${field}.role`);
		if (!role.ok) return role;
		const displayName = normalizeOptionalText(file.displayName, `${field}.displayName`, MAX_FILE_DISPLAY_NAME_LENGTH);
		if (!displayName.ok) return displayName;
		const contentType = normalizeOptionalText(file.contentType, `${field}.contentType`, MAX_FILE_CONTENT_TYPE_LENGTH);
		if (!contentType.ok) return contentType;
		normalized.push({
			path: filePath.value,
			summary: summary.value,
			...role.value !== void 0 ? { role: role.value } : {},
			...displayName.value !== void 0 ? { displayName: displayName.value } : {},
			...contentType.value !== void 0 ? { contentType: contentType.value } : {}
		});
	}
	return {
		ok: true,
		value: normalized
	};
}
function normalizeProjectTarget(value, field) {
	if (!isRecord(value)) return error("MEMORY_INVALID_FIELD", `${field} must be an object.`, field);
	if (value.type === "id") {
		const unknownKeys = rejectUnknownKeys(value, PROJECT_TARGET_ID_KEYS, field);
		if (!unknownKeys.ok) return unknownKeys;
		const id = normalizeText(value.id, `${field}.id`, { maxLength: MAX_ID_LENGTH });
		return id.ok ? {
			ok: true,
			value: {
				type: "id",
				id: id.value
			}
		} : id;
	}
	if (value.type === "path") {
		const unknownKeys = rejectUnknownKeys(value, PROJECT_TARGET_PATH_KEYS, field);
		if (!unknownKeys.ok) return unknownKeys;
		const projectPath = normalizeText(value.path, `${field}.path`, { maxLength: 1e3 });
		return projectPath.ok ? {
			ok: true,
			value: {
				type: "path",
				path: projectPath.value
			}
		} : projectPath;
	}
	return error("MEMORY_INVALID_FIELD", `${field}.type must be id or path.`, `${field}.type`);
}
function normalizeCharacterTarget(value, field) {
	if (!isRecord(value)) return error("MEMORY_INVALID_FIELD", `${field} must be an object.`, field);
	if (value.type === "id") {
		const unknownKeys = rejectUnknownKeys(value, CHARACTER_TARGET_ID_KEYS, field);
		if (!unknownKeys.ok) return unknownKeys;
		const id = normalizeText(value.id, `${field}.id`, { maxLength: MAX_ID_LENGTH });
		return id.ok ? {
			ok: true,
			value: {
				type: "id",
				id: id.value
			}
		} : id;
	}
	return error("MEMORY_INVALID_FIELD", `${field}.type must be id.`, `${field}.type`);
}
function normalizeMemoryTarget(value, field) {
	if (!isRecord(value)) return error("MEMORY_INVALID_FIELD", `${field} must be an object.`, field);
	if (value.owner === "user" && value.scope === "global") {
		const unknownKeys = rejectUnknownKeys(value, USER_GLOBAL_TARGET_KEYS, field);
		if (!unknownKeys.ok) return unknownKeys;
		return {
			ok: true,
			value: {
				owner: "user",
				scope: "global"
			}
		};
	}
	if (value.owner === "project" && value.scope === "project") {
		const unknownKeys = rejectUnknownKeys(value, PROJECT_PROJECT_TARGET_KEYS, field);
		if (!unknownKeys.ok) return unknownKeys;
		const project = normalizeProjectTarget(value.project, `${field}.project`);
		return project.ok ? {
			ok: true,
			value: {
				owner: "project",
				scope: "project",
				project: project.value
			}
		} : project;
	}
	if (value.owner === "character" && value.scope === "character") {
		const unknownKeys = rejectUnknownKeys(value, CHARACTER_CHARACTER_TARGET_KEYS, field);
		if (!unknownKeys.ok) return unknownKeys;
		const character = normalizeCharacterTarget(value.character, `${field}.character`);
		return character.ok ? {
			ok: true,
			value: {
				owner: "character",
				scope: "character",
				character: character.value
			}
		} : character;
	}
	if (value.owner === "character" && value.scope === "project") {
		const unknownKeys = rejectUnknownKeys(value, CHARACTER_PROJECT_TARGET_KEYS, field);
		if (!unknownKeys.ok) return unknownKeys;
		const character = normalizeCharacterTarget(value.character, `${field}.character`);
		if (!character.ok) return character;
		const project = normalizeProjectTarget(value.project, `${field}.project`);
		return project.ok ? {
			ok: true,
			value: {
				owner: "character",
				scope: "project",
				character: character.value,
				project: project.value
			}
		} : project;
	}
	return error("MEMORY_INVALID_TARGET", "Unsupported memory owner / scope combination.", field);
}
function normalizeTargets(value) {
	if (!Array.isArray(value) || value.length === 0) return error("MEMORY_TARGET_REQUIRED", "At least one memory target is required.", "targets");
	if (value.length > MAX_TARGETS) return error("MEMORY_FIELD_TOO_LARGE", `targets supports at most ${MAX_TARGETS} items.`, "targets");
	const normalized = [];
	const seen = /* @__PURE__ */ new Set();
	for (let index = 0; index < value.length; index += 1) {
		const target = normalizeMemoryTarget(value[index], `targets[${index}]`);
		if (!target.ok) return target;
		const key = JSON.stringify(target.value);
		if (seen.has(key)) return error("MEMORY_DUPLICATE_TARGET", "targets must not contain duplicates.", `targets[${index}]`);
		seen.add(key);
		normalized.push(target.value);
	}
	return {
		ok: true,
		value: normalized
	};
}
function normalizeTags(value, field = "tags", options = {}) {
	if (value === void 0) {
		if (options.required) return error("MEMORY_INVALID_FIELD", `${field} is required.`, field);
		return {
			ok: true,
			value: []
		};
	}
	if (!Array.isArray(value)) return error("MEMORY_INVALID_FIELD", `${field} must be an array.`, field);
	if (value.length > MAX_TAGS) return error("MEMORY_FIELD_TOO_LARGE", `${field} has too many items.`, field);
	const normalized = [];
	const seen = /* @__PURE__ */ new Set();
	for (let index = 0; index < value.length; index += 1) {
		const tag = value[index];
		if (!isRecord(tag)) return error("MEMORY_INVALID_FIELD", `${field}[${index}] must be an object.`, `${field}[${index}]`);
		const unknownKeys = rejectUnknownKeys(tag, MEMORY_TAG_KEYS, `${field}[${index}]`);
		if (!unknownKeys.ok) return unknownKeys;
		const type = normalizeText(tag.type, `${field}[${index}].type`, { maxLength: MAX_TAG_TYPE_LENGTH });
		if (!type.ok) return type;
		const tagValue = normalizeText(tag.value, `${field}[${index}].value`, { maxLength: MAX_TAG_VALUE_LENGTH });
		if (!tagValue.ok) return tagValue;
		const canonicalType = canonicalizeMemoryTagPart(type.value);
		const canonicalValue = canonicalizeMemoryTagPart(tagValue.value);
		const key = `${canonicalType}\0${canonicalValue}`;
		if (seen.has(key)) continue;
		seen.add(key);
		normalized.push({
			type: type.value,
			value: tagValue.value,
			canonicalType,
			canonicalValue
		});
	}
	return {
		ok: true,
		value: normalized
	};
}
function normalizeKinds(value) {
	if (value === void 0) return {
		ok: true,
		value: void 0
	};
	if (!Array.isArray(value)) return error("MEMORY_INVALID_FIELD", "kinds must be an array.", "kinds");
	if (value.length > MEMORY_ENTRY_KINDS.length) return error("MEMORY_FIELD_TOO_LARGE", "kinds has too many items.", "kinds");
	const normalized = [];
	const seen = /* @__PURE__ */ new Set();
	for (let index = 0; index < value.length; index += 1) {
		const kind = validateMemoryKind(value[index], `kinds[${index}]`);
		if (!kind.ok) return kind;
		if (seen.has(kind.value)) continue;
		seen.add(kind.value);
		normalized.push(kind.value);
	}
	return {
		ok: true,
		value: normalized.length > 0 ? normalized : void 0
	};
}
function validateMemorySearchRequest(value) {
	if (!isRecord(value)) return error("MEMORY_INVALID_REQUEST", "Search request must be an object.");
	const unknownKeys = rejectUnknownKeys(value, SEARCH_REQUEST_KEYS, "request");
	if (!unknownKeys.ok) return unknownKeys;
	const schema = validateSchemaVersion(value);
	if (!schema.ok) return schema;
	const targets = normalizeTargets(value.targets);
	if (!targets.ok) return targets;
	const query = normalizeText(value.query, "query", { maxLength: MAX_SEARCH_QUERY_LENGTH });
	if (!query.ok) return query;
	const kinds = normalizeKinds(value.kinds);
	if (!kinds.ok) return kinds;
	const tags = normalizeTags(value.tags);
	if (!tags.ok) return tags;
	const cursor = normalizeOptionalText(value.cursor, "cursor", MAX_CURSOR_LENGTH);
	if (!cursor.ok) return cursor;
	let limit;
	if (value.limit !== void 0) {
		if (typeof value.limit !== "number" || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > MAX_LIMIT) return error("MEMORY_INVALID_FIELD", `limit must be an integer from 1 to ${MAX_LIMIT}.`, "limit");
		limit = value.limit;
	}
	return {
		ok: true,
		value: {
			schemaVersion: MEMORY_V6_SCHEMA_VERSION,
			targets: targets.value,
			query: query.value,
			...kinds.value ? { kinds: kinds.value } : {},
			...tags.value.length > 0 ? { tags: tags.value } : {},
			...limit !== void 0 ? { limit } : {},
			...cursor.value !== void 0 ? { cursor: cursor.value } : {}
		}
	};
}
function validateMemoryGetEntryRequest(value) {
	if (!isRecord(value)) return error("MEMORY_INVALID_REQUEST", "Get entry request must be an object.");
	const unknownKeys = rejectUnknownKeys(value, GET_ENTRY_REQUEST_KEYS, "request");
	if (!unknownKeys.ok) return unknownKeys;
	const schema = validateSchemaVersion(value);
	if (!schema.ok) return schema;
	const entryId = normalizeText(value.entryId, "entryId", { maxLength: MAX_ID_LENGTH });
	if (!entryId.ok) return entryId;
	const target = normalizeMemoryTarget(value.target, "target");
	if (!target.ok) return target;
	return {
		ok: true,
		value: {
			schemaVersion: MEMORY_V6_SCHEMA_VERSION,
			entryId: entryId.value,
			target: target.value
		}
	};
}
function validateMemoryGetFileRequest(value) {
	if (!isRecord(value)) return error("MEMORY_INVALID_REQUEST", "Get file request must be an object.");
	const unknownKeys = rejectUnknownKeys(value, GET_FILE_REQUEST_KEYS, "request");
	if (!unknownKeys.ok) return unknownKeys;
	const schema = validateSchemaVersion(value);
	if (!schema.ok) return schema;
	const target = normalizeMemoryTarget(value.target, "target");
	if (!target.ok) return target;
	const objectId = normalizeText(value.objectId, "objectId", { maxLength: MAX_OBJECT_ID_LENGTH });
	if (!objectId.ok) return objectId;
	const outputPath = normalizeAbsolutePath(value.outputPath, "outputPath");
	if (!outputPath.ok) return outputPath;
	return {
		ok: true,
		value: {
			schemaVersion: MEMORY_V6_SCHEMA_VERSION,
			target: target.value,
			objectId: objectId.value,
			outputPath: outputPath.value
		}
	};
}
function validateMemoryExportFilesRequest(value) {
	if (!isRecord(value)) return error("MEMORY_INVALID_REQUEST", "Export files request must be an object.");
	const unknownKeys = rejectUnknownKeys(value, EXPORT_FILES_REQUEST_KEYS, "request");
	if (!unknownKeys.ok) return unknownKeys;
	const schema = validateSchemaVersion(value);
	if (!schema.ok) return schema;
	const target = normalizeMemoryTarget(value.target, "target");
	if (!target.ok) return target;
	const entryId = normalizeText(value.entryId, "entryId", { maxLength: MAX_ID_LENGTH });
	if (!entryId.ok) return entryId;
	const outputDirectoryPath = normalizeAbsolutePath(value.outputDirectoryPath, "outputDirectoryPath");
	if (!outputDirectoryPath.ok) return outputDirectoryPath;
	return {
		ok: true,
		value: {
			schemaVersion: MEMORY_V6_SCHEMA_VERSION,
			target: target.value,
			entryId: entryId.value,
			outputDirectoryPath: outputDirectoryPath.value
		}
	};
}
function validateMemoryListTagsRequest(value) {
	if (!isRecord(value)) return error("MEMORY_INVALID_REQUEST", "List tags request must be an object.");
	const unknownKeys = rejectUnknownKeys(value, LIST_TAGS_REQUEST_KEYS, "request");
	if (!unknownKeys.ok) return unknownKeys;
	const schema = validateSchemaVersion(value);
	if (!schema.ok) return schema;
	const targets = normalizeTargets(value.targets);
	if (!targets.ok) return targets;
	return {
		ok: true,
		value: {
			schemaVersion: MEMORY_V6_SCHEMA_VERSION,
			targets: targets.value
		}
	};
}
function validateMemoryAppendRequest(value) {
	if (!isRecord(value)) return error("MEMORY_INVALID_REQUEST", "Append request must be an object.");
	const unknownKeys = rejectUnknownKeys(value, APPEND_REQUEST_KEYS, "request");
	if (!unknownKeys.ok) return unknownKeys;
	const schema = validateSchemaVersion(value);
	if (!schema.ok) return schema;
	const target = normalizeMemoryTarget(value.target, "target");
	if (!target.ok) return target;
	const kind = validateMemoryKind(value.kind, "kind");
	if (!kind.ok) return kind;
	const title = normalizeText(value.title, "title", { maxLength: MAX_TITLE_LENGTH });
	if (!title.ok) return title;
	const body = normalizeText(value.body, "body", { maxLength: MAX_BODY_LENGTH });
	if (!body.ok) return body;
	const preview = normalizeText(value.preview, "preview", { maxLength: MAX_PREVIEW_LENGTH });
	if (!preview.ok) return preview;
	const tags = normalizeTags(value.tags, "tags", { required: true });
	if (!tags.ok) return tags;
	const supersedes = normalizeStringArray(value.supersedes, "supersedes", {
		maxItems: MAX_SUPERSEDES,
		maxLength: MAX_ID_LENGTH
	});
	if (!supersedes.ok) return supersedes;
	const files = normalizeAppendFiles(value.files);
	if (!files.ok) return files;
	const sourceMessageId = normalizeOptionalText(value.sourceMessageId, "sourceMessageId");
	if (!sourceMessageId.ok) return sourceMessageId;
	const idempotencyKey = normalizeOptionalText(value.idempotencyKey, "idempotencyKey");
	if (!idempotencyKey.ok) return idempotencyKey;
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
			...supersedes.value && supersedes.value.length > 0 ? { supersedes: supersedes.value } : {},
			...files.value && files.value.length > 0 ? { files: files.value } : {},
			...sourceMessageId.value !== void 0 ? { sourceMessageId: sourceMessageId.value } : {},
			...idempotencyKey.value !== void 0 ? { idempotencyKey: idempotencyKey.value } : {}
		}
	};
}
function validateMemoryForgetRequest(value) {
	if (!isRecord(value)) return error("MEMORY_INVALID_REQUEST", "Forget request must be an object.");
	const unknownKeys = rejectUnknownKeys(value, FORGET_REQUEST_KEYS, "request");
	if (!unknownKeys.ok) return unknownKeys;
	const schema = validateSchemaVersion(value);
	if (!schema.ok) return schema;
	const target = normalizeMemoryTarget(value.target, "target");
	if (!target.ok) return target;
	const entryIds = normalizeStringArray(value.entryIds, "entryIds", {
		maxItems: MAX_FORGET_ENTRY_IDS,
		maxLength: MAX_ID_LENGTH
	});
	if (!entryIds.ok) return entryIds;
	if (!entryIds.value || entryIds.value.length === 0) return error("MEMORY_INVALID_FIELD", "entryIds must not be empty.", "entryIds");
	if (value.reason !== void 0 && (typeof value.reason !== "string" || !MEMORY_FORGET_REASON_SET.has(value.reason))) return error("MEMORY_INVALID_FIELD", "reason must be a valid forget reason.", "reason");
	const sourceMessageId = normalizeOptionalText(value.sourceMessageId, "sourceMessageId");
	if (!sourceMessageId.ok) return sourceMessageId;
	const idempotencyKey = normalizeOptionalText(value.idempotencyKey, "idempotencyKey");
	if (!idempotencyKey.ok) return idempotencyKey;
	return {
		ok: true,
		value: {
			schemaVersion: MEMORY_V6_SCHEMA_VERSION,
			target: target.value,
			entryIds: entryIds.value,
			...value.reason !== void 0 ? { reason: value.reason } : {},
			...sourceMessageId.value !== void 0 ? { sourceMessageId: sourceMessageId.value } : {},
			...idempotencyKey.value !== void 0 ? { idempotencyKey: idempotencyKey.value } : {}
		}
	};
}
//#endregion
//#region scripts/withmate-memory.ts
var WITHMATE_MEMORY_CLI_EXIT_CODES = {
	ok: 0,
	usage: 1,
	notRunning: 2,
	apiError: 3,
	transportError: 4
};
var routeByCommand = {
	status: {
		method: "GET",
		path: "/v1/status"
	},
	characters: {
		method: "GET",
		path: "/v1/characters"
	},
	file_usage: {
		method: "GET",
		path: "/v1/file_usage"
	},
	search: {
		method: "POST",
		path: "/v1/search"
	},
	get_entry: {
		method: "POST",
		path: "/v1/get_entry"
	},
	get_file: {
		method: "POST",
		path: "/v1/get_file"
	},
	export_files: {
		method: "POST",
		path: "/v1/export_files"
	},
	list_tags: {
		method: "POST",
		path: "/v1/list_tags"
	},
	append: {
		method: "POST",
		path: "/v1/append"
	},
	forget: {
		method: "POST",
		path: "/v1/forget"
	}
};
function buildRoutePath(request) {
	const route = routeByCommand[request.command];
	if (request.command !== "file_usage" || !request.body || typeof request.body !== "object") return route.path;
	const body = request.body;
	const query = new URLSearchParams();
	if (body.largest === true) query.set("largest", "1");
	if (typeof body.limit === "number") query.set("limit", String(body.limit));
	const queryString = query.toString();
	return queryString ? `${route.path}?${queryString}` : route.path;
}
var DEFAULT_REQUEST_TIMEOUT_MS = 1e4;
var DEFAULT_FILE_OPERATION_REQUEST_TIMEOUT_MS = 3e5;
var WITHMATE_MEMORY_API_SECRET_HEADER = "x-withmate-memory-api-secret";
var FILE_OPERATION_COMMANDS = /* @__PURE__ */ new Set([
	"append",
	"get_file",
	"export_files"
]);
var commandAliases = /* @__PURE__ */ new Map([
	["help", "help"],
	["status", "status"],
	["characters", "characters"],
	["list-characters", "characters"],
	["list_characters", "characters"],
	["file-usage", "file_usage"],
	["file_usage", "file_usage"],
	["search", "search"],
	["get-entry", "get_entry"],
	["get_entry", "get_entry"],
	["get-file", "get_file"],
	["get_file", "get_file"],
	["export-files", "export_files"],
	["export_files", "export_files"],
	["list-tags", "list_tags"],
	["list_tags", "list_tags"],
	["append", "append"],
	["forget", "forget"],
	["schema", "schema"],
	["capabilities", "schema"],
	["validate", "validate"]
]);
var WITHMATE_MEMORY_CLI_HELP = `Usage:
  withmate-memory <command> [options]

Commands:
  help
  status
  characters
  file-usage
  search
  get-entry
  get-file
  export-files
  list-tags
  append
  forget
  schema
  validate

Input options:
  --json <json>       Read request body from an inline JSON string.
  --file <path>       Read request body from a JSON file.
  @file               Read request body from a JSON file.
  --stdin             Read request body from standard input.

Shorthand options:
  --project <absolute-path>
  --project-id <id>
  --query <text>
  --tag <tag>
  --tags <tags>
  --entry-id <id>
  --object-id <id>
  --output <path>
  --output-dir <path>
  --largest
  --limit <n>

Connection options:
  --api-url <url>
  --discovery-file <path>

Validation:
  validate --command <search|get-entry|get-file|export-files|list-tags|append|forget>

Examples:
  withmate-memory status
  withmate-memory characters
  withmate-memory file-usage
  withmate-memory file-usage --largest --limit 10
  withmate-memory search --project C:\\path\\to\\repo --query "release workflow"
  withmate-memory get-file --project C:\\path\\to\\repo --object-id <id> --output C:\\path\\to\\file.bin
  withmate-memory export-files --project C:\\path\\to\\repo --entry-id <id> --output-dir C:\\path\\to\\exports
  withmate-memory validate --command append --stdin
  withmate-memory schema
`;
var validatableCommands = /* @__PURE__ */ new Set([
	"search",
	"get_entry",
	"get_file",
	"export_files",
	"list_tags",
	"append",
	"forget"
]);
function usageError(message) {
	return createMemoryErrorResponse({
		code: "WITHMATE_MEMORY_CLI_USAGE",
		message
	});
}
function notRunningError() {
	return createMemoryErrorResponse({
		code: "WITHMATE_NOT_RUNNING",
		message: "WithMate Memory API is not running or could not be discovered."
	});
}
function requestTimeoutError(command, timeoutMs) {
	return createMemoryErrorResponse({
		code: "WITHMATE_MEMORY_REQUEST_TIMEOUT",
		message: `WithMate Memory API request timed out after ${timeoutMs}ms.`,
		field: command
	});
}
function transportError(message) {
	return createMemoryErrorResponse({
		code: "WITHMATE_MEMORY_TRANSPORT_ERROR",
		message
	});
}
function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}
function resolveRuntimeRequestTimeoutMs(command, deps = {}) {
	if (deps.requestTimeoutMs !== void 0) return deps.requestTimeoutMs;
	if (FILE_OPERATION_COMMANDS.has(command)) return deps.fileOperationRequestTimeoutMs ?? 3e5;
	return DEFAULT_REQUEST_TIMEOUT_MS;
}
function readEnvSecret(env) {
	const value = env.WITHMATE_MEMORY_API_SECRET?.trim();
	return value ? value : void 0;
}
function readEnvRuntimeInstanceId(env) {
	const value = env.WITHMATE_MEMORY_RUNTIME_INSTANCE_ID?.trim();
	return value ? value : void 0;
}
async function readStdin(stdin) {
	const chunks = [];
	for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}
async function parseJsonInput(input) {
	const trimmed = input.trim();
	if (!trimmed) return {};
	try {
		return JSON.parse(trimmed);
	} catch {
		throw usageError("Request JSON must be valid JSON. If shell quoting changed the JSON, retry with --file <path> or --stdin.");
	}
}
function normalizeCommandName(value) {
	return commandAliases.get(value);
}
function normalizeValidatableCommand(value) {
	const command = normalizeCommandName(value);
	if (command && validatableCommands.has(command)) return command;
}
async function discoverWithMateMemoryApi(options = {}) {
	const env = options.env ?? process.env;
	if (options.apiUrl !== void 0) {
		const explicitUrl = normalizeWithMateMemoryApiBaseUrl(options.apiUrl);
		if (!explicitUrl) throw usageError("--api-url must be a valid loopback HTTP URL.");
		return {
			baseUrl: explicitUrl,
			...readEnvSecret(env) ? { apiSecret: readEnvSecret(env) } : {},
			...readEnvRuntimeInstanceId(env) ? { runtimeInstanceId: readEnvRuntimeInstanceId(env) } : {}
		};
	}
	const rawEnvUrl = env.WITHMATE_MEMORY_API_URL?.trim();
	if (rawEnvUrl) {
		const envUrl = normalizeWithMateMemoryApiBaseUrl(rawEnvUrl);
		if (!envUrl) throw usageError("WITHMATE_MEMORY_API_URL must be a valid loopback HTTP URL.");
		return {
			baseUrl: envUrl,
			...readEnvSecret(env) ? { apiSecret: readEnvSecret(env) } : {},
			...readEnvRuntimeInstanceId(env) ? { runtimeInstanceId: readEnvRuntimeInstanceId(env) } : {}
		};
	}
	const envDiscoveryFilePath = env.WITHMATE_MEMORY_DISCOVERY_FILE?.trim();
	const discoveryFilePath = options.discoveryFilePath ?? (envDiscoveryFilePath || resolveDefaultWithMateMemoryDiscoveryFilePath(env));
	const read = options.readFile ?? readFile;
	try {
		const document = JSON.parse(await read(discoveryFilePath, "utf8"));
		if (document.schemaVersion !== "withmate-memory-discovery-v1" || typeof document.baseUrl !== "string") return null;
		const baseUrl = normalizeWithMateMemoryApiBaseUrl(document.baseUrl);
		if (!baseUrl) return null;
		return {
			baseUrl,
			...typeof document.apiSecret === "string" && document.apiSecret.trim() ? { apiSecret: document.apiSecret.trim() } : {},
			...typeof document.runtimeInstanceId === "string" && document.runtimeInstanceId.trim() ? { runtimeInstanceId: document.runtimeInstanceId.trim() } : {}
		};
	} catch {
		return null;
	}
}
async function parseWithMateMemoryCliArgs(args, deps = {}) {
	const [rawCommand, ...rest] = args;
	if (!rawCommand || rawCommand === "--help" || rawCommand === "-h") return {
		command: "help",
		body: {}
	};
	const command = rawCommand ? commandAliases.get(rawCommand) : void 0;
	if (!command) throw usageError("Usage: withmate-memory <help|status|characters|file-usage|search|get-entry|get-file|export-files|list-tags|append|forget|schema|validate> [--json <json> | --file <path> | @file | --stdin] [--command <command>] [--project <absolute-path> | --project-id <id>] [--query <text>] [--tag <tag> | --tags <tags>] [--entry-id <id>] [--object-id <id>] [--output <path>] [--output-dir <path>] [--limit <n>] [--api-url <url>] [--discovery-file <path>]");
	if (command === "help" || rest.includes("--help") || rest.includes("-h")) return {
		command: "help",
		body: {}
	};
	let jsonInput = null;
	let filePath = null;
	let stdinRequested = false;
	let apiUrl;
	let discoveryFilePath;
	let validateCommand;
	let projectPath;
	let projectId;
	let query;
	const tagOptions = [];
	let entryId;
	let objectId;
	let outputPath;
	let outputDirectoryPath;
	let largest = false;
	let limit;
	for (let index = 0; index < rest.length; index += 1) {
		const arg = rest[index];
		if (arg === "--json") jsonInput = requireOptionValue(rest, ++index, arg);
		else if (arg === "--file") filePath = requireOptionValue(rest, ++index, arg);
		else if (arg === "--stdin") stdinRequested = true;
		else if (arg.startsWith("@") && arg.length > 1) filePath = arg.slice(1);
		else if (arg === "--api-url") apiUrl = requireOptionValue(rest, ++index, arg);
		else if (arg === "--discovery-file") discoveryFilePath = requireOptionValue(rest, ++index, arg);
		else if (arg === "--command") {
			validateCommand = normalizeValidatableCommand(requireOptionValue(rest, ++index, arg));
			if (!validateCommand) throw usageError(`--command must be one of: ${Array.from(validatableCommands).join(", ")}.`);
		} else if (arg === "--project") projectPath = requireOptionValue(rest, ++index, arg);
		else if (arg === "--project-id") projectId = requireOptionValue(rest, ++index, arg);
		else if (arg === "--query") query = requireOptionValue(rest, ++index, arg);
		else if (arg === "--tag") tagOptions.push(requireOptionValue(rest, ++index, arg));
		else if (arg === "--tags") tagOptions.push(...parseTagsOption(requireOptionValue(rest, ++index, arg)));
		else if (arg === "--entry-id") entryId = requireOptionValue(rest, ++index, arg);
		else if (arg === "--object-id") objectId = requireOptionValue(rest, ++index, arg);
		else if (arg === "--output") outputPath = requireOptionValue(rest, ++index, arg);
		else if (arg === "--output-dir") outputDirectoryPath = requireOptionValue(rest, ++index, arg);
		else if (arg === "--largest") largest = true;
		else if (arg === "--limit") limit = parseLimitOption(requireOptionValue(rest, ++index, arg));
		else throw usageError(`Unknown option: ${arg}`);
	}
	if ([
		jsonInput !== null,
		filePath !== null,
		stdinRequested
	].filter(Boolean).length > 1) throw usageError("--json, --file, @file, and --stdin cannot be used together.");
	if ([Boolean(projectPath), Boolean(projectId)].filter(Boolean).length > 1) throw usageError("--project and --project-id cannot be used together.");
	if (command === "validate" && !validateCommand) throw usageError("validate requires --command <search|get-entry|get-file|export-files|list-tags|append|forget>.");
	let body = {};
	if (command === "file_usage") {
		if (jsonInput !== null || filePath !== null || stdinRequested) throw usageError("file-usage does not accept JSON body input. Use --largest and --limit.");
		if (hasShorthandOptions({
			projectPath,
			projectId,
			query,
			tags: tagOptions,
			entryId,
			objectId,
			outputPath,
			outputDirectoryPath,
			largest,
			limit
		})) body = buildShorthandBody(command, {
			projectPath,
			projectId,
			query,
			tags: tagOptions,
			entryId,
			objectId,
			outputPath,
			outputDirectoryPath,
			largest,
			limit
		});
	} else if (command !== "status" && command !== "characters" && command !== "schema") {
		if (jsonInput !== null) body = await parseJsonInput(jsonInput);
		else if (filePath !== null) body = await parseJsonInput(await (deps.readFile ?? readFile)(filePath, "utf8"));
		else if (stdinRequested) body = await parseJsonInput(await readStdin(deps.stdin ?? process.stdin));
		else if (hasShorthandOptions({
			projectPath,
			projectId,
			query,
			tags: tagOptions,
			entryId,
			objectId,
			outputPath,
			outputDirectoryPath,
			largest,
			limit
		})) body = buildShorthandBody(command, {
			projectPath,
			projectId,
			query,
			tags: tagOptions,
			entryId,
			objectId,
			outputPath,
			outputDirectoryPath,
			largest,
			limit
		});
		else if (deps.stdin && !deps.stdin.isTTY) body = await parseJsonInput(await readStdin(deps.stdin));
	}
	return {
		command,
		body: normalizeProjectPathTargets(body),
		...validateCommand ? { validateCommand } : {},
		...apiUrl ? { apiUrl } : {},
		...discoveryFilePath ? { discoveryFilePath } : {}
	};
}
function parseLimitOption(value) {
	const limit = Number(value);
	if (!Number.isInteger(limit) || limit < 1) throw usageError("--limit must be a positive integer.");
	return limit;
}
function parseTagsOption(value) {
	return value.split(",").map((item) => item.trim()).filter(Boolean);
}
function normalizeCliTagOptions(values) {
	const tags = [];
	const seen = /* @__PURE__ */ new Set();
	for (const rawValue of values) {
		const trimmed = rawValue.trim();
		if (!trimmed) continue;
		const separatorIndex = trimmed.indexOf(":");
		const type = separatorIndex > 0 ? trimmed.slice(0, separatorIndex).trim() : "topic";
		const value = separatorIndex > 0 ? trimmed.slice(separatorIndex + 1).trim() : trimmed;
		if (!type || !value) throw usageError("--tag and --tags values must be <tag> or <type>:<tag>.");
		const key = `${type.normalize("NFC").toLowerCase()}\0${value.normalize("NFC").toLowerCase()}`;
		if (seen.has(key)) continue;
		seen.add(key);
		tags.push({
			type,
			value
		});
	}
	return tags;
}
function hasShorthandOptions(options) {
	return Boolean(options.projectPath || options.projectId || options.query || options.tags && options.tags.length > 0 || options.entryId || options.objectId || options.outputPath || options.outputDirectoryPath || options.largest || options.limit !== void 0);
}
function isAbsoluteCliPath(value) {
	return path.isAbsolute(value) || path.win32.isAbsolute(value);
}
function normalizeCliProjectPath(value) {
	if (!isAbsoluteCliPath(value)) throw usageError("--project requires an absolute path.");
	return path.win32.isAbsolute(value) ? path.win32.normalize(value).replace(/\\/g, "/") : path.resolve(value);
}
function normalizeCliOutputPath(value) {
	if (!isAbsoluteCliPath(value)) throw usageError("--output requires an absolute path.");
	return path.win32.isAbsolute(value) ? path.win32.normalize(value) : path.resolve(value);
}
function normalizeCliOutputDirectoryPath(value) {
	if (!isAbsoluteCliPath(value)) throw usageError("--output-dir requires an absolute path.");
	return path.win32.isAbsolute(value) ? path.win32.normalize(value) : path.resolve(value);
}
function buildProjectTarget(options) {
	if (options.projectId) return {
		owner: "project",
		scope: "project",
		project: {
			type: "id",
			id: options.projectId
		}
	};
	if (options.projectPath) return {
		owner: "project",
		scope: "project",
		project: {
			type: "path",
			path: normalizeCliProjectPath(options.projectPath)
		}
	};
	return null;
}
function buildShorthandBody(command, options) {
	if (command === "validate") throw usageError("validate shorthand options are not supported. Use --json, --file, @file, or --stdin.");
	const target = buildProjectTarget(options);
	if (command === "file_usage") {
		if (target || options.query || options.tags && options.tags.length > 0 || options.entryId || options.objectId || options.outputPath || options.outputDirectoryPath) throw usageError("file-usage shorthand only supports --largest and --limit.");
		if (options.limit !== void 0 && !options.largest) throw usageError("file-usage --limit requires --largest.");
		return {
			...options.largest ? { largest: true } : {},
			...options.limit !== void 0 ? { limit: options.limit } : {}
		};
	}
	if (command === "search") {
		if (!target) throw usageError("search shorthand requires --project <absolute-path> or --project-id <id>.");
		const tags = normalizeCliTagOptions(options.tags ?? []);
		const query = options.query ?? tags.map((tag) => tag.value).join(" ");
		if (!query) throw usageError("search shorthand requires --query <text> or --tag <tag>.");
		return {
			schemaVersion: MEMORY_V6_SCHEMA_VERSION,
			targets: [target],
			query,
			...tags.length > 0 ? { tags } : {},
			...options.limit !== void 0 ? { limit: options.limit } : {}
		};
	}
	if (command === "list_tags") {
		if (!target) throw usageError("list-tags shorthand requires --project <absolute-path> or --project-id <id>.");
		return {
			schemaVersion: MEMORY_V6_SCHEMA_VERSION,
			targets: [target]
		};
	}
	if (command === "get_entry") {
		if (!options.entryId) throw usageError("get-entry shorthand requires --entry-id <id>.");
		if (!target) throw usageError("get-entry shorthand requires --project <absolute-path> or --project-id <id>.");
		return {
			schemaVersion: MEMORY_V6_SCHEMA_VERSION,
			entryId: options.entryId,
			target
		};
	}
	if (command === "get_file") {
		if (!options.objectId) throw usageError("get-file shorthand requires --object-id <id>.");
		if (!options.outputPath) throw usageError("get-file shorthand requires --output <absolute-path>.");
		if (!target) throw usageError("get-file shorthand requires --project <absolute-path> or --project-id <id>.");
		return {
			schemaVersion: MEMORY_V6_SCHEMA_VERSION,
			target,
			objectId: options.objectId,
			outputPath: normalizeCliOutputPath(options.outputPath)
		};
	}
	if (command === "export_files") {
		if (!options.entryId) throw usageError("export-files shorthand requires --entry-id <id>.");
		if (!options.outputDirectoryPath) throw usageError("export-files shorthand requires --output-dir <absolute-path>.");
		if (!target) throw usageError("export-files shorthand requires --project <absolute-path> or --project-id <id>.");
		return {
			schemaVersion: MEMORY_V6_SCHEMA_VERSION,
			target,
			entryId: options.entryId,
			outputDirectoryPath: normalizeCliOutputDirectoryPath(options.outputDirectoryPath)
		};
	}
	throw usageError(`${command} does not support shorthand options. Use --json, --file, @file, or --stdin.`);
}
function normalizeProjectPathTargets(value) {
	if (Array.isArray(value)) return value.map((item) => normalizeProjectPathTargets(item));
	if (!value || typeof value !== "object") return value;
	const record = value;
	const normalized = {};
	for (const [key, item] of Object.entries(record)) normalized[key] = normalizeProjectPathTargets(item);
	if (record.type === "path" && typeof record.path === "string") normalized.path = normalizeCliProjectPath(record.path);
	return normalized;
}
function requireOptionValue(args, index, option) {
	const value = args[index];
	if (!value || value.startsWith("--")) throw usageError(`${option} requires a value.`);
	return value;
}
function buildSchemaResponse() {
	return {
		schemaVersion: MEMORY_V6_SCHEMA_VERSION,
		entryKinds: [...MEMORY_ENTRY_KINDS],
		forgetReasons: [...MEMORY_FORGET_REASONS],
		commands: [
			"help",
			"status",
			"characters",
			"file-usage",
			"search",
			"get-entry",
			"get-file",
			"export-files",
			"list-tags",
			"append",
			"forget",
			"schema",
			"validate"
		],
		requestBodyInputs: [
			"--json",
			"--file",
			"@file",
			"--stdin"
		],
		targetSelectors: [
			{
				owner: "project",
				scope: "project",
				requiredFields: ["project"],
				projectTypes: ["id", "path"]
			},
			{
				owner: "character",
				scope: "character",
				requiredFields: ["character"],
				characterTypes: ["id"]
			},
			{
				owner: "character",
				scope: "project",
				requiredFields: ["character", "project"],
				characterTypes: ["id"],
				projectTypes: ["id", "path"]
			},
			{
				owner: "user",
				scope: "global",
				requiredFields: []
			}
		]
	};
}
function validateMemoryCliRequestBody(command, body) {
	if (command === "search") return validateMemorySearchRequest(body);
	if (command === "get_entry") return validateMemoryGetEntryRequest(body);
	if (command === "get_file") return validateMemoryGetFileRequest(body);
	if (command === "export_files") return validateMemoryExportFilesRequest(body);
	if (command === "list_tags") return validateMemoryListTagsRequest(body);
	if (command === "append") return validateMemoryAppendRequest(body);
	return validateMemoryForgetRequest(body);
}
function buildValidateResponse(command, body) {
	const validation = validateMemoryCliRequestBody(command, body);
	if (!validation.ok) return {
		exitCode: WITHMATE_MEMORY_CLI_EXIT_CODES.apiError,
		response: createMemoryErrorResponse(validation.error)
	};
	return {
		exitCode: WITHMATE_MEMORY_CLI_EXIT_CODES.ok,
		response: {
			schemaVersion: MEMORY_V6_SCHEMA_VERSION,
			valid: true,
			command,
			value: validation.value
		}
	};
}
async function readJsonResponse(response) {
	const text = await response.text();
	if (!text.trim()) return {};
	try {
		return JSON.parse(text);
	} catch {
		throw transportError("Memory API returned a non-JSON response.");
	}
}
function createStatusChallenge(apiSecret, nonce) {
	return createHmac("sha256", apiSecret).update(nonce, "utf8").digest("base64url");
}
function hasVerifiableRuntimeIdentity(connection) {
	return Boolean(connection.apiSecret?.trim() && connection.runtimeInstanceId?.trim());
}
async function verifyRuntimeIdentity(connection, fetchImpl, signal) {
	if (!hasVerifiableRuntimeIdentity(connection)) return false;
	const nonce = randomBytes(16).toString("base64url");
	const response = await fetchImpl(`${connection.baseUrl}/v1/status?nonce=${encodeURIComponent(nonce)}`, {
		method: "GET",
		redirect: "error",
		signal
	});
	if (!response.ok) return false;
	const status = await readJsonResponse(response);
	return status.runtimeInstanceId === connection.runtimeInstanceId && status.challenge?.nonce === nonce && status.challenge.hmacSha256 === createStatusChallenge(connection.apiSecret, nonce);
}
async function runWithMateMemoryCli(args, deps = {}) {
	const stdout = deps.stdout ?? process.stdout;
	const stderr = deps.stderr ?? process.stderr;
	const fetchImpl = deps.fetch ?? fetch;
	try {
		const request = await parseWithMateMemoryCliArgs(args, deps);
		if (request.command === "help") {
			stdout.write(WITHMATE_MEMORY_CLI_HELP);
			return WITHMATE_MEMORY_CLI_EXIT_CODES.ok;
		}
		if (request.command === "schema") {
			stdout.write(`${JSON.stringify(buildSchemaResponse())}\n`);
			return WITHMATE_MEMORY_CLI_EXIT_CODES.ok;
		}
		if (request.command === "validate") {
			const result = buildValidateResponse(request.validateCommand, request.body);
			stdout.write(`${JSON.stringify(result.response)}\n`);
			return result.exitCode;
		}
		const connection = await discoverWithMateMemoryApi({
			env: deps.env,
			apiUrl: request.apiUrl,
			discoveryFilePath: request.discoveryFilePath,
			readFile: deps.readFile
		});
		if (!connection) {
			stdout.write(`${JSON.stringify(notRunningError())}\n`);
			return WITHMATE_MEMORY_CLI_EXIT_CODES.notRunning;
		}
		try {
			const verifyAbortController = new AbortController();
			const verifyTimeout = setTimeout(() => verifyAbortController.abort(), deps.requestTimeoutMs ?? 1e4);
			try {
				if (!await verifyRuntimeIdentity(connection, fetchImpl, verifyAbortController.signal)) {
					stdout.write(`${JSON.stringify(notRunningError())}\n`);
					return WITHMATE_MEMORY_CLI_EXIT_CODES.notRunning;
				}
			} finally {
				clearTimeout(verifyTimeout);
			}
		} catch (error) {
			if (isMemoryErrorResponse(error)) throw error;
			stdout.write(`${JSON.stringify(notRunningError())}\n`);
			return WITHMATE_MEMORY_CLI_EXIT_CODES.notRunning;
		}
		const route = routeByCommand[request.command];
		let response;
		let responseJson;
		const operationTimeoutMs = resolveRuntimeRequestTimeoutMs(request.command, deps);
		const abortController = new AbortController();
		const requestTimeout = setTimeout(() => abortController.abort(), operationTimeoutMs);
		try {
			const headers = {};
			if (route.method === "POST") headers["Content-Type"] = "application/json";
			if (connection.apiSecret) headers[WITHMATE_MEMORY_API_SECRET_HEADER] = connection.apiSecret;
			response = await fetchImpl(`${connection.baseUrl}${buildRoutePath(request)}`, {
				method: route.method,
				headers: Object.keys(headers).length > 0 ? headers : void 0,
				body: route.method === "POST" ? JSON.stringify(request.body) : void 0,
				redirect: "error",
				signal: abortController.signal
			});
			responseJson = await readJsonResponse(response);
		} catch (error) {
			if (isMemoryErrorResponse(error)) throw error;
			if (isAbortError(error)) {
				stdout.write(`${JSON.stringify(requestTimeoutError(request.command, operationTimeoutMs))}\n`);
				return WITHMATE_MEMORY_CLI_EXIT_CODES.apiError;
			}
			stdout.write(`${JSON.stringify(notRunningError())}\n`);
			return WITHMATE_MEMORY_CLI_EXIT_CODES.notRunning;
		} finally {
			clearTimeout(requestTimeout);
		}
		stdout.write(`${JSON.stringify(responseJson)}\n`);
		return response.ok ? WITHMATE_MEMORY_CLI_EXIT_CODES.ok : WITHMATE_MEMORY_CLI_EXIT_CODES.apiError;
	} catch (error) {
		const response = isMemoryErrorResponse(error) ? error : transportError(error instanceof Error ? error.message : "Memory CLI request failed.");
		stdout.write(`${JSON.stringify(response)}\n`);
		if (!isMemoryErrorResponse(error)) stderr.write("withmate-memory transport failed\n");
		if (!isMemoryErrorResponse(error)) return WITHMATE_MEMORY_CLI_EXIT_CODES.transportError;
		return error.error.code === "WITHMATE_MEMORY_CLI_USAGE" ? WITHMATE_MEMORY_CLI_EXIT_CODES.usage : WITHMATE_MEMORY_CLI_EXIT_CODES.transportError;
	}
}
function isMemoryErrorResponse(value) {
	return typeof value === "object" && value !== null && "error" in value;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runWithMateMemoryCli(process.argv.slice(2));
//#endregion
export { DEFAULT_FILE_OPERATION_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, WITHMATE_MEMORY_CLI_EXIT_CODES, WITHMATE_MEMORY_DISCOVERY_FILE_NAME, WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION, discoverWithMateMemoryApi, parseWithMateMemoryCliArgs, resolveRuntimeRequestTimeoutMs, runWithMateMemoryCli };

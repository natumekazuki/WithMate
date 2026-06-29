#!/usr/bin/env node
import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const schemaVersion = "withmate-memory-v1";
const discoverySchemaVersion = "withmate-memory-discovery-v1";
const discoveryFileName = "memory-v6-api.json";
const apiSecretHeader = "x-withmate-memory-api-secret";
const bindingReferenceHeader = "x-withmate-memory-binding-reference";
const bindingReferenceEnv = "WITHMATE_MEMORY_BINDING_REFERENCE";
const entryKinds = [
  "decision",
  "constraint",
  "convention",
  "context",
  "deferred",
  "preference",
  "relationship",
  "boundary",
  "note",
];
const forgetReasons = ["user_request", "incorrect", "outdated", "privacy", "other"];

const exitCodes = {
  ok: 0,
  usage: 1,
  notRunning: 2,
  apiError: 3,
  transportError: 4,
};

const commands = new Map([
  ["status", { name: "status", method: "GET", path: "/v1/status", defaultBody: {} }],
  ["context", { name: "context", method: "POST", path: "/v1/context", defaultBody: { schemaVersion } }],
  ["resolve-context", { name: "context", method: "POST", path: "/v1/context", defaultBody: { schemaVersion } }],
  ["search", { name: "search", method: "POST", path: "/v1/search", defaultBody: {} }],
  ["get-entry", { name: "get_entry", method: "POST", path: "/v1/get_entry", defaultBody: {} }],
  ["get_entry", { name: "get_entry", method: "POST", path: "/v1/get_entry", defaultBody: {} }],
  ["list-tags", { name: "list_tags", method: "POST", path: "/v1/list_tags", defaultBody: {} }],
  ["list_tags", { name: "list_tags", method: "POST", path: "/v1/list_tags", defaultBody: {} }],
  ["append", { name: "append", method: "POST", path: "/v1/append", defaultBody: {} }],
  ["forget", { name: "forget", method: "POST", path: "/v1/forget", defaultBody: {} }],
  ["schema", { name: "schema", local: true, defaultBody: {} }],
  ["capabilities", { name: "schema", local: true, defaultBody: {} }],
  ["validate", { name: "validate", local: true, defaultBody: {} }],
]);
const validatableCommands = new Set(["context", "search", "get_entry", "list_tags", "append", "forget"]);

function memoryError(code, message) {
  return { schemaVersion, error: { code, message } };
}

function usage(message) {
  return memoryError("WITHMATE_MEMORY_CLI_USAGE", message);
}

function notRunning() {
  return memoryError("WITHMATE_NOT_RUNNING", "WithMate Memory API is not running or could not be discovered.");
}

function normalizeLoopbackUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:") {
      return null;
    }
    if (url.hostname !== "127.0.0.1" && url.hostname !== "::1" && url.hostname !== "localhost") {
      return null;
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function defaultRuntimeDirectory() {
  const ownerSegment = typeof process.getuid === "function" ? `uid-${process.getuid()}` : "local-user";
  return path.join(os.tmpdir(), "withmate-memory", ownerSegment);
}

async function readDiscovery(options) {
  if (options.apiUrl !== undefined) {
    const baseUrl = normalizeLoopbackUrl(options.apiUrl);
    if (!baseUrl) {
      throw usage("--api-url must be a valid loopback HTTP URL.");
    }
    return {
      baseUrl,
      apiSecret: process.env.WITHMATE_MEMORY_API_SECRET?.trim() || undefined,
      runtimeInstanceId: process.env.WITHMATE_MEMORY_RUNTIME_INSTANCE_ID?.trim() || undefined,
    };
  }

  const envUrl = process.env.WITHMATE_MEMORY_API_URL?.trim();
  if (envUrl) {
    const baseUrl = normalizeLoopbackUrl(envUrl);
    if (!baseUrl) {
      throw usage("WITHMATE_MEMORY_API_URL must be a valid loopback HTTP URL.");
    }
    return {
      baseUrl,
      apiSecret: process.env.WITHMATE_MEMORY_API_SECRET?.trim() || undefined,
      runtimeInstanceId: process.env.WITHMATE_MEMORY_RUNTIME_INSTANCE_ID?.trim() || undefined,
    };
  }

  const discoveryPath = options.discoveryFilePath
    || process.env.WITHMATE_MEMORY_DISCOVERY_FILE?.trim()
    || path.join(process.env.WITHMATE_MEMORY_RUNTIME_DIR?.trim() || defaultRuntimeDirectory(), discoveryFileName);
  try {
    const document = JSON.parse(await readFile(discoveryPath, "utf8"));
    if (document.schemaVersion !== discoverySchemaVersion || typeof document.baseUrl !== "string") {
      return null;
    }
    const baseUrl = normalizeLoopbackUrl(document.baseUrl);
    if (!baseUrl) {
      return null;
    }
    return {
      baseUrl,
      apiSecret: typeof document.apiSecret === "string" ? document.apiSecret.trim() || undefined : undefined,
      runtimeInstanceId: typeof document.runtimeInstanceId === "string" ? document.runtimeInstanceId.trim() || undefined : undefined,
    };
  } catch {
    return null;
  }
}

async function parseArgs(argv) {
  const [rawCommand, ...rest] = argv;
  const route = rawCommand ? commands.get(rawCommand) : undefined;
  if (!route) {
    throw usage("Usage: withmate-memory <status|context|search|get-entry|list-tags|append|forget|schema|validate> [--json <json> | --file <path> | @file | --stdin] [--command <command>] [--project <path> | --project-id <id>] [--query <text>] [--tag <tag> | --tags <tags>] [--entry-id <id>] [--limit <n>] [--api-url <url>] [--discovery-file <path>]");
  }

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
  let limit;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") {
      jsonInput = requireOptionValue(rest, ++index, arg);
    } else if (arg === "--file") {
      filePath = requireOptionValue(rest, ++index, arg);
    } else if (arg === "--stdin") {
      stdinRequested = true;
    } else if (arg.startsWith("@") && arg.length > 1) {
      filePath = arg.slice(1);
    } else if (arg === "--api-url") {
      apiUrl = requireOptionValue(rest, ++index, arg);
    } else if (arg === "--discovery-file") {
      discoveryFilePath = requireOptionValue(rest, ++index, arg);
    } else if (arg === "--command") {
      validateCommand = normalizeValidatableCommand(requireOptionValue(rest, ++index, arg));
      if (!validateCommand) {
        throw usage(`--command must be one of: ${Array.from(validatableCommands).join(", ")}.`);
      }
    } else if (arg === "--project") {
      projectPath = requireOptionValue(rest, ++index, arg);
    } else if (arg === "--project-id") {
      projectId = requireOptionValue(rest, ++index, arg);
    } else if (arg === "--query") {
      query = requireOptionValue(rest, ++index, arg);
    } else if (arg === "--tag") {
      tagOptions.push(requireOptionValue(rest, ++index, arg));
    } else if (arg === "--tags") {
      tagOptions.push(...parseTagsOption(requireOptionValue(rest, ++index, arg)));
    } else if (arg === "--entry-id") {
      entryId = requireOptionValue(rest, ++index, arg);
    } else if (arg === "--limit") {
      limit = parseLimit(requireOptionValue(rest, ++index, arg));
    } else {
      throw usage(`Unknown option: ${arg}`);
    }
  }
  const bodyInputCount = [jsonInput !== null, filePath !== null, stdinRequested].filter(Boolean).length;
  if (bodyInputCount > 1) {
    throw usage("--json, --file, @file, and --stdin cannot be used together.");
  }
  if (projectPath && projectId) {
    throw usage("--project and --project-id cannot be used together.");
  }
  if (route.name === "validate" && !validateCommand) {
    throw usage("validate requires --command <context|search|get-entry|list-tags|append|forget>.");
  }

  let body = route.defaultBody;
  if (route.method === "POST" || route.name === "validate") {
    if (jsonInput !== null) {
      body = parseJson(jsonInput);
    } else if (filePath !== null) {
      body = parseJson(await readFile(filePath, "utf8"));
    } else if (stdinRequested) {
      body = parseJson(await readStdin(process.stdin));
    } else if (hasShorthandOptions({ projectPath, projectId, query, tags: tagOptions, entryId, limit })) {
      body = buildShorthandBody(route.name, { projectPath, projectId, query, tags: tagOptions, entryId, limit });
    }
  }
  return { route, body, apiUrl, discoveryFilePath, validateCommand };
}

function normalizeValidatableCommand(value) {
  const command = commands.get(value)?.name;
  return validatableCommands.has(command) ? command : undefined;
}

function parseLimit(value) {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw usage("--limit must be a positive integer.");
  }
  return limit;
}

function parseTagsOption(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeCliTagOptions(values) {
  const tags = [];
  const seen = new Set();
  for (const rawValue of values) {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      continue;
    }
    const separatorIndex = trimmed.indexOf(":");
    const type = separatorIndex > 0 ? trimmed.slice(0, separatorIndex).trim() : "topic";
    const value = separatorIndex > 0 ? trimmed.slice(separatorIndex + 1).trim() : trimmed;
    if (!type || !value) {
      throw usage("--tag and --tags values must be <tag> or <type>:<tag>.");
    }
    const key = `${type.normalize("NFC").toLowerCase()}\0${value.normalize("NFC").toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    tags.push({ type, value });
  }
  return tags;
}

function hasShorthandOptions(options) {
  return Boolean(options.projectPath || options.projectId || options.query || (options.tags && options.tags.length > 0) || options.entryId || options.limit !== undefined);
}

function buildProjectTarget(options) {
  if (options.projectId) {
    return { owner: "project", scope: "project", project: { type: "id", id: options.projectId } };
  }
  if (options.projectPath) {
    return { owner: "project", scope: "project", project: { type: "path", path: options.projectPath } };
  }
  return null;
}

function buildShorthandBody(command, options) {
  const target = buildProjectTarget(options);
  if (command === "search") {
    if (!target) {
      throw usage("search shorthand requires --project <path> or --project-id <id>.");
    }
    const tags = normalizeCliTagOptions(options.tags || []);
    const query = options.query || tags.map((tag) => tag.value).join(" ");
    if (!query) {
      throw usage("search shorthand requires --query <text> or --tag <tag>.");
    }
    return {
      schemaVersion,
      targets: [target],
      query,
      ...(tags.length > 0 ? { tags } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    };
  }
  if (command === "list_tags") {
    if (!target) {
      throw usage("list-tags shorthand requires --project <path> or --project-id <id>.");
    }
    return { schemaVersion, targets: [target] };
  }
  if (command === "get_entry") {
    if (!options.entryId) {
      throw usage("get-entry shorthand requires --entry-id <id>.");
    }
    return {
      schemaVersion,
      entryId: options.entryId,
      ...(target ? { target } : {}),
    };
  }
  throw usage(`${command} does not support shorthand options. Use --json, --file, @file, or --stdin.`);
}

async function readStdin(stdin) {
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normalizeProjectPathTargets(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeProjectPathTargets(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const normalized = {};
  for (const [key, item] of Object.entries(value)) {
    normalized[key] = normalizeProjectPathTargets(item);
  }

  if (value.type === "path" && typeof value.path === "string") {
    normalized.path = path.resolve(value.path);
  }
  return normalized;
}

function requireOptionValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw usage(`${option} requires a value.`);
  }
  return value;
}

function parseJson(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw usage("Request JSON must be valid JSON. If shell quoting changed the JSON, retry with --file <path> or --stdin.");
  }
}

function buildSchemaResponse() {
  return {
    schemaVersion,
    entryKinds,
    forgetReasons,
    commands: ["status", "context", "search", "get-entry", "list-tags", "append", "forget", "schema", "validate"],
    requestBodyInputs: ["--json", "--file", "@file", "--stdin"],
    targetSelectors: [
      {
        owner: "project",
        scope: "project",
        requiredFields: ["project"],
        projectTypes: ["id", "path", "alias"],
      },
      {
        owner: "character",
        scope: "character",
        requiredFields: ["character"],
        characterTypes: ["id", "current"],
      },
      {
        owner: "character",
        scope: "project",
        requiredFields: ["character", "project"],
        characterTypes: ["id", "current"],
        projectTypes: ["id", "path", "alias"],
      },
      {
        owner: "user",
        scope: "global",
        requiredFields: [],
      },
    ],
  };
}

const entryKindSet = new Set(entryKinds);
const forgetReasonSet = new Set(forgetReasons);
const resolveContextRequestKeys = new Set(["schemaVersion"]);
const searchRequestKeys = new Set(["schemaVersion", "targets", "query", "kinds", "tags", "limit", "cursor"]);
const getEntryRequestKeys = new Set(["schemaVersion", "entryId", "target"]);
const listTagsRequestKeys = new Set(["schemaVersion", "targets"]);
const appendRequestKeys = new Set([
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
const forgetRequestKeys = new Set(["schemaVersion", "target", "entryIds", "reason", "sourceMessageId", "idempotencyKey"]);
const projectTargetIdKeys = new Set(["type", "id"]);
const projectTargetPathKeys = new Set(["type", "path"]);
const projectTargetAliasKeys = new Set(["type", "alias"]);
const characterTargetIdKeys = new Set(["type", "id"]);
const characterTargetCurrentKeys = new Set(["type"]);
const memoryTagKeys = new Set(["type", "value"]);
const projectProjectTargetKeys = new Set(["owner", "scope", "project"]);
const characterCharacterTargetKeys = new Set(["owner", "scope", "character"]);
const characterProjectTargetKeys = new Set(["owner", "scope", "character", "project"]);
const userGlobalTargetKeys = new Set(["owner", "scope"]);

const maxSearchQueryLength = 500;
const maxTitleLength = 160;
const maxPreviewLength = 280;
const maxBodyLength = 8_000;
const maxTagTypeLength = 48;
const maxTagValueLength = 96;
const maxIdLength = 200;
const maxCursorLength = 500;
const maxLimit = 50;
const maxTags = 20;
const maxSupersedes = 20;
const maxForgetEntryIds = 50;
const maxTargets = 5;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validationError(code, message, field) {
  return { ok: false, error: field ? { code, message, field } : { code, message } };
}

function rejectUnknownKeys(value, allowedKeys, field) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      return validationError("MEMORY_UNKNOWN_FIELD", `Unknown field: ${field}.${key}`, `${field}.${key}`);
    }
  }
  return { ok: true, value: undefined };
}

function hasUnpairedSurrogate(value) {
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

function normalizeText(value, field, options) {
  if (typeof value !== "string") {
    if (options.required === false && value === undefined) {
      return { ok: true, value: "" };
    }
    return validationError("MEMORY_INVALID_FIELD", `${field} must be a string.`, field);
  }
  if (value.includes("\0")) {
    return validationError("MEMORY_INVALID_FIELD", `${field} must not contain null bytes.`, field);
  }
  if (hasUnpairedSurrogate(value)) {
    return validationError("MEMORY_INVALID_FIELD", `${field} must be well-formed Unicode.`, field);
  }
  const normalized = value.trim();
  if (options.required !== false && normalized.length === 0) {
    return validationError("MEMORY_INVALID_FIELD", `${field} must not be empty.`, field);
  }
  if (normalized.length > options.maxLength) {
    return validationError("MEMORY_FIELD_TOO_LARGE", `${field} is too long.`, field);
  }
  return { ok: true, value: normalized };
}

function normalizeOptionalText(value, field, maxLength = maxIdLength) {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  return normalizeText(value, field, { maxLength });
}

function validateSchemaVersion(value) {
  if (value.schemaVersion !== schemaVersion) {
    return validationError("MEMORY_INVALID_SCHEMA_VERSION", "Unsupported memory schemaVersion.", "schemaVersion");
  }
  return { ok: true, value: undefined };
}

function normalizeStringArray(value, field, options) {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(value)) {
    return validationError("MEMORY_INVALID_FIELD", `${field} must be an array.`, field);
  }
  if (value.length > options.maxItems) {
    return validationError("MEMORY_FIELD_TOO_LARGE", `${field} has too many items.`, field);
  }
  const normalized = [];
  const seen = new Set();
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

function validateMemoryKind(value, field) {
  if (typeof value !== "string" || !entryKindSet.has(value)) {
    return validationError("MEMORY_INVALID_FIELD", `${field} must be a valid memory kind.`, field);
  }
  return { ok: true, value };
}

function normalizeProjectTarget(value, field) {
  if (!isRecord(value)) {
    return validationError("MEMORY_INVALID_FIELD", `${field} must be an object.`, field);
  }
  if (value.type === "id") {
    const unknownKeys = rejectUnknownKeys(value, projectTargetIdKeys, field);
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const id = normalizeText(value.id, `${field}.id`, { maxLength: maxIdLength });
    return id.ok ? { ok: true, value: { type: "id", id: id.value } } : id;
  }
  if (value.type === "path") {
    const unknownKeys = rejectUnknownKeys(value, projectTargetPathKeys, field);
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const projectPath = normalizeText(value.path, `${field}.path`, { maxLength: 1_000 });
    return projectPath.ok ? { ok: true, value: { type: "path", path: projectPath.value } } : projectPath;
  }
  if (value.type === "alias") {
    const unknownKeys = rejectUnknownKeys(value, projectTargetAliasKeys, field);
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const alias = normalizeText(value.alias, `${field}.alias`, { maxLength: maxIdLength });
    return alias.ok ? { ok: true, value: { type: "alias", alias: alias.value } } : alias;
  }
  return validationError("MEMORY_INVALID_FIELD", `${field}.type must be id, path, or alias.`, `${field}.type`);
}

function normalizeCharacterTarget(value, field) {
  if (!isRecord(value)) {
    return validationError("MEMORY_INVALID_FIELD", `${field} must be an object.`, field);
  }
  if (value.type === "current") {
    const unknownKeys = rejectUnknownKeys(value, characterTargetCurrentKeys, field);
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    return { ok: true, value: { type: "current" } };
  }
  if (value.type === "id") {
    const unknownKeys = rejectUnknownKeys(value, characterTargetIdKeys, field);
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const id = normalizeText(value.id, `${field}.id`, { maxLength: maxIdLength });
    return id.ok ? { ok: true, value: { type: "id", id: id.value } } : id;
  }
  return validationError("MEMORY_INVALID_FIELD", `${field}.type must be id or current.`, `${field}.type`);
}

function normalizeMemoryTarget(value, field) {
  if (!isRecord(value)) {
    return validationError("MEMORY_INVALID_FIELD", `${field} must be an object.`, field);
  }
  if (value.owner === "user" && value.scope === "global") {
    const unknownKeys = rejectUnknownKeys(value, userGlobalTargetKeys, field);
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    return { ok: true, value: { owner: "user", scope: "global" } };
  }
  if (value.owner === "project" && value.scope === "project") {
    const unknownKeys = rejectUnknownKeys(value, projectProjectTargetKeys, field);
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const project = normalizeProjectTarget(value.project, `${field}.project`);
    return project.ok ? { ok: true, value: { owner: "project", scope: "project", project: project.value } } : project;
  }
  if (value.owner === "character" && value.scope === "character") {
    const unknownKeys = rejectUnknownKeys(value, characterCharacterTargetKeys, field);
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const character = normalizeCharacterTarget(value.character, `${field}.character`);
    return character.ok ? { ok: true, value: { owner: "character", scope: "character", character: character.value } } : character;
  }
  if (value.owner === "character" && value.scope === "project") {
    const unknownKeys = rejectUnknownKeys(value, characterProjectTargetKeys, field);
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
  return validationError("MEMORY_INVALID_TARGET", "Unsupported memory owner / scope combination.", field);
}

function normalizeTargets(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return validationError("MEMORY_TARGET_REQUIRED", "At least one memory target is required.", "targets");
  }
  if (value.length > maxTargets) {
    return validationError("MEMORY_FIELD_TOO_LARGE", `targets supports at most ${maxTargets} items.`, "targets");
  }
  const normalized = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const target = normalizeMemoryTarget(value[index], `targets[${index}]`);
    if (!target.ok) {
      return target;
    }
    const key = JSON.stringify(target.value);
    if (seen.has(key)) {
      return validationError("MEMORY_DUPLICATE_TARGET", "targets must not contain duplicates.", `targets[${index}]`);
    }
    seen.add(key);
    normalized.push(target.value);
  }
  return { ok: true, value: normalized };
}

function normalizeTags(value, field = "tags", options = {}) {
  if (value === undefined) {
    if (options.required) {
      return validationError("MEMORY_INVALID_FIELD", `${field} is required.`, field);
    }
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value)) {
    return validationError("MEMORY_INVALID_FIELD", `${field} must be an array.`, field);
  }
  if (value.length > maxTags) {
    return validationError("MEMORY_FIELD_TOO_LARGE", `${field} has too many items.`, field);
  }
  const normalized = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const tag = value[index];
    if (!isRecord(tag)) {
      return validationError("MEMORY_INVALID_FIELD", `${field}[${index}] must be an object.`, `${field}[${index}]`);
    }
    const unknownKeys = rejectUnknownKeys(tag, memoryTagKeys, `${field}[${index}]`);
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const type = normalizeText(tag.type, `${field}[${index}].type`, { maxLength: maxTagTypeLength });
    if (!type.ok) {
      return type;
    }
    const tagValue = normalizeText(tag.value, `${field}[${index}].value`, { maxLength: maxTagValueLength });
    if (!tagValue.ok) {
      return tagValue;
    }
    const canonicalType = type.value.normalize("NFC").toLowerCase();
    const canonicalValue = tagValue.value.normalize("NFC").toLowerCase();
    const key = `${canonicalType}\0${canonicalValue}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({ type: type.value, value: tagValue.value, canonicalType, canonicalValue });
  }
  return { ok: true, value: normalized };
}

function normalizeKinds(value) {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(value)) {
    return validationError("MEMORY_INVALID_FIELD", "kinds must be an array.", "kinds");
  }
  if (value.length > entryKinds.length) {
    return validationError("MEMORY_FIELD_TOO_LARGE", "kinds has too many items.", "kinds");
  }
  const normalized = [];
  const seen = new Set();
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

function validateRequest(command, body) {
  if (!isRecord(body)) {
    const label = command === "get_entry" ? "Get entry"
      : command === "list_tags" ? "List tags"
        : command === "context" ? "Resolve context"
          : command[0].toUpperCase() + command.slice(1);
    return validationError("MEMORY_INVALID_REQUEST", `${label} request must be an object.`);
  }
  if (command === "context") {
    const unknownKeys = rejectUnknownKeys(body, resolveContextRequestKeys, "request");
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const schema = validateSchemaVersion(body);
    if (!schema.ok) {
      return schema;
    }
    return { ok: true, value: { schemaVersion } };
  }
  if (command === "search") {
    const unknownKeys = rejectUnknownKeys(body, searchRequestKeys, "request");
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const schema = validateSchemaVersion(body);
    if (!schema.ok) {
      return schema;
    }
    const targets = normalizeTargets(body.targets);
    if (!targets.ok) {
      return targets;
    }
    const query = normalizeText(body.query, "query", { maxLength: maxSearchQueryLength });
    if (!query.ok) {
      return query;
    }
    const kinds = normalizeKinds(body.kinds);
    if (!kinds.ok) {
      return kinds;
    }
    const tags = normalizeTags(body.tags);
    if (!tags.ok) {
      return tags;
    }
    const cursor = normalizeOptionalText(body.cursor, "cursor", maxCursorLength);
    if (!cursor.ok) {
      return cursor;
    }
    let limit;
    if (body.limit !== undefined) {
      if (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > maxLimit) {
        return validationError("MEMORY_INVALID_FIELD", `limit must be an integer from 1 to ${maxLimit}.`, "limit");
      }
      limit = body.limit;
    }
    return {
      ok: true,
      value: {
        schemaVersion,
        targets: targets.value,
        query: query.value,
        ...(kinds.value ? { kinds: kinds.value } : {}),
        ...(tags.value.length > 0 ? { tags: tags.value } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(cursor.value !== undefined ? { cursor: cursor.value } : {}),
      },
    };
  }
  if (command === "get_entry") {
    const unknownKeys = rejectUnknownKeys(body, getEntryRequestKeys, "request");
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const schema = validateSchemaVersion(body);
    if (!schema.ok) {
      return schema;
    }
    const entryId = normalizeText(body.entryId, "entryId", { maxLength: maxIdLength });
    if (!entryId.ok) {
      return entryId;
    }
    const target = body.target === undefined ? undefined : normalizeMemoryTarget(body.target, "target");
    if (target && !target.ok) {
      return target;
    }
    return {
      ok: true,
      value: {
        schemaVersion,
        entryId: entryId.value,
        ...(target ? { target: target.value } : {}),
      },
    };
  }
  if (command === "list_tags") {
    const unknownKeys = rejectUnknownKeys(body, listTagsRequestKeys, "request");
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const schema = validateSchemaVersion(body);
    if (!schema.ok) {
      return schema;
    }
    const targets = normalizeTargets(body.targets);
    if (!targets.ok) {
      return targets;
    }
    return { ok: true, value: { schemaVersion, targets: targets.value } };
  }
  if (command === "append") {
    const unknownKeys = rejectUnknownKeys(body, appendRequestKeys, "request");
    if (!unknownKeys.ok) {
      return unknownKeys;
    }
    const schema = validateSchemaVersion(body);
    if (!schema.ok) {
      return schema;
    }
    const target = normalizeMemoryTarget(body.target, "target");
    if (!target.ok) {
      return target;
    }
    const kind = validateMemoryKind(body.kind, "kind");
    if (!kind.ok) {
      return kind;
    }
    const title = normalizeText(body.title, "title", { maxLength: maxTitleLength });
    if (!title.ok) {
      return title;
    }
    const requestBody = normalizeText(body.body, "body", { maxLength: maxBodyLength });
    if (!requestBody.ok) {
      return requestBody;
    }
    const preview = normalizeText(body.preview, "preview", { maxLength: maxPreviewLength });
    if (!preview.ok) {
      return preview;
    }
    const tags = normalizeTags(body.tags, "tags", { required: true });
    if (!tags.ok) {
      return tags;
    }
    const supersedes = normalizeStringArray(body.supersedes, "supersedes", { maxItems: maxSupersedes, maxLength: maxIdLength });
    if (!supersedes.ok) {
      return supersedes;
    }
    const sourceMessageId = normalizeOptionalText(body.sourceMessageId, "sourceMessageId");
    if (!sourceMessageId.ok) {
      return sourceMessageId;
    }
    const idempotencyKey = normalizeOptionalText(body.idempotencyKey, "idempotencyKey");
    if (!idempotencyKey.ok) {
      return idempotencyKey;
    }
    return {
      ok: true,
      value: {
        schemaVersion,
        target: target.value,
        kind: kind.value,
        title: title.value,
        body: requestBody.value,
        preview: preview.value,
        tags: tags.value,
        ...(supersedes.value && supersedes.value.length > 0 ? { supersedes: supersedes.value } : {}),
        ...(sourceMessageId.value !== undefined ? { sourceMessageId: sourceMessageId.value } : {}),
        ...(idempotencyKey.value !== undefined ? { idempotencyKey: idempotencyKey.value } : {}),
      },
    };
  }
  const unknownKeys = rejectUnknownKeys(body, forgetRequestKeys, "request");
  if (!unknownKeys.ok) {
    return unknownKeys;
  }
  const schema = validateSchemaVersion(body);
  if (!schema.ok) {
    return schema;
  }
  const target = normalizeMemoryTarget(body.target, "target");
  if (!target.ok) {
    return target;
  }
  const entryIds = normalizeStringArray(body.entryIds, "entryIds", { maxItems: maxForgetEntryIds, maxLength: maxIdLength });
  if (!entryIds.ok) {
    return entryIds;
  }
  if (!entryIds.value || entryIds.value.length === 0) {
    return validationError("MEMORY_INVALID_FIELD", "entryIds must not be empty.", "entryIds");
  }
  if (body.reason !== undefined && (typeof body.reason !== "string" || !forgetReasonSet.has(body.reason))) {
    return validationError("MEMORY_INVALID_FIELD", "reason must be a valid forget reason.", "reason");
  }
  const sourceMessageId = normalizeOptionalText(body.sourceMessageId, "sourceMessageId");
  if (!sourceMessageId.ok) {
    return sourceMessageId;
  }
  const idempotencyKey = normalizeOptionalText(body.idempotencyKey, "idempotencyKey");
  if (!idempotencyKey.ok) {
    return idempotencyKey;
  }
  return {
    ok: true,
    value: {
      schemaVersion,
      target: target.value,
      entryIds: entryIds.value,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      ...(sourceMessageId.value !== undefined ? { sourceMessageId: sourceMessageId.value } : {}),
      ...(idempotencyKey.value !== undefined ? { idempotencyKey: idempotencyKey.value } : {}),
    }
  };
}

function buildValidateResponse(command, body) {
  const result = validateRequest(command, body);
  if (!result.ok) {
    return { exitCode: exitCodes.apiError, response: { schemaVersion, error: result.error } };
  }
  return {
    exitCode: exitCodes.ok,
    response: { schemaVersion, valid: true, command, value: result.value },
  };
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw memoryError("WITHMATE_MEMORY_TRANSPORT_ERROR", "Memory API returned a non-JSON response.");
  }
}

async function verifyRuntime(connection, signal) {
  if (!connection.apiSecret || !connection.runtimeInstanceId) {
    return false;
  }
  const nonce = randomBytes(16).toString("base64url");
  const response = await fetch(`${connection.baseUrl}/v1/status?nonce=${encodeURIComponent(nonce)}`, {
    method: "GET",
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    return false;
  }
  const status = await readJsonResponse(response);
  const expected = createHmac("sha256", connection.apiSecret).update(nonce, "utf8").digest("base64url");
  return status.runtimeInstanceId === connection.runtimeInstanceId
    && status.challenge?.nonce === nonce
    && status.challenge?.hmacSha256 === expected;
}

async function main() {
  try {
    const request = await parseArgs(process.argv.slice(2));
    if (request.route.name === "schema") {
      console.log(JSON.stringify(buildSchemaResponse()));
      return exitCodes.ok;
    }
    if (request.route.name === "validate") {
      const result = buildValidateResponse(request.validateCommand, normalizeProjectPathTargets(request.body));
      console.log(JSON.stringify(result.response));
      return result.exitCode;
    }

    const connection = await readDiscovery(request);
    if (!connection) {
      console.log(JSON.stringify(notRunning()));
      return exitCodes.notRunning;
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 10_000);
    try {
      try {
        if (!await verifyRuntime(connection, abortController.signal)) {
          console.log(JSON.stringify(notRunning()));
          return exitCodes.notRunning;
        }
        const headers = {};
        if (request.route.method === "POST") {
          headers["Content-Type"] = "application/json";
        }
        if (connection.apiSecret) {
          headers[apiSecretHeader] = connection.apiSecret;
        }
        const bindingReference = process.env[bindingReferenceEnv]?.trim();
        if (bindingReference) {
          headers[bindingReferenceHeader] = bindingReference;
        }
        const response = await fetch(`${connection.baseUrl}${request.route.path}`, {
          method: request.route.method,
          headers,
          body: request.route.method === "POST" ? JSON.stringify(normalizeProjectPathTargets(request.body)) : undefined,
          redirect: "error",
          signal: abortController.signal,
        });
        console.log(JSON.stringify(await readJsonResponse(response)));
        return response.ok ? exitCodes.ok : exitCodes.apiError;
      } catch (error) {
        if (error && typeof error === "object" && "error" in error) {
          throw error;
        }
        console.log(JSON.stringify(notRunning()));
        return exitCodes.notRunning;
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (error && typeof error === "object" && "error" in error) {
      console.log(JSON.stringify(error));
      return error.error?.code === "WITHMATE_MEMORY_CLI_USAGE" ? exitCodes.usage : exitCodes.transportError;
    }
    console.log(JSON.stringify(memoryError("WITHMATE_MEMORY_TRANSPORT_ERROR", error instanceof Error ? error.message : "Memory CLI request failed.")));
    return exitCodes.transportError;
  }
}

process.exitCode = await main();

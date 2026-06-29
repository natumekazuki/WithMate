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
    throw usage("Usage: withmate-memory <status|context|search|get-entry|list-tags|append|forget|schema|validate> [--json <json> | --file <path> | --stdin] [--api-url <url>] [--discovery-file <path>]");
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
    } else if (hasShorthandOptions({ projectPath, projectId, query, entryId, limit })) {
      body = buildShorthandBody(route.name, { projectPath, projectId, query, entryId, limit });
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

function hasShorthandOptions(options) {
  return Boolean(options.projectPath || options.projectId || options.query || options.entryId || options.limit !== undefined);
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
    if (!options.query) {
      throw usage("search shorthand requires --query <text>.");
    }
    return {
      schemaVersion,
      targets: [target],
      query: options.query,
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
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRequest(command, body) {
  if (!isRecord(body)) {
    return { ok: false, error: { code: "MEMORY_INVALID_REQUEST", message: "Request must be an object." } };
  }
  if (body.schemaVersion !== schemaVersion) {
    return { ok: false, error: { code: "MEMORY_INVALID_SCHEMA_VERSION", message: "Unsupported memory schemaVersion.", field: "schemaVersion" } };
  }
  if (command === "context") {
    return { ok: true, value: { schemaVersion } };
  }
  if (command === "search") {
    if (!Array.isArray(body.targets) || body.targets.length === 0) {
      return { ok: false, error: { code: "MEMORY_TARGET_REQUIRED", message: "At least one memory target is required.", field: "targets" } };
    }
    if (typeof body.query !== "string" || body.query.trim().length === 0) {
      return { ok: false, error: { code: "MEMORY_INVALID_FIELD", message: "query must not be empty.", field: "query" } };
    }
    return { ok: true, value: { ...body, query: body.query.trim() } };
  }
  if (command === "get_entry") {
    if (typeof body.entryId !== "string" || body.entryId.trim().length === 0) {
      return { ok: false, error: { code: "MEMORY_INVALID_FIELD", message: "entryId must not be empty.", field: "entryId" } };
    }
    return { ok: true, value: { ...body, entryId: body.entryId.trim() } };
  }
  if (command === "list_tags") {
    if (!Array.isArray(body.targets) || body.targets.length === 0) {
      return { ok: false, error: { code: "MEMORY_TARGET_REQUIRED", message: "At least one memory target is required.", field: "targets" } };
    }
    return { ok: true, value: body };
  }
  if (command === "append") {
    if (!entryKinds.includes(body.kind)) {
      return { ok: false, error: { code: "MEMORY_INVALID_FIELD", message: "kind must be a valid memory kind.", field: "kind" } };
    }
    for (const field of ["target", "title", "body", "preview", "tags"]) {
      if (body[field] === undefined) {
        return { ok: false, error: { code: "MEMORY_INVALID_FIELD", message: `${field} is required.`, field } };
      }
    }
    if (!Array.isArray(body.tags)) {
      return { ok: false, error: { code: "MEMORY_INVALID_FIELD", message: "tags must be an array.", field: "tags" } };
    }
    return { ok: true, value: body };
  }
  if (!Array.isArray(body.entryIds) || body.entryIds.length === 0) {
    return { ok: false, error: { code: "MEMORY_INVALID_FIELD", message: "entryIds must not be empty.", field: "entryIds" } };
  }
  if (body.reason !== undefined && !forgetReasons.includes(body.reason)) {
    return { ok: false, error: { code: "MEMORY_INVALID_FIELD", message: "reason must be a valid forget reason.", field: "reason" } };
  }
  return { ok: true, value: body };
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

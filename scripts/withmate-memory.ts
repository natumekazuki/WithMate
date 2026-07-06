import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  MEMORY_ENTRY_KINDS,
  MEMORY_FORGET_REASONS,
  MEMORY_V6_SCHEMA_VERSION,
  type MemoryValidationResult,
} from "../src/memory-v6/memory-contract.js";
import {
  normalizeWithMateMemoryApiBaseUrl,
  resolveDefaultWithMateMemoryDiscoveryFilePath,
  WITHMATE_MEMORY_DISCOVERY_FILE_NAME,
  WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
  type WithMateMemoryDiscoveryDocument,
} from "../src/memory-v6/memory-discovery.js";
import { createMemoryErrorResponse, type MemoryErrorResponse } from "../src/memory-v6/memory-response-contract.js";
import {
  validateMemoryAppendRequest,
  validateMemoryExportFilesRequest,
  validateMemoryForgetRequest,
  validateMemoryGetEntryRequest,
  validateMemoryGetFileRequest,
  validateMemoryListTagsRequest,
  validateMemorySearchRequest,
} from "../src/memory-v6/memory-validation.js";

export {
  WITHMATE_MEMORY_DISCOVERY_FILE_NAME,
  WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
};

export const WITHMATE_MEMORY_CLI_EXIT_CODES = {
  ok: 0,
  usage: 1,
  notRunning: 2,
  apiError: 3,
  transportError: 4,
} as const;

export type WithMateMemoryCliCommand =
  | "help"
  | "status"
  | "characters"
  | "file_usage"
  | "search"
  | "get_entry"
  | "get_file"
  | "export_files"
  | "list_tags"
  | "append"
  | "forget"
  | "schema"
  | "validate";

export type WithMateMemoryApiCommand = Exclude<WithMateMemoryCliCommand, "help" | "schema" | "validate">;
export type WithMateMemoryValidatedCommand = Exclude<WithMateMemoryApiCommand, "status" | "characters" | "file_usage">;

export type WithMateMemoryCliRequest = {
  command: WithMateMemoryCliCommand;
  body: unknown;
  validateCommand?: WithMateMemoryValidatedCommand;
  discoveryFilePath?: string;
  apiUrl?: string;
};

export type WithMateMemoryApiConnection = {
  baseUrl: string;
  apiSecret?: string;
  runtimeInstanceId?: string;
};

export type WithMateMemoryCliDeps = {
  env?: NodeJS.ProcessEnv;
  stdin?: NodeJS.ReadStream;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  fetch?: typeof fetch;
  readFile?: typeof readFile;
  requestTimeoutMs?: number;
  fileOperationRequestTimeoutMs?: number;
};

const routeByCommand: Record<WithMateMemoryApiCommand, { method: "GET" | "POST"; path: string }> = {
  status: { method: "GET", path: "/v1/status" },
  characters: { method: "GET", path: "/v1/characters" },
  file_usage: { method: "GET", path: "/v1/file_usage" },
  search: { method: "POST", path: "/v1/search" },
  get_entry: { method: "POST", path: "/v1/get_entry" },
  get_file: { method: "POST", path: "/v1/get_file" },
  export_files: { method: "POST", path: "/v1/export_files" },
  list_tags: { method: "POST", path: "/v1/list_tags" },
  append: { method: "POST", path: "/v1/append" },
  forget: { method: "POST", path: "/v1/forget" },
};

function buildRoutePath(request: WithMateMemoryCliRequest): string {
  const route = routeByCommand[request.command as WithMateMemoryApiCommand];
  if (request.command !== "file_usage" || !request.body || typeof request.body !== "object") {
    return route.path;
  }

  const body = request.body as { largest?: unknown; limit?: unknown };
  const query = new URLSearchParams();
  if (body.largest === true) {
    query.set("largest", "1");
  }
  if (typeof body.limit === "number") {
    query.set("limit", String(body.limit));
  }
  const queryString = query.toString();
  return queryString ? `${route.path}?${queryString}` : route.path;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_FILE_OPERATION_REQUEST_TIMEOUT_MS = 300_000;
const WITHMATE_MEMORY_API_SECRET_HEADER = "x-withmate-memory-api-secret";

const FILE_OPERATION_COMMANDS = new Set<WithMateMemoryApiCommand>([
  "append",
  "get_file",
  "export_files",
]);

const commandAliases = new Map<string, WithMateMemoryCliCommand>([
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
  ["validate", "validate"],
]);

const WITHMATE_MEMORY_CLI_HELP = `Usage:
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

const validatableCommands = new Set<WithMateMemoryValidatedCommand>([
  "search",
  "get_entry",
  "get_file",
  "export_files",
  "list_tags",
  "append",
  "forget",
]);

function usageError(message: string): MemoryErrorResponse {
  return createMemoryErrorResponse({
    code: "WITHMATE_MEMORY_CLI_USAGE",
    message,
  });
}

function notRunningError(): MemoryErrorResponse {
  return createMemoryErrorResponse({
    code: "WITHMATE_NOT_RUNNING",
    message: "WithMate Memory API is not running or could not be discovered.",
  });
}

function requestTimeoutError(command: WithMateMemoryApiCommand, timeoutMs: number): MemoryErrorResponse {
  return createMemoryErrorResponse({
    code: "WITHMATE_MEMORY_REQUEST_TIMEOUT",
    message: `WithMate Memory API request timed out after ${timeoutMs}ms.`,
    field: command,
  });
}

function transportError(message: string): MemoryErrorResponse {
  return createMemoryErrorResponse({
    code: "WITHMATE_MEMORY_TRANSPORT_ERROR",
    message,
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function resolveRuntimeRequestTimeoutMs(
  command: WithMateMemoryApiCommand,
  deps: Pick<WithMateMemoryCliDeps, "requestTimeoutMs" | "fileOperationRequestTimeoutMs"> = {},
): number {
  if (deps.requestTimeoutMs !== undefined) {
    return deps.requestTimeoutMs;
  }
  if (FILE_OPERATION_COMMANDS.has(command)) {
    return deps.fileOperationRequestTimeoutMs ?? DEFAULT_FILE_OPERATION_REQUEST_TIMEOUT_MS;
  }
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

function readEnvSecret(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.WITHMATE_MEMORY_API_SECRET?.trim();
  return value ? value : undefined;
}

function readEnvRuntimeInstanceId(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.WITHMATE_MEMORY_RUNTIME_INSTANCE_ID?.trim();
  return value ? value : undefined;
}

async function readStdin(stdin: NodeJS.ReadStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function parseJsonInput(input: string): Promise<unknown> {
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw usageError("Request JSON must be valid JSON. If shell quoting changed the JSON, retry with --file <path> or --stdin.");
  }
}

function normalizeCommandName(value: string): WithMateMemoryCliCommand | undefined {
  return commandAliases.get(value);
}

function normalizeValidatableCommand(value: string): WithMateMemoryValidatedCommand | undefined {
  const command = normalizeCommandName(value);
  if (command && validatableCommands.has(command as WithMateMemoryValidatedCommand)) {
    return command as WithMateMemoryValidatedCommand;
  }
  return undefined;
}

export async function discoverWithMateMemoryApi(
  options: {
    env?: NodeJS.ProcessEnv;
    apiUrl?: string;
    discoveryFilePath?: string;
    readFile?: typeof readFile;
  } = {},
): Promise<WithMateMemoryApiConnection | null> {
  const env = options.env ?? process.env;
  if (options.apiUrl !== undefined) {
    const explicitUrl = normalizeWithMateMemoryApiBaseUrl(options.apiUrl);
    if (!explicitUrl) {
      throw usageError("--api-url must be a valid loopback HTTP URL.");
    }
    return {
      baseUrl: explicitUrl,
      ...(readEnvSecret(env) ? { apiSecret: readEnvSecret(env) } : {}),
      ...(readEnvRuntimeInstanceId(env) ? { runtimeInstanceId: readEnvRuntimeInstanceId(env) } : {}),
    };
  }

  const rawEnvUrl = env.WITHMATE_MEMORY_API_URL?.trim();
  if (rawEnvUrl) {
    const envUrl = normalizeWithMateMemoryApiBaseUrl(rawEnvUrl);
    if (!envUrl) {
      throw usageError("WITHMATE_MEMORY_API_URL must be a valid loopback HTTP URL.");
    }
    return {
      baseUrl: envUrl,
      ...(readEnvSecret(env) ? { apiSecret: readEnvSecret(env) } : {}),
      ...(readEnvRuntimeInstanceId(env) ? { runtimeInstanceId: readEnvRuntimeInstanceId(env) } : {}),
    };
  }

  const discoveryFilePath = options.discoveryFilePath
    ?? env.WITHMATE_MEMORY_DISCOVERY_FILE?.trim()
    ?? resolveDefaultWithMateMemoryDiscoveryFilePath(env);
  const read = options.readFile ?? readFile;

  try {
    const document = JSON.parse(await read(discoveryFilePath, "utf8")) as Partial<WithMateMemoryDiscoveryDocument>;
    if (document.schemaVersion !== WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION || typeof document.baseUrl !== "string") {
      return null;
    }
    const baseUrl = normalizeWithMateMemoryApiBaseUrl(document.baseUrl);
    if (!baseUrl) {
      return null;
    }
    return {
      baseUrl,
      ...(typeof document.apiSecret === "string" && document.apiSecret.trim()
        ? { apiSecret: document.apiSecret.trim() }
        : {}),
      ...(typeof document.runtimeInstanceId === "string" && document.runtimeInstanceId.trim()
        ? { runtimeInstanceId: document.runtimeInstanceId.trim() }
        : {}),
    };
  } catch {
    return null;
  }
}

export async function parseWithMateMemoryCliArgs(
  args: readonly string[],
  deps: Pick<WithMateMemoryCliDeps, "stdin" | "readFile"> = {},
): Promise<WithMateMemoryCliRequest> {
  const [rawCommand, ...rest] = args;
  if (!rawCommand || rawCommand === "--help" || rawCommand === "-h") {
    return { command: "help", body: {} };
  }
  const command = rawCommand ? commandAliases.get(rawCommand) : undefined;
  if (!command) {
    throw usageError("Usage: withmate-memory <help|status|characters|file-usage|search|get-entry|get-file|export-files|list-tags|append|forget|schema|validate> [--json <json> | --file <path> | @file | --stdin] [--command <command>] [--project <absolute-path> | --project-id <id>] [--query <text>] [--tag <tag> | --tags <tags>] [--entry-id <id>] [--object-id <id>] [--output <path>] [--output-dir <path>] [--limit <n>] [--api-url <url>] [--discovery-file <path>]");
  }
  if (command === "help" || rest.includes("--help") || rest.includes("-h")) {
    return { command: "help", body: {} };
  }

  let jsonInput: string | null = null;
  let filePath: string | null = null;
  let stdinRequested = false;
  let apiUrl: string | undefined;
  let discoveryFilePath: string | undefined;
  let validateCommand: WithMateMemoryValidatedCommand | undefined;
  let projectPath: string | undefined;
  let projectId: string | undefined;
  let query: string | undefined;
  const tagOptions: string[] = [];
  let entryId: string | undefined;
  let objectId: string | undefined;
  let outputPath: string | undefined;
  let outputDirectoryPath: string | undefined;
  let largest = false;
  let limit: number | undefined;

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
      const value = requireOptionValue(rest, ++index, arg);
      validateCommand = normalizeValidatableCommand(value);
      if (!validateCommand) {
        throw usageError(`--command must be one of: ${Array.from(validatableCommands).join(", ")}.`);
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
    } else if (arg === "--object-id") {
      objectId = requireOptionValue(rest, ++index, arg);
    } else if (arg === "--output") {
      outputPath = requireOptionValue(rest, ++index, arg);
    } else if (arg === "--output-dir") {
      outputDirectoryPath = requireOptionValue(rest, ++index, arg);
    } else if (arg === "--largest") {
      largest = true;
    } else if (arg === "--limit") {
      limit = parseLimitOption(requireOptionValue(rest, ++index, arg));
    } else {
      throw usageError(`Unknown option: ${arg}`);
    }
  }

  const bodyInputCount = [jsonInput !== null, filePath !== null, stdinRequested].filter(Boolean).length;
  if (bodyInputCount > 1) {
    throw usageError("--json, --file, @file, and --stdin cannot be used together.");
  }

  if ([Boolean(projectPath), Boolean(projectId)].filter(Boolean).length > 1) {
    throw usageError("--project and --project-id cannot be used together.");
  }

  if (command === "validate" && !validateCommand) {
    throw usageError("validate requires --command <search|get-entry|get-file|export-files|list-tags|append|forget>.");
  }

  let body: unknown = {};
  if (command === "file_usage") {
    if (jsonInput !== null || filePath !== null || stdinRequested) {
      throw usageError("file-usage does not accept JSON body input. Use --largest and --limit.");
    }
    if (hasShorthandOptions({ projectPath, projectId, query, tags: tagOptions, entryId, objectId, outputPath, outputDirectoryPath, largest, limit })) {
      body = buildShorthandBody(command, { projectPath, projectId, query, tags: tagOptions, entryId, objectId, outputPath, outputDirectoryPath, largest, limit });
    }
  } else if (command !== "status" && command !== "characters" && command !== "schema") {
    if (jsonInput !== null) {
      body = await parseJsonInput(jsonInput);
    } else if (filePath !== null) {
      body = await parseJsonInput(await (deps.readFile ?? readFile)(filePath, "utf8"));
    } else if (stdinRequested) {
      if (!deps.stdin) {
        throw usageError("--stdin requires stdin.");
      }
      body = await parseJsonInput(await readStdin(deps.stdin));
    } else if (hasShorthandOptions({ projectPath, projectId, query, tags: tagOptions, entryId, objectId, outputPath, outputDirectoryPath, largest, limit })) {
      body = buildShorthandBody(command, { projectPath, projectId, query, tags: tagOptions, entryId, objectId, outputPath, outputDirectoryPath, largest, limit });
    } else if (deps.stdin && !deps.stdin.isTTY) {
      body = await parseJsonInput(await readStdin(deps.stdin));
    }
  }

  return {
    command,
    body: normalizeProjectPathTargets(body),
    ...(validateCommand ? { validateCommand } : {}),
    ...(apiUrl ? { apiUrl } : {}),
    ...(discoveryFilePath ? { discoveryFilePath } : {}),
  };
}

function parseLimitOption(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw usageError("--limit must be a positive integer.");
  }
  return limit;
}

function parseTagsOption(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeCliTagOptions(values: readonly string[]): Array<{ type: string; value: string }> {
  const tags: Array<{ type: string; value: string }> = [];
  const seen = new Set<string>();
  for (const rawValue of values) {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      continue;
    }
    const separatorIndex = trimmed.indexOf(":");
    const type = separatorIndex > 0 ? trimmed.slice(0, separatorIndex).trim() : "topic";
    const value = separatorIndex > 0 ? trimmed.slice(separatorIndex + 1).trim() : trimmed;
    if (!type || !value) {
      throw usageError("--tag and --tags values must be <tag> or <type>:<tag>.");
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

function hasShorthandOptions(options: {
  projectPath?: string;
  projectId?: string;
  query?: string;
  tags?: readonly string[];
  entryId?: string;
  objectId?: string;
  outputPath?: string;
  outputDirectoryPath?: string;
  largest?: boolean;
  limit?: number;
}): boolean {
  return Boolean(
    options.projectPath
    || options.projectId
    || options.query
    || (options.tags && options.tags.length > 0)
    || options.entryId
    || options.objectId
    || options.outputPath
    || options.outputDirectoryPath
    || options.largest
    || options.limit !== undefined,
  );
}

function isAbsoluteCliPath(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function normalizeCliProjectPath(value: string): string {
  if (!isAbsoluteCliPath(value)) {
    throw usageError("--project requires an absolute path.");
  }
  return path.win32.isAbsolute(value)
    ? path.win32.normalize(value).replace(/\\/g, "/")
    : path.resolve(value);
}

function normalizeCliOutputPath(value: string): string {
  if (!isAbsoluteCliPath(value)) {
    throw usageError("--output requires an absolute path.");
  }
  return path.win32.isAbsolute(value)
    ? path.win32.normalize(value)
    : path.resolve(value);
}

function normalizeCliOutputDirectoryPath(value: string): string {
  if (!isAbsoluteCliPath(value)) {
    throw usageError("--output-dir requires an absolute path.");
  }
  return path.win32.isAbsolute(value)
    ? path.win32.normalize(value)
    : path.resolve(value);
}

function buildProjectTarget(options: { projectPath?: string; projectId?: string }): unknown | null {
  if (options.projectId) {
    return { owner: "project", scope: "project", project: { type: "id", id: options.projectId } };
  }
  if (options.projectPath) {
    return { owner: "project", scope: "project", project: { type: "path", path: normalizeCliProjectPath(options.projectPath) } };
  }
  return null;
}

function buildShorthandBody(
  command: WithMateMemoryCliCommand,
  options: {
    projectPath?: string;
    projectId?: string;
    query?: string;
    tags?: readonly string[];
    entryId?: string;
    objectId?: string;
    outputPath?: string;
    outputDirectoryPath?: string;
    largest?: boolean;
    limit?: number;
  },
): unknown {
  if (command === "validate") {
    throw usageError("validate shorthand options are not supported. Use --json, --file, @file, or --stdin.");
  }

  const target = buildProjectTarget(options);
  if (command === "file_usage") {
    if (target || options.query || (options.tags && options.tags.length > 0) || options.entryId || options.objectId || options.outputPath || options.outputDirectoryPath) {
      throw usageError("file-usage shorthand only supports --largest and --limit.");
    }
    if (options.limit !== undefined && !options.largest) {
      throw usageError("file-usage --limit requires --largest.");
    }
    return {
      ...(options.largest ? { largest: true } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    };
  }

  if (command === "search") {
    if (!target) {
      throw usageError("search shorthand requires --project <absolute-path> or --project-id <id>.");
    }
    const tags = normalizeCliTagOptions(options.tags ?? []);
    const query = options.query ?? tags.map((tag) => tag.value).join(" ");
    if (!query) {
      throw usageError("search shorthand requires --query <text> or --tag <tag>.");
    }
    return {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: [target],
      query,
      ...(tags.length > 0 ? { tags } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    };
  }

  if (command === "list_tags") {
    if (!target) {
      throw usageError("list-tags shorthand requires --project <absolute-path> or --project-id <id>.");
    }
    return {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: [target],
    };
  }

  if (command === "get_entry") {
    if (!options.entryId) {
      throw usageError("get-entry shorthand requires --entry-id <id>.");
    }
    if (!target) {
      throw usageError("get-entry shorthand requires --project <absolute-path> or --project-id <id>.");
    }
    return {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      entryId: options.entryId,
      target,
    };
  }

  if (command === "get_file") {
    if (!options.objectId) {
      throw usageError("get-file shorthand requires --object-id <id>.");
    }
    if (!options.outputPath) {
      throw usageError("get-file shorthand requires --output <absolute-path>.");
    }
    if (!target) {
      throw usageError("get-file shorthand requires --project <absolute-path> or --project-id <id>.");
    }
    return {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target,
      objectId: options.objectId,
      outputPath: normalizeCliOutputPath(options.outputPath),
    };
  }

  if (command === "export_files") {
    if (!options.entryId) {
      throw usageError("export-files shorthand requires --entry-id <id>.");
    }
    if (!options.outputDirectoryPath) {
      throw usageError("export-files shorthand requires --output-dir <absolute-path>.");
    }
    if (!target) {
      throw usageError("export-files shorthand requires --project <absolute-path> or --project-id <id>.");
    }
    return {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target,
      entryId: options.entryId,
      outputDirectoryPath: normalizeCliOutputDirectoryPath(options.outputDirectoryPath),
    };
  }

  throw usageError(`${command} does not support shorthand options. Use --json, --file, @file, or --stdin.`);
}

function normalizeProjectPathTargets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeProjectPathTargets(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    normalized[key] = normalizeProjectPathTargets(item);
  }

  if (record.type === "path" && typeof record.path === "string") {
    normalized.path = normalizeCliProjectPath(record.path);
  }
  return normalized;
}

function requireOptionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw usageError(`${option} requires a value.`);
  }
  return value;
}

function buildSchemaResponse(): unknown {
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
      "validate",
    ],
    requestBodyInputs: ["--json", "--file", "@file", "--stdin"],
    targetSelectors: [
      {
        owner: "project",
        scope: "project",
        requiredFields: ["project"],
        projectTypes: ["id", "path"],
      },
      {
        owner: "character",
        scope: "character",
        requiredFields: ["character"],
        characterTypes: ["id"],
      },
      {
        owner: "character",
        scope: "project",
        requiredFields: ["character", "project"],
        characterTypes: ["id"],
        projectTypes: ["id", "path"],
      },
      {
        owner: "user",
        scope: "global",
        requiredFields: [],
      },
    ],
  };
}

function validateMemoryCliRequestBody(
  command: WithMateMemoryValidatedCommand,
  body: unknown,
): MemoryValidationResult<unknown> {
  if (command === "search") {
    return validateMemorySearchRequest(body);
  }
  if (command === "get_entry") {
    return validateMemoryGetEntryRequest(body);
  }
  if (command === "get_file") {
    return validateMemoryGetFileRequest(body);
  }
  if (command === "export_files") {
    return validateMemoryExportFilesRequest(body);
  }
  if (command === "list_tags") {
    return validateMemoryListTagsRequest(body);
  }
  if (command === "append") {
    return validateMemoryAppendRequest(body);
  }
  return validateMemoryForgetRequest(body);
}

function buildValidateResponse(command: WithMateMemoryValidatedCommand, body: unknown): {
  exitCode: number;
  response: unknown;
} {
  const validation = validateMemoryCliRequestBody(command, body);
  if (!validation.ok) {
    return {
      exitCode: WITHMATE_MEMORY_CLI_EXIT_CODES.apiError,
      response: createMemoryErrorResponse(validation.error),
    };
  }
  return {
    exitCode: WITHMATE_MEMORY_CLI_EXIT_CODES.ok,
    response: {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      valid: true,
      command,
      value: validation.value,
    },
  };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw transportError("Memory API returned a non-JSON response.");
  }
}

function createStatusChallenge(apiSecret: string, nonce: string): string {
  return createHmac("sha256", apiSecret).update(nonce, "utf8").digest("base64url");
}

function hasVerifiableRuntimeIdentity(connection: WithMateMemoryApiConnection): connection is WithMateMemoryApiConnection & {
  apiSecret: string;
  runtimeInstanceId: string;
} {
  return Boolean(connection.apiSecret?.trim() && connection.runtimeInstanceId?.trim());
}

async function verifyRuntimeIdentity(
  connection: WithMateMemoryApiConnection,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<boolean> {
  if (!hasVerifiableRuntimeIdentity(connection)) {
    return false;
  }

  const nonce = randomBytes(16).toString("base64url");
  const response = await fetchImpl(`${connection.baseUrl}/v1/status?nonce=${encodeURIComponent(nonce)}`, {
    method: "GET",
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    return false;
  }

  const status = await readJsonResponse(response) as {
    runtimeInstanceId?: unknown;
    challenge?: { nonce?: unknown; hmacSha256?: unknown };
  };
  return status.runtimeInstanceId === connection.runtimeInstanceId
    && status.challenge?.nonce === nonce
    && status.challenge.hmacSha256 === createStatusChallenge(connection.apiSecret, nonce);
}

export async function runWithMateMemoryCli(
  args: readonly string[],
  deps: WithMateMemoryCliDeps = {},
): Promise<number> {
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
      const result = buildValidateResponse(request.validateCommand!, request.body);
      stdout.write(`${JSON.stringify(result.response)}\n`);
      return result.exitCode;
    }

    const connection = await discoverWithMateMemoryApi({
      env: deps.env,
      apiUrl: request.apiUrl,
      discoveryFilePath: request.discoveryFilePath,
      readFile: deps.readFile,
    });
    if (!connection) {
      stdout.write(`${JSON.stringify(notRunningError())}\n`);
      return WITHMATE_MEMORY_CLI_EXIT_CODES.notRunning;
    }

    try {
      const verifyAbortController = new AbortController();
      const verifyTimeout = setTimeout(() => verifyAbortController.abort(), deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      try {
        if (!await verifyRuntimeIdentity(connection, fetchImpl, verifyAbortController.signal)) {
          stdout.write(`${JSON.stringify(notRunningError())}\n`);
          return WITHMATE_MEMORY_CLI_EXIT_CODES.notRunning;
        }
      } finally {
        clearTimeout(verifyTimeout);
      }
    } catch (error) {
      if (isMemoryErrorResponse(error)) {
        throw error;
      }
      stdout.write(`${JSON.stringify(notRunningError())}\n`);
      return WITHMATE_MEMORY_CLI_EXIT_CODES.notRunning;
    }

    const route = routeByCommand[request.command];
    let response: Response;
    let responseJson: unknown;
    const operationTimeoutMs = resolveRuntimeRequestTimeoutMs(request.command, deps);
    const abortController = new AbortController();
    const requestTimeout = setTimeout(() => abortController.abort(), operationTimeoutMs);
    try {
      const headers: Record<string, string> = {};
      if (route.method === "POST") {
        headers["Content-Type"] = "application/json";
      }
      if (connection.apiSecret) {
        headers[WITHMATE_MEMORY_API_SECRET_HEADER] = connection.apiSecret;
      }
      response = await fetchImpl(`${connection.baseUrl}${buildRoutePath(request)}`, {
        method: route.method,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        body: route.method === "POST" ? JSON.stringify(request.body) : undefined,
        redirect: "error",
        signal: abortController.signal,
      });
      responseJson = await readJsonResponse(response);
    } catch (error) {
      if (isMemoryErrorResponse(error)) {
        throw error;
      }
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
    const response = isMemoryErrorResponse(error)
      ? error
      : transportError(error instanceof Error ? error.message : "Memory CLI request failed.");
    stdout.write(`${JSON.stringify(response)}\n`);
    if (!isMemoryErrorResponse(error)) {
      stderr.write("withmate-memory transport failed\n");
    }
    if (!isMemoryErrorResponse(error)) {
      return WITHMATE_MEMORY_CLI_EXIT_CODES.transportError;
    }
    return error.error.code === "WITHMATE_MEMORY_CLI_USAGE"
      ? WITHMATE_MEMORY_CLI_EXIT_CODES.usage
      : WITHMATE_MEMORY_CLI_EXIT_CODES.transportError;
  }
}

function isMemoryErrorResponse(value: unknown): value is MemoryErrorResponse {
  return typeof value === "object" && value !== null && "error" in value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runWithMateMemoryCli(process.argv.slice(2));
}

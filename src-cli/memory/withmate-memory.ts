import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { WITHMATE_MEMORY_DISCOVERY_FILE_NAME, WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION } from "../../src-electron/platform/memory/memory-discovery.js";
import { createMemoryErrorResponse, type MemoryErrorResponse } from "../../src-shared/memory/memory-response-contract.js";
import { WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV } from "../../src-shared/agent-runtime/agent-runtime-binding-contract.js";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  callWithMateMemoryRuntime,
  discoverWithMateMemoryApi,
  resolveAgentRuntimeBindingReference,
  verifyRuntimeIdentity,
  WITHMATE_MEMORY_API_SECRET_HEADER,
  type WithMateMemoryRuntimeOperation,
  type WithMateMemoryRuntimeResponse,
  type WithMateMemoryRuntimeConnection,
} from "../../src-electron/platform/mcp/withmate-memory-runtime-client.js";
import { isUuid, type RuntimeDiscoveryClock } from "../../src-electron/platform/runtime-discovery/runtime-discovery-contract.js";
import { startWithMateMemoryMcpServer } from "./withmate-memory-mcp.js";
import { createWithMateMemoryPublicTools, validateWithMateMemoryPublicInput, withMateMemoryToolName } from "../../src-electron/platform/mcp/withmate-memory-mcp.js";

export {
  DEFAULT_REQUEST_TIMEOUT_MS,
  discoverWithMateMemoryApi,
  verifyRuntimeIdentity,
  WITHMATE_MEMORY_API_SECRET_HEADER,
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
  | "instances"
  | "status"
  | "characters"
  | "file_usage"
  | "list_targets"
  | "list_entries"
  | "audit"
  | "search"
  | "get_entry"
  | "get_file"
  | "export_files"
  | "list_tags"
  | "append"
  | "forget"
  | "move_entry"
  | "context_get"
  | "affect_appraise"
  | "affect_inspect"
  | "affect_correct"
  | "affect_reset"
  | "character_memory_search"
  | "character_memory_append_episode"
  | "character_memory_correct"
  | "character_memory_forget"
  | "character_metrics"
  | "mcp_server"
  | "schema"
  | "validate";

export type WithMateMemoryApiCommand = Exclude<WithMateMemoryCliCommand, "help" | "instances" | "schema" | "validate" | "mcp_server">;
export type WithMateMemoryValidatedCommand = Exclude<WithMateMemoryCliCommand, "help" | "mcp_server">;

export type WithMateMemoryCliRequest = {
  command: WithMateMemoryCliCommand;
  body: unknown;
  validateCommand?: WithMateMemoryValidatedCommand;
  discoveryFilePath?: string;
  apiUrl?: string;
  applicationInstanceId?: string;
  runtimeGenerationId?: string;
  statusAll?: boolean;
  outputFormat?: "json" | "jsonl" | "markdown";
  fallbackFrom?: "mcp";
};

export type WithMateMemoryCliDeps = {
  env?: NodeJS.ProcessEnv;
  stdin?: NodeJS.ReadStream;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  runtimeCall?: (
    connection: WithMateMemoryRuntimeConnection,
    operation: WithMateMemoryRuntimeOperation,
    options: { signal: AbortSignal; bindingReference?: string; turnCapability?: string },
  ) => Promise<WithMateMemoryRuntimeResponse>;
  readFile?: typeof readFile;
  fetch?: typeof fetch;
  clock?: RuntimeDiscoveryClock;
  registryRootDirectoryPath?: string;
  staleThresholdMs?: number;
  requestTimeoutMs?: number;
  fileOperationRequestTimeoutMs?: number;
};


export const DEFAULT_FILE_OPERATION_REQUEST_TIMEOUT_MS = 300_000;
export const WITHMATE_MEMORY_OPERATOR_API_SECRET_HEADER = "x-withmate-memory-operator-api-secret";

const FILE_OPERATION_COMMANDS = new Set<WithMateMemoryApiCommand>([
  "append",
  "get_file",
  "export_files",
]);

const commandAliases = new Map<string, WithMateMemoryCliCommand>([
  ["help", "help"],
  ["instances", "instances"],
  ["status", "status"],
  ["characters", "characters"],
  ["list-characters", "characters"],
  ["list_characters", "characters"],
  ["file-usage", "file_usage"],
  ["file_usage", "file_usage"],
  ["list-targets", "list_targets"],
  ["list_targets", "list_targets"],
  ["list-entries", "list_entries"],
  ["list_entries", "list_entries"],
  ["audit", "audit"],
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
  ["move-entry", "move_entry"],
  ["move_entry", "move_entry"],
  ["context-get", "context_get"],
  ["context_get", "context_get"],
  ["affect-appraise", "affect_appraise"],
  ["affect_appraise", "affect_appraise"],
  ["affect-inspect", "affect_inspect"],
  ["affect_inspect", "affect_inspect"],
  ["affect-correct", "affect_correct"],
  ["affect_correct", "affect_correct"],
  ["affect-reset", "affect_reset"],
  ["affect_reset", "affect_reset"],
  ["character-memory-search", "character_memory_search"],
  ["character-memory-append-episode", "character_memory_append_episode"],
  ["character-memory-correct", "character_memory_correct"],
  ["character-memory-forget", "character_memory_forget"],
  ["character-metrics", "character_metrics"],
  ["mcp-server", "mcp_server"],
  ["schema", "schema"],
  ["capabilities", "schema"],
  ["validate", "validate"],
]);

const WITHMATE_MEMORY_CLI_HELP = `Usage:
  withmate-memory <command> [options]

Commands:
  help
  instances
  status
  characters
  file-usage
  list-targets
  list-entries
  audit
  search
  get-entry
  get-file
  export-files
  list-tags
  append
  forget
  move-entry
  context-get
  affect-appraise
  affect-inspect
  affect-correct
  affect-reset
  character-memory-search
  character-memory-append-episode
  character-memory-correct
  character-memory-forget
  character-metrics
  mcp-server
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
  --owner <user|project|character>
  --scope <global|project|character>
  --query <text>
  --tag <tag>
  --tags <tags>
  --entry-id <id>
  --object-id <id>
  --output <path>
  --output-dir <path>
  --largest
  --include-empty
  --include-body
  --with-counts
  --sample-limit <n>
  --all-targets
  --dry-run
  --format <json|jsonl|markdown>
  --limit <n>

Connection options:
  --api-url <url>
  --discovery-file <path>
  --instance <application-instance-id>
  --generation <runtime-generation-id>
  --fallback-from <mcp>

Validation:
  validate --command <list-targets|list-entries|audit|search|get-entry|get-file|export-files|list-tags|append|forget|move-entry>

Examples:
  withmate-memory instances
  withmate-memory status --all
  withmate-memory status
  withmate-memory characters
  withmate-memory file-usage
  withmate-memory file-usage --largest --limit 10
  withmate-memory list-targets --include-empty
  withmate-memory list-entries --project C:\\path\\to\\repo --limit 100
  withmate-memory audit --all-targets --format markdown
  withmate-memory search --project C:\\path\\to\\repo --query "release workflow"
  withmate-memory get-file --project C:\\path\\to\\repo --object-id <id> --output C:\\path\\to\\file.bin
  withmate-memory export-files --project C:\\path\\to\\repo --entry-id <id> --output-dir C:\\path\\to\\exports
  withmate-memory validate --command append --stdin
  withmate-memory context-get --stdin
  withmate-memory affect-inspect --stdin
  withmate-memory mcp-server
  withmate-memory schema
`;

const validatableCommands = new Set<WithMateMemoryValidatedCommand>([
  "instances",
  "status",
  "characters",
  "file_usage",
  "character_metrics",
  "schema",
  "validate",
  "list_targets",
  "list_entries",
  "audit",
  "search",
  "get_entry",
  "get_file",
  "export_files",
  "list_tags",
  "append",
  "forget",
  "move_entry",
  "context_get",
  "affect_appraise",
  "affect_inspect",
  "affect_correct",
  "affect_reset",
  "character_memory_search",
  "character_memory_append_episode",
  "character_memory_correct",
  "character_memory_forget",
]);

function usageError(message: string): MemoryErrorResponse {
  return createMemoryErrorResponse({
    code: "WITHMATE_MEMORY_CLI_USAGE",
    message,
    effect: "none",
  });
}


function transportError(message: string): MemoryErrorResponse {
  return createMemoryErrorResponse({
    code: "WITHMATE_MEMORY_TRANSPORT_ERROR",
    message,
    effect: "none",
  });
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
    throw usageError(
      "Usage: withmate-memory <instances|status|characters|file-usage|list-targets|list-entries|audit|search|get-entry|get-file|export-files|list-tags|append|forget|move-entry|context-get|affect-appraise|affect-inspect|affect-correct|affect-reset|character-memory-search|character-memory-append-episode|character-memory-correct|character-memory-forget|character-metrics|mcp-server|schema|validate> [--json <json> | --file <path> | @file | --stdin] [--project <path>] [--tag <tag>] [options]",
    );
  }
  if (command === "help" || rest.includes("--help") || rest.includes("-h")) {
    return { command: "help", body: {} };
  }

  let jsonInput: string | null = null;
  let filePath: string | null = null;
  let stdinRequested = false;
  let apiUrl: string | undefined;
  let discoveryFilePath: string | undefined;
  let applicationInstanceId: string | undefined;
  let runtimeGenerationId: string | undefined;
  let statusAll = false;
  let fallbackFrom: "mcp" | undefined;
  let validateCommand: WithMateMemoryValidatedCommand | undefined;
  let projectPath: string | undefined;
  let projectId: string | undefined;
  let characterId: string | undefined;
  let owner: "user" | "project" | "character" | undefined;
  let scope: "global" | "project" | "character" | undefined;
  let query: string | undefined;
  const tagOptions: string[] = [];
  let entryId: string | undefined;
  let objectId: string | undefined;
  let outputPath: string | undefined;
  let outputDirectoryPath: string | undefined;
  let largest = false;
  let includeEmpty = false;
  let includeBody = false;
  let withCounts = false;
  let allTargets = false;
  let dryRun = false;
  let sampleLimit: number | undefined;
  let limit: number | undefined;
  let outputFormat: "json" | "jsonl" | "markdown" | undefined;

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
    } else if (arg === "--instance") {
      applicationInstanceId = requireOptionValue(rest, ++index, arg);
    } else if (arg === "--generation") {
      runtimeGenerationId = requireOptionValue(rest, ++index, arg);
    } else if (arg === "--all") {
      if (command !== "status") {
        throw usageError("--all is only supported by status.");
      }
      statusAll = true;
    } else if (arg === "--fallback-from") {
      const value = requireOptionValue(rest, ++index, arg);
      if (value !== "mcp") {
        throw usageError("--fallback-from must be mcp.");
      }
      fallbackFrom = value;
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
    } else if (arg === "--character-id") {
      characterId = requireOptionValue(rest, ++index, arg);
    } else if (arg === "--owner") {
      const value = requireOptionValue(rest, ++index, arg);
      if (value !== "user" && value !== "project" && value !== "character") {
        throw usageError("--owner must be user, project, or character.");
      }
      owner = value as typeof owner;
    } else if (arg === "--scope") {
      const value = requireOptionValue(rest, ++index, arg);
      if (value !== "global" && value !== "project" && value !== "character") {
        throw usageError("--scope must be global, project, or character.");
      }
      scope = value as typeof scope;
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
    } else if (arg === "--include-empty") {
      includeEmpty = true;
    } else if (arg === "--include-body") {
      includeBody = true;
    } else if (arg === "--with-counts") {
      withCounts = true;
    } else if (arg === "--all-targets") {
      allTargets = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--sample-limit") {
      sampleLimit = parseLimitOption(requireOptionValue(rest, ++index, arg));
    } else if (arg === "--format") {
      const value = requireOptionValue(rest, ++index, arg);
      if (!(["json", "jsonl", "markdown"] as const).includes(value as "json" | "jsonl" | "markdown")) {
        throw usageError("--format must be json, jsonl, or markdown.");
      }
      outputFormat = value as "json" | "jsonl" | "markdown";
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
    throw usageError("validate requires --command <list-targets|list-entries|audit|search|get-entry|get-file|export-files|list-tags|append|forget|move-entry>.");
  }

  let body: unknown = {};
  if (characterId) throw usageError("Character identity is selected by the Session binding, not --character-id.");
  if (jsonInput !== null) {
    body = await parseJsonInput(jsonInput);
  } else if (filePath !== null) {
    body = await parseJsonInput(await (deps.readFile ?? readFile)(filePath, "utf8"));
  } else if (stdinRequested) {
    body = await parseJsonInput(await readStdin(deps.stdin ?? process.stdin));
  } else if (hasShorthandOptions({ projectPath, projectId, characterId, owner, scope, query, tags: tagOptions, entryId, objectId, outputPath, outputDirectoryPath, largest, includeEmpty, includeBody, withCounts, allTargets, dryRun, sampleLimit, limit })) {
    body = buildShorthandBody(command, { projectPath, projectId, characterId, owner, scope, query, tags: tagOptions, entryId, objectId, outputPath, outputDirectoryPath, largest, includeEmpty, includeBody, withCounts, allTargets, dryRun, sampleLimit, limit });
  } else if (deps.stdin && !deps.stdin.isTTY && command !== "schema" && command !== "status" && command !== "instances" && command !== "characters") {
    body = await parseJsonInput(await readStdin(deps.stdin));
  }

  if (dryRun && command === "forget" && body && typeof body === "object" && !Array.isArray(body)) {
    body = { ...(body as Record<string, unknown>), dryRun: true };
  }
  if (command === "list_targets" && body && typeof body === "object" && !Array.isArray(body) && Object.keys(body as object).length === 0) {
    body = {};
  }
  if (outputFormat && command !== "audit") {
    throw usageError("--format is only supported by audit.");
  }

  return {
    command,
    body,
    ...(validateCommand ? { validateCommand } : {}),
    ...(apiUrl ? { apiUrl } : {}),
    ...(discoveryFilePath ? { discoveryFilePath } : {}),
    ...(applicationInstanceId ? { applicationInstanceId } : {}),
    ...(runtimeGenerationId ? { runtimeGenerationId } : {}),
    ...(statusAll ? { statusAll: true } : {}),
    ...(outputFormat ? { outputFormat } : {}),
    ...(fallbackFrom ? { fallbackFrom } : {}),
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
  characterId?: string;
  owner?: string;
  scope?: string;
  query?: string;
  tags?: readonly string[];
  entryId?: string;
  objectId?: string;
  outputPath?: string;
  outputDirectoryPath?: string;
  largest?: boolean;
  includeEmpty?: boolean;
  includeBody?: boolean;
  withCounts?: boolean;
  allTargets?: boolean;
  dryRun?: boolean;
  sampleLimit?: number;
  limit?: number;
}): boolean {
  return Boolean(
    options.projectPath
    || options.projectId
    || options.characterId
    || options.owner
    || options.scope
    || options.query
    || (options.tags && options.tags.length > 0)
    || options.entryId
    || options.objectId
    || options.outputPath
    || options.outputDirectoryPath
    || options.largest
    || options.includeEmpty
    || options.includeBody
    || options.withCounts
    || options.allTargets
    || options.dryRun
    || options.sampleLimit !== undefined
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
    return { kind: "project", project: { type: "id", id: options.projectId } };
  }
  if (options.projectPath) {
    return { kind: "project", project: { type: "path", path: normalizeCliProjectPath(options.projectPath) } };
  }
  return null;
}

function buildMaintenanceTarget(options: {
  projectPath?: string;
  projectId?: string;
  characterId?: string;
  owner?: "user" | "project" | "character";
  scope?: "global" | "project" | "character";
}): unknown | null {
  const project = options.projectId
    ? { type: "id", id: options.projectId }
    : options.projectPath
      ? { type: "path", path: normalizeCliProjectPath(options.projectPath) }
      : undefined;

  if (options.characterId) throw usageError("Character identity is selected by the Session binding, not --character-id.");

  if (!options.owner && !options.scope && !options.characterId) {
    return buildProjectTarget(options);
  }
  const selectedScope = options.scope ?? (options.owner === "project" ? "project" : undefined);
  if (options.owner === "project" && selectedScope === "project") return { kind: "project", ...(project ? { project } : {}) };
  if (!options.owner || !selectedScope) {
    throw usageError("Target shorthand requires both --owner and --scope.");
  }
  if (options.owner === "user" && options.scope === "global" && !project && !options.characterId) {
    return { kind: "user-global" };
  }
  if (options.owner === "project" && options.scope === "project" && project && !options.characterId) {
    return { kind: "project", project };
  }
  if (options.owner === "character" && options.scope === "character" && !project) {
    return { kind: "character" };
  }
  if (options.owner === "character" && options.scope === "project" && project) {
    return {
      kind: "character+project",
      project,
    };
  }
  throw usageError("Target shorthand owner, scope, project, and character options do not form a supported target.");
}

function buildShorthandBody(
  command: WithMateMemoryCliCommand,
  options: {
    projectPath?: string;
    projectId?: string;
    characterId?: string;
    owner?: "user" | "project" | "character";
    scope?: "global" | "project" | "character";
    query?: string;
    tags?: readonly string[];
    entryId?: string;
    objectId?: string;
    outputPath?: string;
    outputDirectoryPath?: string;
    largest?: boolean;
    includeEmpty?: boolean;
    includeBody?: boolean;
    withCounts?: boolean;
    allTargets?: boolean;
    dryRun?: boolean;
    sampleLimit?: number;
    limit?: number;
  },
): unknown {
  if (command === "validate") {
    throw usageError("validate shorthand options are not supported. Use --json, --file, @file, or --stdin.");
  }

  const projectTarget = buildProjectTarget(options);
  const target = command === "list_entries" || command === "audit" || command === "list_tags"
    ? buildMaintenanceTarget(options)
    : projectTarget;
  if (command === "file_usage") {
    if (
      projectTarget
      || options.characterId
      || options.owner
      || options.scope
      || options.query
      || (options.tags && options.tags.length > 0)
      || options.entryId
      || options.objectId
      || options.outputPath
      || options.outputDirectoryPath
      || options.includeEmpty
      || options.includeBody
      || options.withCounts
      || options.allTargets
      || options.dryRun
      || options.sampleLimit !== undefined
    ) {
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

  if (command === "list_targets") {
    const filter = buildMaintenanceTarget(options);
    return {
      ...(filter ? { filter } : {}),
      ...(options.includeEmpty ? { includeEmpty: true } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    };
  }

  if (command === "list_entries") {
    if (!target) {
      throw usageError("list-entries shorthand requires an explicit target.");
    }
    return {
      target,
      ...(options.includeBody ? { includeBody: true } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    };
  }

  if (command === "audit") {
    if (options.allTargets === Boolean(target)) {
      throw usageError("audit shorthand requires exactly one of --all-targets or an explicit target.");
    }
    return {
      ...(options.allTargets ? { allTargets: true } : { targets: [target] }),
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
      targets: [target],
      query,
      ...(tags.length > 0 ? { tags } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    };
  }

  if (command === "list_tags") {
    if (!target) {
      throw usageError("list-tags shorthand requires an explicit target.");
    }
    return {
      targets: [target],
      ...(options.withCounts ? { withCounts: true } : {}),
      ...(options.sampleLimit !== undefined ? { sampleLimit: options.sampleLimit } : {}),
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
      target,
      entryId: options.entryId,
      outputDirectoryPath: normalizeCliOutputDirectoryPath(options.outputDirectoryPath),
    };
  }

  if (command === "forget" && options.dryRun) {
    throw usageError("forget --dry-run requires --json, --file, @file, or --stdin with the forget request.");
  }

  throw usageError(`${command} does not support shorthand options. Use --json, --file, @file, or --stdin.`);
}

function requireOptionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw usageError(`${option} requires a value.`);
  }
  return value;
}


function formatAuditOutput(value: unknown, format: "json" | "jsonl" | "markdown"): string {
  if (format === "json" || !value || typeof value !== "object" || !("targets" in value) || !Array.isArray((value as { targets?: unknown }).targets)) {
    return `${JSON.stringify(value)}\n`;
  }
  const report = value as {
    schemaVersion?: unknown;
    generatedAt?: unknown;
    staleBefore?: unknown;
    targets: Array<Record<string, any>>;
    nextCursor?: unknown;
  };
  if (format === "jsonl") {
    const records = [JSON.stringify({
      recordType: "audit_page",
      schemaVersion: report.schemaVersion,
      generatedAt: report.generatedAt,
      staleBefore: report.staleBefore,
      nextCursor: report.nextCursor ?? null,
    }), ...report.targets.map((target) => JSON.stringify({
      recordType: "target_audit",
      ...target,
    }))];
    return `${records.join("\n")}\n`;
  }
  const lines = [
    "# WithMate Memory audit",
    "",
    `- Generated: ${String(report.generatedAt ?? "")}`,
    `- Stale before: ${String(report.staleBefore ?? "")}`,
    "",
  ];
  for (const targetAudit of report.targets) {
    const inventory = targetAudit.target ?? {};
    const selector = inventory.target ?? {};
    const label = `${selector.kind ?? "unknown"}${selector.project ? ` (${selector.project.id})` : ""}`.replace(/\r?\n/g, " ");
    lines.push(`## ${label}`, "");
    lines.push(`- Target: ${label}`);
    lines.push(`- Entries: ${inventory.entryCount ?? 0}`);
    lines.push(`- Tags: ${inventory.tagCount ?? 0}`);
    lines.push(`- Last updated: ${inventory.lastUpdatedAt ?? "n/a"}`, "");
    lines.push("### Counts by kind", "");
    const counts = targetAudit.countsByKind && typeof targetAudit.countsByKind === "object"
      ? Object.entries(targetAudit.countsByKind as Record<string, unknown>)
      : [];
    lines.push(...(counts.length > 0
      ? counts.map(([kind, count]) => `- ${kind}: ${String(count)}`)
      : ["- None"]), "");
    lines.push("### Top tags", "");
    const topTags = Array.isArray(targetAudit.topTags) ? targetAudit.topTags : [];
    lines.push(...(topTags.length > 0
      ? topTags.map((tag) => `- ${String(tag.type)}:${String(tag.value)} — ${String(tag.entryCount)}`)
      : ["- None"]), "");
    const sections: Array<[string, unknown]> = [
      ["Stale or progress-like", targetAudit.staleOrProgressCandidates],
      ["Wrong-scope candidates", targetAudit.wrongScopeCandidates],
      ["Documentation candidates", targetAudit.documentationCandidates],
      ["Suspicious tags", targetAudit.suspiciousTagCandidates],
    ];
    for (const [heading, candidates] of sections) {
      lines.push(`### ${heading}`, "");
      if (!Array.isArray(candidates) || candidates.length === 0) {
        lines.push("- None", "");
        continue;
      }
      for (const candidate of candidates) {
        lines.push(`- ${String(candidate.id)} — ${String(candidate.title).replace(/\r?\n/g, " ")} (${Array.isArray(candidate.reasons) ? candidate.reasons.join(", ") : "candidate"})`);
      }
      lines.push("");
    }
    lines.push("### Duplicate normalized titles", "");
    const duplicateGroups = Array.isArray(targetAudit.duplicateTitleCandidates) ? targetAudit.duplicateTitleCandidates : [];
    if (duplicateGroups.length === 0) {
      lines.push("- None", "");
    } else {
      for (const group of duplicateGroups) {
        const ids = Array.isArray(group.entries) ? group.entries.map((entry: { id?: unknown }) => String(entry.id)).join(", ") : "";
        lines.push(`- ${String(group.normalizedTitle)} — ${ids}`);
      }
      lines.push("");
    }
  }
  if (report.nextCursor) {
    lines.push(`Next cursor: \`${String(report.nextCursor)}\``, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export async function runWithMateMemoryCli(
  args: readonly string[],
  deps: WithMateMemoryCliDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const env = deps.env ?? process.env;

  try {
    const request = await parseWithMateMemoryCliArgs(args, deps);
    if (request.fallbackFrom && (request.command === "get_file" || request.command === "export_files")) throw usageError("Non-idempotent file export does not support MCP fallback.");
    if (request.fallbackFrom) {
      if (env[WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV]?.trim() !== "1" || !resolveAgentRuntimeBindingReference(env)) throw usageError("--fallback-from mcp requires the Agent runtime binding policy and binding.");
      if (!isUuid(env.WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID) || !isUuid(env.WITHMATE_MEMORY_RUNTIME_GENERATION_ID)) throw usageError("--fallback-from mcp requires the runtime owner selected by the Agent binding.");
      if (request.apiUrl || request.discoveryFilePath || request.applicationInstanceId || request.runtimeGenerationId) throw usageError("--fallback-from mcp uses the runtime selected by the Agent binding and does not accept connection selectors.");
    }
    if (request.command === "help") {
      stdout.write(WITHMATE_MEMORY_CLI_HELP);
      return WITHMATE_MEMORY_CLI_EXIT_CODES.ok;
    }
    if (request.command === "mcp_server") {
      await startWithMateMemoryMcpServer({
        env: deps.env,
        readFile: deps.readFile,
        fetch: deps.fetch,
        clock: deps.clock,
        registryRootDirectoryPath: deps.registryRootDirectoryPath,
        staleThresholdMs: deps.staleThresholdMs,
        requestTimeoutMs: deps.requestTimeoutMs,
      });
      return WITHMATE_MEMORY_CLI_EXIT_CODES.ok;
    }
    {
      const tool = createWithMateMemoryPublicTools({ ...deps, adapter: request.fallbackFrom ? "mcp" : "cli", apiUrl: request.apiUrl, discoveryFilePath: request.discoveryFilePath, applicationInstanceId: request.applicationInstanceId, runtimeGenerationId: request.runtimeGenerationId, ...(request.fallbackFrom ? { runtimeCall: (connection, operation, options) => (deps.runtimeCall ?? callWithMateMemoryRuntime)(connection, { ...operation, fallbackFrom: request.fallbackFrom }, options) } : {}) }).get(withMateMemoryToolName(request.command));
      if (!tool) throw usageError("Unknown public Memory command.");
      const publicInput = request.command === "validate" ? { command: request.validateCommand, input: request.body } : request.statusAll ? { all: true } : request.body;
      const input = tool.inputSchema.safeParse(publicInput);
      if (!input.success) {
        const value = validateWithMateMemoryPublicInput(request.command, publicInput);
        stdout.write(`${JSON.stringify(value)}\n`);
        return WITHMATE_MEMORY_CLI_EXIT_CODES.apiError;
      }
      const result = await tool.handler(input.data);
      stdout.write(request.command === "audit" ? formatAuditOutput(result.structuredContent, request.outputFormat ?? "json") : `${JSON.stringify(result.structuredContent)}\n`);
      return result.isError ? WITHMATE_MEMORY_CLI_EXIT_CODES.apiError : WITHMATE_MEMORY_CLI_EXIT_CODES.ok;
    }

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

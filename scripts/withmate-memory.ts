import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createMemoryErrorResponse, type MemoryErrorResponse } from "../src/memory-v6/memory-response-contract.js";

export const WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION = "withmate-memory-discovery-v1" as const;

export const WITHMATE_MEMORY_CLI_EXIT_CODES = {
  ok: 0,
  usage: 1,
  notRunning: 2,
  apiError: 3,
  transportError: 4,
} as const;

export type WithMateMemoryCliCommand =
  | "status"
  | "context"
  | "search"
  | "get_entry"
  | "list_tags"
  | "append"
  | "forget";

export type WithMateMemoryCliRequest = {
  command: WithMateMemoryCliCommand;
  body: unknown;
  discoveryFilePath?: string;
  apiUrl?: string;
};

export type WithMateMemoryCliDeps = {
  env?: NodeJS.ProcessEnv;
  stdin?: NodeJS.ReadStream;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  fetch?: typeof fetch;
  readFile?: typeof readFile;
  requestTimeoutMs?: number;
};

type DiscoveryDocument = {
  schemaVersion: typeof WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION;
  baseUrl: string;
};

const routeByCommand: Record<WithMateMemoryCliCommand, { method: "GET" | "POST"; path: string }> = {
  status: { method: "GET", path: "/v1/status" },
  context: { method: "POST", path: "/v1/context" },
  search: { method: "POST", path: "/v1/search" },
  get_entry: { method: "POST", path: "/v1/get_entry" },
  list_tags: { method: "POST", path: "/v1/list_tags" },
  append: { method: "POST", path: "/v1/append" },
  forget: { method: "POST", path: "/v1/forget" },
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const commandAliases = new Map<string, WithMateMemoryCliCommand>([
  ["status", "status"],
  ["context", "context"],
  ["resolve-context", "context"],
  ["search", "search"],
  ["get-entry", "get_entry"],
  ["get_entry", "get_entry"],
  ["list-tags", "list_tags"],
  ["list_tags", "list_tags"],
  ["append", "append"],
  ["forget", "forget"],
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

function transportError(message: string): MemoryErrorResponse {
  return createMemoryErrorResponse({
    code: "WITHMATE_MEMORY_TRANSPORT_ERROR",
    message,
  });
}

function normalizeBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)) {
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

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") {
    return true;
  }

  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

function defaultDiscoveryFilePath(env: NodeJS.ProcessEnv): string {
  const userDataPath = env.WITHMATE_USER_DATA_PATH?.trim();
  if (userDataPath) {
    return path.resolve(userDataPath, "memory-v6-api.json");
  }

  if (process.platform === "win32") {
    const appData = env.APPDATA?.trim();
    if (appData) {
      return path.join(appData, "WithMate", "memory-v6-api.json");
    }
  }

  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "WithMate", "memory-v6-api.json");
  }

  return path.join(env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), ".config"), "WithMate", "memory-v6-api.json");
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
    throw usageError("Request JSON must be valid JSON.");
  }
}

export async function discoverWithMateMemoryApi(
  options: {
    env?: NodeJS.ProcessEnv;
    apiUrl?: string;
    discoveryFilePath?: string;
    readFile?: typeof readFile;
  } = {},
): Promise<string | null> {
  const env = options.env ?? process.env;
  const directUrl = normalizeBaseUrl(options.apiUrl ?? env.WITHMATE_MEMORY_API_URL ?? "");
  if (directUrl) {
    return directUrl;
  }

  const discoveryFilePath = options.discoveryFilePath
    ?? env.WITHMATE_MEMORY_DISCOVERY_FILE?.trim()
    ?? defaultDiscoveryFilePath(env);
  const read = options.readFile ?? readFile;

  try {
    const document = JSON.parse(await read(discoveryFilePath, "utf8")) as Partial<DiscoveryDocument>;
    if (document.schemaVersion !== WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION || typeof document.baseUrl !== "string") {
      return null;
    }
    return normalizeBaseUrl(document.baseUrl);
  } catch {
    return null;
  }
}

export async function parseWithMateMemoryCliArgs(
  args: readonly string[],
  deps: Pick<WithMateMemoryCliDeps, "stdin" | "readFile"> = {},
): Promise<WithMateMemoryCliRequest> {
  const [rawCommand, ...rest] = args;
  const command = rawCommand ? commandAliases.get(rawCommand) : undefined;
  if (!command) {
    throw usageError("Usage: withmate-memory <status|context|search|get-entry|list-tags|append|forget> [--json <json> | --file <path>] [--api-url <url>] [--discovery-file <path>]");
  }

  let jsonInput: string | null = null;
  let filePath: string | null = null;
  let apiUrl: string | undefined;
  let discoveryFilePath: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") {
      jsonInput = requireOptionValue(rest, ++index, arg);
    } else if (arg === "--file") {
      filePath = requireOptionValue(rest, ++index, arg);
    } else if (arg === "--api-url") {
      apiUrl = requireOptionValue(rest, ++index, arg);
    } else if (arg === "--discovery-file") {
      discoveryFilePath = requireOptionValue(rest, ++index, arg);
    } else {
      throw usageError(`Unknown option: ${arg}`);
    }
  }

  if (jsonInput !== null && filePath !== null) {
    throw usageError("--json and --file cannot be used together.");
  }

  let body: unknown = {};
  if (command !== "status") {
    if (jsonInput !== null) {
      body = await parseJsonInput(jsonInput);
    } else if (filePath !== null) {
      body = await parseJsonInput(await (deps.readFile ?? readFile)(filePath, "utf8"));
    } else if (deps.stdin && !deps.stdin.isTTY) {
      body = await parseJsonInput(await readStdin(deps.stdin));
    }
  }

  return {
    command,
    body,
    ...(apiUrl ? { apiUrl } : {}),
    ...(discoveryFilePath ? { discoveryFilePath } : {}),
  };
}

function requireOptionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw usageError(`${option} requires a value.`);
  }
  return value;
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

export async function runWithMateMemoryCli(
  args: readonly string[],
  deps: WithMateMemoryCliDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const fetchImpl = deps.fetch ?? fetch;

  try {
    const request = await parseWithMateMemoryCliArgs(args, deps);
    const baseUrl = await discoverWithMateMemoryApi({
      env: deps.env,
      apiUrl: request.apiUrl,
      discoveryFilePath: request.discoveryFilePath,
      readFile: deps.readFile,
    });
    if (!baseUrl) {
      stdout.write(`${JSON.stringify(notRunningError())}\n`);
      return WITHMATE_MEMORY_CLI_EXIT_CODES.notRunning;
    }

    const route = routeByCommand[request.command];
    let response: Response;
    let responseJson: unknown;
    const abortController = new AbortController();
    const requestTimeout = setTimeout(() => abortController.abort(), deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    try {
      response = await fetchImpl(`${baseUrl}${route.path}`, {
        method: route.method,
        headers: route.method === "POST" ? { "Content-Type": "application/json" } : undefined,
        body: route.method === "POST" ? JSON.stringify(request.body) : undefined,
        signal: abortController.signal,
      });
      responseJson = await readJsonResponse(response);
    } catch (error) {
      if (isMemoryErrorResponse(error)) {
        throw error;
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

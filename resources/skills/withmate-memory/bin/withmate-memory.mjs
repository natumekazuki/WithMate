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

const exitCodes = {
  ok: 0,
  usage: 1,
  notRunning: 2,
  apiError: 3,
  transportError: 4,
};

const commands = new Map([
  ["status", { method: "GET", path: "/v1/status", defaultBody: {} }],
  ["context", { method: "POST", path: "/v1/context", defaultBody: { schemaVersion } }],
  ["resolve-context", { method: "POST", path: "/v1/context", defaultBody: { schemaVersion } }],
  ["search", { method: "POST", path: "/v1/search", defaultBody: {} }],
  ["get-entry", { method: "POST", path: "/v1/get_entry", defaultBody: {} }],
  ["get_entry", { method: "POST", path: "/v1/get_entry", defaultBody: {} }],
  ["list-tags", { method: "POST", path: "/v1/list_tags", defaultBody: {} }],
  ["list_tags", { method: "POST", path: "/v1/list_tags", defaultBody: {} }],
  ["append", { method: "POST", path: "/v1/append", defaultBody: {} }],
  ["forget", { method: "POST", path: "/v1/forget", defaultBody: {} }],
]);

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
    throw usage("Usage: withmate-memory <status|context|search|get-entry|list-tags|append|forget> [--json <json> | --file <path>] [--api-url <url>] [--discovery-file <path>]");
  }

  let jsonInput = null;
  let filePath = null;
  let apiUrl;
  let discoveryFilePath;
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
      throw usage(`Unknown option: ${arg}`);
    }
  }
  if (jsonInput !== null && filePath !== null) {
    throw usage("--json and --file cannot be used together.");
  }

  let body = route.defaultBody;
  if (route.method === "POST") {
    if (jsonInput !== null) {
      body = parseJson(jsonInput);
    } else if (filePath !== null) {
      body = parseJson(await readFile(filePath, "utf8"));
    }
  }
  return { route, body, apiUrl, discoveryFilePath };
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
    throw usage("Request JSON must be valid JSON.");
  }
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

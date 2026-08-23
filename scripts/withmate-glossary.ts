import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { GLOSSARY_RUNTIME_SCHEMA_VERSION } from "../src/glossary-contract.js";
import {
  GLOSSARY_RUNTIME_OPERATION_PATHS,
  type GlossaryRuntimeOperation,
} from "../src/glossary-operation-schema.js";
import {
  GLOSSARY_MCP_TOOL_DEFINITIONS,
  GLOSSARY_PUBLIC_INPUT_SCHEMAS,
  startWithMateGlossaryMcpServer,
} from "./withmate-glossary-mcp.js";
import {
  callGlossaryRuntime,
  createGlossaryTransportError,
  type GlossaryRuntimeClientDeps,
} from "./withmate-glossary-runtime-client.js";

export type GlossaryCliDeps = Omit<GlossaryRuntimeClientDeps, "adapter" | "apiUrl" | "discoveryFilePath"> & {
  stdin?: NodeJS.ReadableStream;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
};

export const WITHMATE_GLOSSARY_CLI_EXIT_CODES = {
  ok: 0,
  operationError: 1,
  usage: 2,
  transportError: 3,
} as const;

const commandAliases = new Map<string, GlossaryRuntimeOperation | "help" | "schema" | "mcp_server">([
  ["help", "help"],
  ["list-targets", "list_targets"],
  ["list_targets", "list_targets"],
  ["list", "list"],
  ["search", "search"],
  ["get", "get"],
  ["create", "create"],
  ["create-batch", "create_batch"],
  ["create_batch", "create_batch"],
  ["update", "update"],
  ["delete", "delete"],
  ["validate", "validate"],
  ["schema", "schema"],
  ["mcp-server", "mcp_server"],
]);

const CLI_HELP = `Usage:
  withmate-glossary <command> [--json <json> | --file <path> | @file | --stdin] [options]

Commands:
  list-targets
  list
  search
  get
  create
  create-batch
  update
  delete
  validate
  schema
  mcp-server

Target options:
  --checkout-id <opaque-id>   Use an ID returned by list-targets. Defaults to primary.

Input shorthands:
  --query <text>
  --term <term-or-alias>
  --offset <n>
  --page-size <n>

Connection options:
  --api-url <loopback-url>
  --discovery-file <path>
`;

type ParsedCliRequest = {
  command: GlossaryRuntimeOperation | "help" | "schema" | "mcp_server";
  body: Record<string, unknown>;
  apiUrl?: string;
  discoveryFilePath?: string;
};

class GlossaryCliUsageError extends Error {}

function requireOptionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new GlossaryCliUsageError(`${option} requires a value.`);
  }
  return value;
}

function parseInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new GlossaryCliUsageError(`${option} must be an integer.`);
  }
  return parsed;
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonObject(raw: string, source: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new GlossaryCliUsageError(`${source} must contain valid JSON.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GlossaryCliUsageError(`${source} must contain a JSON object.`);
  }
  return value as Record<string, unknown>;
}

export async function parseWithMateGlossaryCliArgs(
  args: readonly string[],
  deps: Pick<GlossaryCliDeps, "stdin" | "readFile"> = {},
): Promise<ParsedCliRequest> {
  const command = commandAliases.get(args[0] ?? "help");
  if (!command) {
    throw new GlossaryCliUsageError(`Unknown command: ${args[0]}`);
  }
  let body: Record<string, unknown> = {};
  let inputSourceSeen = false;
  let apiUrl: string | undefined;
  let discoveryFilePath: string | undefined;
  let checkoutId: string | undefined;
  const shorthand: Record<string, unknown> = {};
  const read = deps.readFile ?? readFile;

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      if (inputSourceSeen) throw new GlossaryCliUsageError("Choose only one JSON input source.");
      body = parseJsonObject(requireOptionValue(args, index, argument), argument);
      inputSourceSeen = true;
      index += 1;
    } else if (argument === "--file" || argument.startsWith("@")) {
      if (inputSourceSeen) throw new GlossaryCliUsageError("Choose only one JSON input source.");
      const filePath = argument === "--file"
        ? requireOptionValue(args, index, argument)
        : argument.slice(1);
      if (!filePath) throw new GlossaryCliUsageError("@file requires a path.");
      body = parseJsonObject(await read(filePath, "utf8"), filePath);
      inputSourceSeen = true;
      if (argument === "--file") index += 1;
    } else if (argument === "--stdin") {
      if (inputSourceSeen) throw new GlossaryCliUsageError("Choose only one JSON input source.");
      body = parseJsonObject(await readStream(deps.stdin ?? process.stdin), "stdin");
      inputSourceSeen = true;
    } else if (argument === "--api-url") {
      apiUrl = requireOptionValue(args, index, argument);
      index += 1;
    } else if (argument === "--discovery-file") {
      discoveryFilePath = requireOptionValue(args, index, argument);
      index += 1;
    } else if (argument === "--checkout-id") {
      checkoutId = requireOptionValue(args, index, argument);
      index += 1;
    } else if (argument === "--query") {
      shorthand.query = requireOptionValue(args, index, argument);
      index += 1;
    } else if (argument === "--term") {
      shorthand.termOrAlias = requireOptionValue(args, index, argument);
      index += 1;
    } else if (argument === "--offset") {
      shorthand.offset = parseInteger(requireOptionValue(args, index, argument), argument);
      index += 1;
    } else if (argument === "--page-size") {
      shorthand.pageSize = parseInteger(requireOptionValue(args, index, argument), argument);
      index += 1;
    } else {
      throw new GlossaryCliUsageError(`Unknown option: ${argument}`);
    }
  }

  if (Object.keys(shorthand).length > 0 && inputSourceSeen) {
    throw new GlossaryCliUsageError("Shorthand input options cannot be combined with JSON input.");
  }
  if (Object.keys(shorthand).length > 0) {
    body = shorthand;
  }
  if (command !== "help" && command !== "schema" && command !== "mcp_server") {
    const selectedBody = command === "list_targets"
      ? body
      : {
          selector: checkoutId ? { kind: "checkout", checkoutId } : { kind: "primary" },
          ...body,
        };
    const parsed = GLOSSARY_PUBLIC_INPUT_SCHEMAS[command].safeParse(selectedBody);
    if (!parsed.success) {
      throw new GlossaryCliUsageError(
        parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; "),
      );
    }
    body = parsed.data;
  }
  return { command, body, ...(apiUrl ? { apiUrl } : {}), ...(discoveryFilePath ? { discoveryFilePath } : {}) };
}

function schemaProjection() {
  return {
    schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION,
    operations: GLOSSARY_MCP_TOOL_DEFINITIONS.map((definition) => ({
      operation: definition.operation,
      tool: definition.name,
      path: GLOSSARY_RUNTIME_OPERATION_PATHS[definition.operation],
    })),
  };
}

export async function runWithMateGlossaryCli(
  args: readonly string[],
  deps: GlossaryCliDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  try {
    const request = await parseWithMateGlossaryCliArgs(args, deps);
    if (request.command === "help") {
      stdout.write(CLI_HELP);
      return WITHMATE_GLOSSARY_CLI_EXIT_CODES.ok;
    }
    if (request.command === "schema") {
      stdout.write(`${JSON.stringify(schemaProjection())}\n`);
      return WITHMATE_GLOSSARY_CLI_EXIT_CODES.ok;
    }
    if (request.command === "mcp_server") {
      await startWithMateGlossaryMcpServer(deps);
      return WITHMATE_GLOSSARY_CLI_EXIT_CODES.ok;
    }
    const value = await callGlossaryRuntime({
      operation: request.command,
      path: GLOSSARY_RUNTIME_OPERATION_PATHS[request.command],
      body: { ...request.body, schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION },
    }, {
      ...deps,
      adapter: "cli",
      apiUrl: request.apiUrl,
      discoveryFilePath: request.discoveryFilePath,
    });
    stdout.write(`${JSON.stringify(value)}\n`);
    if ("ok" in value && value.ok === false) {
      return "code" in value && value.code === "GLOSSARY_TRANSPORT_ERROR"
        ? WITHMATE_GLOSSARY_CLI_EXIT_CODES.transportError
        : WITHMATE_GLOSSARY_CLI_EXIT_CODES.operationError;
    }
    return WITHMATE_GLOSSARY_CLI_EXIT_CODES.ok;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Glossary CLI request failed.";
    const value = createGlossaryTransportError(message);
    stdout.write(`${JSON.stringify(value)}\n`);
    if (error instanceof GlossaryCliUsageError) {
      stderr.write(`${message}\n`);
      return WITHMATE_GLOSSARY_CLI_EXIT_CODES.usage;
    }
    stderr.write("withmate-glossary transport failed\n");
    return WITHMATE_GLOSSARY_CLI_EXIT_CODES.transportError;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runWithMateGlossaryCli(process.argv.slice(2));
}

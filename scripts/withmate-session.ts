import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
  SESSION_RUNTIME_OPERATIONS,
  type SessionRuntimeError,
  type SessionRuntimeOperation,
  type SessionRuntimeRequestEnvelope,
} from "../src/session-external-runtime-contract.js";
import {
  SessionRuntimeClientError,
  callSessionRuntime,
  discoverSessionRuntime,
  verifySessionRuntimeIdentity,
  type SessionRuntimeClientResponse,
  type SessionRuntimeConnection,
} from "./withmate-session-runtime-client.js";
import { startWithMateSessionMcpServer } from "./withmate-session-mcp.js";

export const WITHMATE_SESSION_CLI_SCHEMA_VERSION = "withmate-session-cli-output-v1" as const;
export const WITHMATE_SESSION_CLI_EXIT_CODES = {
  ok: 0,
  usage: 1,
  runtimeUnavailable: 2,
  applicationError: 3,
  transportIndeterminate: 4,
} as const;

type OutputFormat = "json" | "text";
type Writable = { write(chunk: string): unknown };
type CliDeps = {
  env?: NodeJS.ProcessEnv;
  stdin?: NodeJS.ReadStream;
  stdout?: Writable;
  read?: typeof readFile;
  discover?: typeof discoverSessionRuntime;
  verify?: typeof verifySessionRuntimeIdentity;
  call?: typeof callSessionRuntime;
  startMcp?: typeof startWithMateSessionMcpServer;
};

type CliOutput = {
  schemaVersion: typeof WITHMATE_SESSION_CLI_SCHEMA_VERSION;
  command: string;
  ok: boolean;
  result?: unknown;
  error?: SessionRuntimeError["error"];
};

class SessionCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionCliUsageError";
  }
}

const commandMap = new Map<string, SessionRuntimeOperation>([
  ["turn run", "turn.run"],
  ["turn enqueue", "turn.enqueue"],
  ["turn list", "turn.list"],
  ["turn get", "turn.get"],
  ["turn cancel", "turn.cancel"],
]);

export async function runWithMateSessionCli(args: readonly string[], deps: CliDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  let format: OutputFormat = "json";
  let command = "unknown";
  try {
    if (args[0] === "mcp-server" && args.length === 1) {
      await (deps.startMcp ?? startWithMateSessionMcpServer)({ env: deps.env });
      return WITHMATE_SESSION_CLI_EXIT_CODES.ok;
    }
    const parsed = await parseArgs(args, deps);
    command = parsed.command;
    format = parsed.format;
    if (command === "schema") {
      writeOutput(stdout, format, {
        schemaVersion: WITHMATE_SESSION_CLI_SCHEMA_VERSION,
        command,
        ok: true,
        result: {
          requestSchemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
          operations: SESSION_RUNTIME_OPERATIONS,
          commands: [...commandMap.keys(), "status", "schema", "mcp-server"],
          inputSources: ["--json", "--file", "--stdin"],
          formats: ["json", "text"],
          exitCodes: WITHMATE_SESSION_CLI_EXIT_CODES,
        },
      });
      return WITHMATE_SESSION_CLI_EXIT_CODES.ok;
    }

    const discover = deps.discover ?? discoverSessionRuntime;
    let connection: SessionRuntimeConnection | null;
    try {
      connection = await discover({
        env: deps.env,
        ...(parsed.apiUrl ? { apiUrl: parsed.apiUrl } : {}),
        ...(parsed.discoveryFilePath ? { discoveryFilePath: parsed.discoveryFilePath } : {}),
        ...(deps.read ? { read: deps.read } : {}),
      });
    } catch {
      throw new SessionCliUsageError("Session runtime connection options are invalid.");
    }
    if (!connection) {
      writeOutput(stdout, format, localError(command, "RUNTIME_UNAVAILABLE", "WithMate Session runtime is not running.", true));
      return WITHMATE_SESSION_CLI_EXIT_CODES.runtimeUnavailable;
    }
    if (command === "status") {
      const controller = AbortSignal.timeout(parsed.timeoutMs);
      const verified = await (deps.verify ?? verifySessionRuntimeIdentity)(connection, controller);
      if (!verified) {
        writeOutput(stdout, format, localError(command, "RUNTIME_UNAVAILABLE", "Session runtime identity did not match discovery.", true));
        return WITHMATE_SESSION_CLI_EXIT_CODES.runtimeUnavailable;
      }
      writeOutput(stdout, format, {
        schemaVersion: WITHMATE_SESSION_CLI_SCHEMA_VERSION,
        command,
        ok: true,
        result: { available: true, runtimeInstanceId: connection.runtimeInstanceId },
      });
      return WITHMATE_SESSION_CLI_EXIT_CODES.ok;
    }

    const operation = commandMap.get(command);
    if (!operation) {
      throw new Error("Unsupported command.");
    }
    const envelope: SessionRuntimeRequestEnvelope = {
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation,
      input: parsed.input,
    };
    const response = await (deps.call ?? callSessionRuntime)(connection, envelope, AbortSignal.timeout(parsed.timeoutMs));
    const output = projectRuntimeResponse(command, response);
    writeOutput(stdout, format, output);
    return output.ok ? WITHMATE_SESSION_CLI_EXIT_CODES.ok : WITHMATE_SESSION_CLI_EXIT_CODES.applicationError;
  } catch (error) {
    if (error instanceof SessionRuntimeClientError) {
      writeOutput(stdout, format, localError(
        command,
        "RUNTIME_UNAVAILABLE",
        error.dispatched ? "Session runtime response was not received after dispatch." : "Session runtime is unavailable.",
        true,
        error.dispatched ? "indeterminate" : "not_applied",
      ));
      return error.dispatched
        ? WITHMATE_SESSION_CLI_EXIT_CODES.transportIndeterminate
        : WITHMATE_SESSION_CLI_EXIT_CODES.runtimeUnavailable;
    }
    writeOutput(stdout, format, localError(
      command,
      "INVALID_INPUT",
      error instanceof SessionCliUsageError ? error.message : "Invalid CLI input.",
    ));
    return WITHMATE_SESSION_CLI_EXIT_CODES.usage;
  }
}

async function parseArgs(args: readonly string[], deps: CliDeps): Promise<{
  command: string;
  input?: unknown;
  format: OutputFormat;
  apiUrl?: string;
  discoveryFilePath?: string;
  timeoutMs: number;
}> {
  const command = args[0] === "turn" ? `${args[0]} ${args[1] ?? ""}`.trim() : args[0] ?? "";
  if (command !== "status" && command !== "schema" && !commandMap.has(command)) {
    throw new SessionCliUsageError("Usage: withmate-session <turn run|enqueue|list|get|cancel|status|schema|mcp-server> [options]");
  }
  const optionStart = args[0] === "turn" ? 2 : 1;
  let json: string | undefined;
  let file: string | undefined;
  let useStdin = false;
  let format: OutputFormat = "json";
  let apiUrl: string | undefined;
  let discoveryFilePath: string | undefined;
  let timeoutMs = 35_000;
  for (let index = optionStart; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--stdin") {
      useStdin = true;
      continue;
    }
    const value = args[++index];
    if (value === undefined) {
      throw new SessionCliUsageError(`${option} requires a value.`);
    }
    if (option === "--json") json = value;
    else if (option === "--file") file = value;
    else if (option === "--format" && (value === "json" || value === "text")) format = value;
    else if (option === "--api-url") apiUrl = value;
    else if (option === "--discovery-file") discoveryFilePath = value;
    else if (option === "--timeout-ms" && Number.isSafeInteger(Number(value)) && Number(value) > 0) timeoutMs = Number(value);
    else throw new SessionCliUsageError(`Unknown or invalid option: ${option}.`);
  }
  const sources = Number(json !== undefined) + Number(file !== undefined) + Number(useStdin);
  if (commandMap.has(command) && sources !== 1) {
    throw new SessionCliUsageError("Operation commands require exactly one of --json, --file, or --stdin.");
  }
  if (!commandMap.has(command) && sources !== 0) {
    throw new SessionCliUsageError(`${command} does not accept an operation input.`);
  }
  let input: unknown;
  try {
    if (json !== undefined) input = JSON.parse(json);
    else if (file !== undefined) input = JSON.parse(await (deps.read ?? readFile)(file, "utf8"));
    else if (useStdin) input = JSON.parse(await readStdin(deps.stdin ?? process.stdin));
  } catch {
    throw new SessionCliUsageError("Operation input must be readable valid JSON.");
  }
  return { command, ...(sources ? { input } : {}), format, ...(apiUrl ? { apiUrl } : {}), ...(discoveryFilePath ? { discoveryFilePath } : {}), timeoutMs };
}

async function readStdin(stdin: NodeJS.ReadStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function projectRuntimeResponse(command: string, response: SessionRuntimeClientResponse): CliOutput {
  if (response.value && typeof response.value === "object" && "error" in response.value) {
    return {
      schemaVersion: WITHMATE_SESSION_CLI_SCHEMA_VERSION,
      command,
      ok: false,
      error: (response.value as SessionRuntimeError).error,
    };
  }
  return { schemaVersion: WITHMATE_SESSION_CLI_SCHEMA_VERSION, command, ok: response.ok, result: response.value };
}

function localError(
  command: string,
  code: string,
  message: string,
  retryable = false,
  effect: "not_applied" | "indeterminate" = "not_applied",
): CliOutput {
  return {
    schemaVersion: WITHMATE_SESSION_CLI_SCHEMA_VERSION,
    command,
    ok: false,
    error: { code, message, retryable, effect, details: {} },
  };
}

function writeOutput(stdout: Writable, format: OutputFormat, output: CliOutput): void {
  if (format === "json") {
    stdout.write(`${JSON.stringify(output)}\n`);
    return;
  }
  if (output.ok) {
    stdout.write(`${output.command}: ok\n${formatTextResult(output.result)}\n`);
  } else {
    stdout.write(`${output.command}: ${output.error?.code ?? "ERROR"}: ${output.error?.message ?? "Operation failed."}\n`);
  }
}

function formatTextResult(value: unknown): string {
  if (value && typeof value === "object" && "result" in value) {
    return JSON.stringify((value as { result: unknown }).result, null, 2);
  }
  return JSON.stringify(value, null, 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runWithMateSessionCli(process.argv.slice(2));
}

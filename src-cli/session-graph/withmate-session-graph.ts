import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { sessionGraphOperationRequestSchemas } from "../../src-shared/session-graph/session-graph-operation-schema.js";
import { callSessionGraphRuntime, createSessionGraphTransportError, type SessionGraphRuntimeClientDeps } from "../../src-electron/platform/mcp/withmate-session-graph-runtime-client.js";

export const WITHMATE_SESSION_GRAPH_CLI_EXIT_CODES = { ok: 0, operationError: 1, usage: 2, transportError: 3 } as const;
const operations = ["list_topics", "recent", "context", "get", "search", "apply"] as const;
type Operation = typeof operations[number];
type Command = Operation | "help" | "schema";
export type SessionGraphCliDeps = SessionGraphRuntimeClientDeps & {
  stdin?: NodeJS.ReadableStream;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
};
const CLI_HELP = `Usage:
  withmate-session-graph <command> [--json <json> | --file <path> | @file | --stdin]

Commands:
  list-topics (list_topics)
  recent
  context
  get
  search
  apply
  help
  schema

Connection options:
  --api-url <loopback-url>
  --discovery-file <path>
  --instance <application-instance-id>
  --generation <runtime-generation-id>

Operations use the current provider Session binding and turn capability.
Use schema for the shared JSON input schemas. No caller or parent Session selector is accepted.
`;
class SessionGraphCliUsageError extends Error {}

export async function parseWithMateSessionGraphCliArgs(args: readonly string[], deps: Pick<SessionGraphCliDeps, "readFile" | "stdin"> = {}) {
  const name = (args[0] ?? "help").replaceAll("-", "_");
  const command: Command = name === "help" || name === "schema" || operations.includes(name as Operation)
    ? name as Command : (() => { throw new SessionGraphCliUsageError(`Unknown command: ${args[0]}`); })();
  let body: unknown = {};
  let inputSeen = false;
  const connection: Pick<SessionGraphRuntimeClientDeps, "apiUrl" | "discoveryFilePath" | "applicationInstanceId" | "runtimeGenerationId"> = {};
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    const takeValue = () => {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new SessionGraphCliUsageError(`${option} requires a value.`);
      return value;
    };
    if (option === "--json" || option === "--file" || option === "--stdin" || option.startsWith("@")) {
      if (inputSeen) throw new SessionGraphCliUsageError("Choose only one JSON input source.");
      inputSeen = true;
      let raw: string;
      if (option === "--json") raw = takeValue();
      else if (option === "--stdin") {
        const chunks: Buffer[] = [];
        for await (const chunk of deps.stdin ?? process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        raw = Buffer.concat(chunks).toString("utf8");
      } else {
        const file = option === "--file" ? takeValue() : option.slice(1);
        if (!file) throw new SessionGraphCliUsageError("@file requires a path.");
        raw = await (deps.readFile ?? readFile)(file, "utf8");
      }
      try { body = JSON.parse(raw); }
      catch { throw new SessionGraphCliUsageError("Input must contain valid JSON."); }
    } else if (option === "--api-url") connection.apiUrl = takeValue();
    else if (option === "--discovery-file") connection.discoveryFilePath = takeValue();
    else if (option === "--instance") connection.applicationInstanceId = takeValue();
    else if (option === "--generation") connection.runtimeGenerationId = takeValue();
    else throw new SessionGraphCliUsageError(`Unknown option: ${option}`);
  }
  if (command === "help" || command === "schema") return { command, body: {}, ...connection };
  const parsed = sessionGraphOperationRequestSchemas[command].safeParse(body);
  if (!parsed.success) throw new SessionGraphCliUsageError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; "));
  return { command, body: parsed.data, ...connection };
}

export async function runWithMateSessionGraphCli(args: readonly string[], deps: SessionGraphCliDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  try {
    const request = await parseWithMateSessionGraphCliArgs(args, deps);
    if (request.command === "help") { stdout.write(CLI_HELP); return WITHMATE_SESSION_GRAPH_CLI_EXIT_CODES.ok; }
    if (request.command === "schema") {
      stdout.write(`${JSON.stringify({ operations: Object.fromEntries(operations.map((operation) => [operation,
        z.toJSONSchema(sessionGraphOperationRequestSchemas[operation], { unrepresentable: "any" })])) })}\n`);
      return WITHMATE_SESSION_GRAPH_CLI_EXIT_CODES.ok;
    }
    const value = await callSessionGraphRuntime(request.command, request.body, { ...deps, ...request });
    stdout.write(`${JSON.stringify(value)}\n`);
    if (value.ok === false || value.status === "conflict") return value.code === "SESSION_GRAPH_TRANSPORT_ERROR"
      || (typeof value.code === "string" && value.code.startsWith("WITHMATE_RUNTIME_"))
      ? WITHMATE_SESSION_GRAPH_CLI_EXIT_CODES.transportError : WITHMATE_SESSION_GRAPH_CLI_EXIT_CODES.operationError;
    return WITHMATE_SESSION_GRAPH_CLI_EXIT_CODES.ok;
  } catch (cause) {
    const usage = cause instanceof SessionGraphCliUsageError;
    stdout.write(`${JSON.stringify(usage ? { ok: false, code: "SESSION_GRAPH_INVALID_INPUT", effect: "none", message: cause.message }
      : createSessionGraphTransportError())}\n`);
    stderr.write(`${cause instanceof Error ? cause.message : "Session Graph CLI request failed."}\n`);
    return usage ? WITHMATE_SESSION_GRAPH_CLI_EXIT_CODES.usage : WITHMATE_SESSION_GRAPH_CLI_EXIT_CODES.transportError;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runWithMateSessionGraphCli(process.argv.slice(2));
}

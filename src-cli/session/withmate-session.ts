import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  sessionOperationRequestSchemas,
  sessionOperationSuccessSchemas,
  sessionOperationResultSchema,
  SESSION_OPERATION_DESCRIPTIONS,
  type SessionOperation,
} from "../../src-shared/session/session-management-contract.js";
import {
  callSessionRuntime,
  createSessionTransportError,
  type SessionRuntimeClientDeps,
} from "../../src-electron/platform/mcp/withmate-session-runtime-client.js";

export const WITHMATE_SESSION_CLI_EXIT_CODES = {
  ok: 0,
  operationError: 1,
  usage: 2,
  transportError: 3,
} as const;
export type SessionCliDeps = SessionRuntimeClientDeps & {
  stdin?: NodeJS.ReadableStream;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
};
class SessionCliUsageError extends Error {}
const operations = Object.keys(
  sessionOperationRequestSchemas,
) as SessionOperation[];
export const SESSION_CLI_HELP = `Usage: withmate-session <command> [--json <json> | --file <path> | @file | --stdin]
Commands: ${operations.map((operation) => operation.replaceAll("_", "-")).join(", ")}, schema, help
Connection: --api-url <loopback-url> --discovery-file <path> --instance <id> --generation <id>
The active binding and provider Turn come from the environment; there is no actor override or unbound administrator mode.
Crew reads default to this Crew; list supports explicit rootSessionId/allCrews. Targets always require saved sessionId and incarnationId.
Directory operations target your own Session or its direct child. Main and Auxiliary share their list; changes affect subsequent Turns, not the running Turn. Removal unregisters a path and never deletes files.
Normal messages enqueue only between actual direct parents and children, including mixed Providers. A receipt is not a completed Turn.
Enqueue deliveryTiming is immediate by default, or explicitly after_source_turn to wait for the exact sending Turn's saved completed/failed/canceled state before starting a normal recipient Turn. Both return a durable receipt immediately; unknown source state does not release delivery. Delayed messages never auto-Steer or block immediate consultation or GUI input. Coordination remains immediate.
Only direct parents cancel pending child receipts or stop a specified child Turn (including additional inputs). No Steer, queue editing, Role promotion, user answering or approval is exposed.
Create children with explicit Provider/model/depth/approval, Codex-only sandbox and a prepared Workspace; get-catalog returns supported choices. Character selection is automatic and identical requestId retries recover the same child/settings. Selection policy stays in your Provider-managed runbook; no Worktree creation/merge/deletion is performed.
For consultation, create then deliver to the saved actual caller; the authorized respondent may escalate the same record to the user. Agent answers return directly to the immutable initiator. Save+queue delivery is atomic; reading does not consume answers. Withdrawal retains valid answers and accepted deliveries; only trusted GUI creates real user answers.
Enqueue and get-receipt require a UUID requestId. On unknown enqueue outcome recover using get-receipt with the original requestId; never automatically create a new request.
Use schema for exact shared input schemas and operation descriptions.
`;
export async function parseWithMateSessionCliArgs(
  args: readonly string[],
  deps: Pick<SessionCliDeps, "stdin" | "readFile"> = {},
) {
  const command = (args[0] ?? "help").replaceAll("-", "_");
  if (
    command !== "help" &&
    command !== "schema" &&
    !operations.includes(command as SessionOperation)
  )
    throw new SessionCliUsageError(`Unknown command: ${args[0]}`);
  let body: unknown = {};
  let inputSeen = false;
  const connection: Pick<
    SessionRuntimeClientDeps,
    | "apiUrl"
    | "discoveryFilePath"
    | "applicationInstanceId"
    | "runtimeGenerationId"
  > = {};
  for (let index = 1; index < args.length; index++) {
    const option = args[index];
    const take = () => {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new SessionCliUsageError(`${option} requires a value.`);
      return value;
    };
    if (
      option === "--json" ||
      option === "--file" ||
      option === "--stdin" ||
      option.startsWith("@")
    ) {
      if (inputSeen)
        throw new SessionCliUsageError("Choose one JSON input source.");
      inputSeen = true;
      let raw: string;
      if (option === "--json") raw = take();
      else if (option === "--stdin") {
        const chunks: Buffer[] = [];
        for await (const chunk of deps.stdin ?? process.stdin)
          chunks.push(Buffer.from(chunk));
        raw = Buffer.concat(chunks).toString("utf8");
      } else
        raw = await (deps.readFile ?? readFile)(
          option === "--file" ? take() : option.slice(1),
          "utf8",
        );
      try {
        body = JSON.parse(raw);
      } catch {
        throw new SessionCliUsageError("Input must contain valid JSON.");
      }
    } else if (option === "--api-url") connection.apiUrl = take();
    else if (option === "--discovery-file")
      connection.discoveryFilePath = take();
    else if (option === "--instance") connection.applicationInstanceId = take();
    else if (option === "--generation") connection.runtimeGenerationId = take();
    else throw new SessionCliUsageError(`Unknown option: ${option}`);
  }
  return {
    command: command as SessionOperation | "help" | "schema",
    body,
    ...connection,
  };
}
export async function runWithMateSessionCli(
  args: readonly string[],
  deps: SessionCliDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  try {
    const request = await parseWithMateSessionCliArgs(args, deps);
    if (request.command === "help") {
      stdout.write(SESSION_CLI_HELP);
      return 0;
    }
    if (request.command === "schema") {
      stdout.write(
        `${JSON.stringify({ resultEnvelope: z.toJSONSchema(sessionOperationResultSchema), operations: Object.fromEntries(operations.map((operation) => [operation, { description: SESSION_OPERATION_DESCRIPTIONS[operation], input: z.toJSONSchema(sessionOperationRequestSchemas[operation], { unrepresentable: "any" }), success: z.toJSONSchema(sessionOperationSuccessSchemas[operation], { unrepresentable: "any" }) }])) })}\n`,
      );
      return 0;
    }
    const value = await callSessionRuntime(request.command, request.body, {
      ...deps,
      ...request,
    });
    stdout.write(`${JSON.stringify(value)}\n`);
    return value.ok === false
      ? value.code === "SESSION_TRANSPORT_ERROR" ||
        (typeof value.code === "string" &&
          value.code.startsWith("WITHMATE_RUNTIME_"))
        ? 3
        : value.code === "SESSION_INVALID_REQUEST"
          ? 2
          : 1
      : 0;
  } catch (error) {
    const usage = error instanceof SessionCliUsageError;
    stdout.write(
      `${JSON.stringify(usage ? { ok: false, code: "SESSION_INVALID_REQUEST", message: error.message, effect: "none" } : createSessionTransportError())}\n`,
    );
    (deps.stderr ?? process.stderr).write(
      `${error instanceof Error ? error.message : "Session CLI failed."}\n`,
    );
    return usage ? 2 : 3;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runWithMateSessionCli(process.argv.slice(2));

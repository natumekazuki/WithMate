import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { APPROVAL_MODE_VALUES } from "../src/approval-mode.js";
import { CODEX_SANDBOX_MODE_VALUES } from "../src/codex-sandbox-mode.js";
import {
  SESSION_RUNTIME_DEFAULT_LIST_LIMIT,
  SESSION_RUNTIME_MAX_LIST_LIMIT,
  SESSION_RUNTIME_MAX_WAIT_TIMEOUT_MS,
  SESSION_RUNTIME_ERROR_SCHEMA_VERSION,
  SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
  SESSION_RUNTIME_RESULT_SCHEMA_VERSION,
  SessionRuntimeValidationError,
  createSessionRuntimeError,
  type SessionRuntimeEffect,
  type SessionRuntimeOperation,
  type SessionRuntimeRequestEnvelope,
} from "../src/session-external-runtime-contract.js";
import {
  SessionRuntimeClientError,
  callSessionRuntime,
  discoverSessionRuntime,
  type SessionRuntimeClientResponse,
  type SessionRuntimeConnection,
} from "./withmate-session-runtime-client.js";

type McpRuntimeDeps = {
  env?: NodeJS.ProcessEnv;
  discover?: typeof discoverSessionRuntime;
  call?: typeof callSessionRuntime;
  requestTimeoutMs?: number;
};

const reasoningEffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const nonEmptyStringSchema = z.string().trim().min(1);
const runtimeCatalogInputSchema = z.object({}).strict();
const turnSchema = z.object({
  userMessage: nonEmptyStringSchema,
  model: nonEmptyStringSchema,
  reasoningEffort: reasoningEffortSchema,
  approvalMode: z.enum(APPROVAL_MODE_VALUES),
  codexSandboxMode: z.enum(CODEX_SANDBOX_MODE_VALUES),
}).strict();
const mutationBaseShape = {
  sessionId: nonEmptyStringSchema,
  catalogRevision: z.number().int().min(1),
  idempotencyKey: nonEmptyStringSchema,
  turn: turnSchema,
};
const runInputSchema = z.object({
  ...mutationBaseShape,
  responseMode: z.enum(["wait", "deferred"]),
  waitTimeoutMs: z.number().int().min(1).max(SESSION_RUNTIME_MAX_WAIT_TIMEOUT_MS).optional(),
}).strict().superRefine((value, context) => {
  if (value.responseMode === "deferred" && value.waitTimeoutMs !== undefined) {
    context.addIssue({ code: "custom", path: ["waitTimeoutMs"], message: "waitTimeoutMs is only valid for wait mode." });
  }
});
const enqueueInputSchema = z.object(mutationBaseShape).strict();
const executionInputSchema = z.object({
  sessionId: nonEmptyStringSchema,
  executionId: nonEmptyStringSchema,
}).strict();
const cancelInputSchema = z.object({
  sessionId: nonEmptyStringSchema,
  executionId: nonEmptyStringSchema,
  idempotencyKey: nonEmptyStringSchema,
}).strict();
const listInputSchema = z.object({
  sessionId: nonEmptyStringSchema,
  limit: z.number().int().min(1).max(SESSION_RUNTIME_MAX_LIST_LIMIT).default(SESSION_RUNTIME_DEFAULT_LIST_LIMIT),
  cursor: nonEmptyStringSchema.optional(),
}).strict();

const publicDetailsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
const errorSchema = z.object({
  schemaVersion: z.literal(SESSION_RUNTIME_ERROR_SCHEMA_VERSION),
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    effect: z.enum(["not_applied", "applied", "indeterminate"]),
    details: publicDetailsSchema,
  }).strict(),
}).strict();

function createOutputSchema(operation: SessionRuntimeOperation) {
  return z.object({
    schemaVersion: z.union([
      z.literal(SESSION_RUNTIME_RESULT_SCHEMA_VERSION),
      z.literal(SESSION_RUNTIME_ERROR_SCHEMA_VERSION),
    ]),
    operation: z.literal(operation).optional(),
    result: z.unknown().optional(),
    error: errorSchema.shape.error.optional(),
  }).strict().superRefine((value, context) => {
    const success = value.schemaVersion === SESSION_RUNTIME_RESULT_SCHEMA_VERSION
      && value.operation === operation
      && value.result !== undefined
      && value.error === undefined;
    const failure = value.schemaVersion === SESSION_RUNTIME_ERROR_SCHEMA_VERSION
      && value.operation === undefined
      && value.result === undefined
      && value.error !== undefined;
    if (!success && !failure) {
      context.addIssue({ code: "custom", message: "Expected a Session runtime result or error envelope." });
    }
  });
}

export const SESSION_MCP_SERVER_INSTRUCTIONS = [
  "Operate only the WithMate Session explicitly identified in each tool input.",
  "Use idempotency keys when retrying effect-bearing operations.",
  "A failed terminal execution is a successful tool result; inspect execution.state and errorCode.",
].join(" ");

export const SESSION_MCP_TOOL_DEFINITIONS = [
  { name: "runtime.catalog", title: "Get runtime catalog", description: "Read the current public Provider and model catalog.", readOnly: true, destructive: false },
  { name: "turn.run", title: "Run Session turn", description: "Start one turn immediately in the specified Session.", readOnly: false, destructive: false },
  { name: "turn.enqueue", title: "Enqueue Session turn", description: "Append one turn to the specified Session FIFO queue.", readOnly: false, destructive: false },
  { name: "turn.list", title: "List Session executions", description: "List execution records for the specified Session.", readOnly: true, destructive: false },
  { name: "turn.get", title: "Get Session execution", description: "Read one execution from the specified Session.", readOnly: true, destructive: false },
  { name: "turn.cancel", title: "Cancel Session execution", description: "Cancel one queued or running execution in the specified Session.", readOnly: false, destructive: true },
] as const;

function annotations(definition: (typeof SESSION_MCP_TOOL_DEFINITIONS)[number]) {
  return {
    readOnlyHint: definition.readOnly,
    destructiveHint: definition.destructive,
    idempotentHint: true,
    openWorldHint: false,
  };
}

function isMutation(operation: SessionRuntimeOperation): boolean {
  return operation === "turn.run" || operation === "turn.enqueue" || operation === "turn.cancel";
}

function safeRuntimeError(value: unknown): ReturnType<typeof createSessionRuntimeError> | null {
  const parsed = errorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function safeRuntimeResult(operation: SessionRuntimeOperation, response: SessionRuntimeClientResponse): Record<string, unknown> | null {
  if (!response.value || typeof response.value !== "object" || Array.isArray(response.value)) return null;
  const value = response.value as Record<string, unknown>;
  if (
    value.schemaVersion !== SESSION_RUNTIME_RESULT_SCHEMA_VERSION
    || value.operation !== operation
    || !("result" in value)
    || Object.keys(value).some((key) => !["schemaVersion", "operation", "result"].includes(key))
  ) {
    return null;
  }
  return { schemaVersion: SESSION_RUNTIME_RESULT_SCHEMA_VERSION, operation, result: value.result };
}

function toolResult(value: Record<string, unknown>, isError: boolean) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

async function executeOperation(
  operation: SessionRuntimeOperation,
  input: unknown,
  deps: McpRuntimeDeps,
) {
  let connection: SessionRuntimeConnection | null;
  try {
    connection = await (deps.discover ?? discoverSessionRuntime)({ adapter: "mcp", env: deps.env });
  } catch {
    connection = null;
  }
  if (!connection) {
    return toolResult(createSessionRuntimeError({
      code: "RUNTIME_UNAVAILABLE",
      message: "WithMate Session runtime is not running.",
      retryable: true,
    }), true);
  }

  const envelope: SessionRuntimeRequestEnvelope = {
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation,
    input,
  };
  try {
    const response = await (deps.call ?? callSessionRuntime)(
      connection,
      envelope,
      AbortSignal.timeout(deps.requestTimeoutMs ?? 305_000),
    );
    const applicationError = safeRuntimeError(response.value);
    if (applicationError) return toolResult(applicationError, true);
    const result = safeRuntimeResult(operation, response);
    if (result) return toolResult(result, false);
    return toolResult(createTransportError(operation, true, "Session runtime returned an invalid public response."), true);
  } catch (error) {
    if (error instanceof SessionRuntimeValidationError) {
      return toolResult(createSessionRuntimeError({
        code: error.code,
        message: error.message,
        effect: "not_applied",
        details: error.details,
      }), true);
    }
    const dispatched = error instanceof SessionRuntimeClientError && error.dispatched;
    return toolResult(createTransportError(operation, dispatched, dispatched
      ? "Session runtime response was not received after dispatch."
      : "Session runtime is unavailable."), true);
  }
}

function createTransportError(
  operation: SessionRuntimeOperation,
  dispatched: boolean,
  message: string,
): ReturnType<typeof createSessionRuntimeError> {
  const effect: SessionRuntimeEffect = dispatched && isMutation(operation) ? "indeterminate" : "not_applied";
  return createSessionRuntimeError({ code: "RUNTIME_UNAVAILABLE", message, retryable: true, effect });
}

export function createWithMateSessionMcpServer(deps: McpRuntimeDeps = {}): McpServer {
  const server = new McpServer(
    { name: "withmate-session", version: "1.0.0" },
    { instructions: SESSION_MCP_SERVER_INSTRUCTIONS },
  );
  const definitions = new Map(SESSION_MCP_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]));

  server.registerTool("runtime.catalog", {
    ...definitions.get("runtime.catalog")!,
    annotations: annotations(definitions.get("runtime.catalog")!),
    inputSchema: runtimeCatalogInputSchema,
    outputSchema: createOutputSchema("runtime.catalog"),
  }, async (input) => executeOperation("runtime.catalog", input, deps));
  server.registerTool("turn.run", {
    ...definitions.get("turn.run")!,
    annotations: annotations(definitions.get("turn.run")!),
    inputSchema: runInputSchema,
    outputSchema: createOutputSchema("turn.run"),
  }, async (input) => executeOperation("turn.run", input, deps));
  server.registerTool("turn.enqueue", {
    ...definitions.get("turn.enqueue")!,
    annotations: annotations(definitions.get("turn.enqueue")!),
    inputSchema: enqueueInputSchema,
    outputSchema: createOutputSchema("turn.enqueue"),
  }, async (input) => executeOperation("turn.enqueue", input, deps));
  server.registerTool("turn.list", {
    ...definitions.get("turn.list")!,
    annotations: annotations(definitions.get("turn.list")!),
    inputSchema: listInputSchema,
    outputSchema: createOutputSchema("turn.list"),
  }, async (input) => executeOperation("turn.list", input, deps));
  server.registerTool("turn.get", {
    ...definitions.get("turn.get")!,
    annotations: annotations(definitions.get("turn.get")!),
    inputSchema: executionInputSchema,
    outputSchema: createOutputSchema("turn.get"),
  }, async (input) => executeOperation("turn.get", input, deps));
  server.registerTool("turn.cancel", {
    ...definitions.get("turn.cancel")!,
    annotations: annotations(definitions.get("turn.cancel")!),
    inputSchema: cancelInputSchema,
    outputSchema: createOutputSchema("turn.cancel"),
  }, async (input) => executeOperation("turn.cancel", input, deps));

  return server;
}

export async function startWithMateSessionMcpServer(deps: McpRuntimeDeps = {}): Promise<McpServer> {
  const server = createWithMateSessionMcpServer(deps);
  await server.connect(new StdioServerTransport());
  return server;
}

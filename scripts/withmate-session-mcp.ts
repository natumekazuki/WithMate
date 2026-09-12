import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { APPROVAL_MODE_VALUES } from "../src/approval-mode.js";
import { CODEX_SANDBOX_MODE_VALUES } from "../src/codex-sandbox-mode.js";
import {
  COORDINATION_EVENT_DEFAULT_LIST_LIMIT,
  COORDINATION_EVENT_KINDS,
  COORDINATION_EVENT_MAX_LIST_LIMIT,
  COORDINATION_EVENT_STATES,
} from "../src/coordination-event.js";
import {
  SESSION_TRANSCRIPT_INLINE_HARD_MAX_BYTES,
  SESSION_TRANSCRIPT_FOLDER_HARD_MAX_BYTES,
} from "../src/session-transcript.js";
import {
  WORK_ITEM_DEFAULT_LIST_LIMIT,
  WORK_ITEM_MAX_EVENT_PAYLOAD_BYTES,
  WORK_ITEM_MAX_MIGRATION_BASELINE_PAYLOAD_BYTES,
  WORK_ITEM_MAX_LIST_LIMIT,
  WORK_ITEM_MAX_RESULT_BYTES,
  WORK_ITEM_MAX_RESULT_ITEMS,
  WORK_ITEM_MAX_TEXT_LENGTH,
  WORK_ITEM_STATES,
  WORK_ITEM_AGGREGATION_DECISIONS,
  WORK_ITEM_AGGREGATION_DEFAULT_LIST_LIMIT,
  WORK_ITEM_AGGREGATION_MAX_LIST_LIMIT,
} from "../src/work-item.js";
import {
  SESSION_AUTHORITY_DECISION_CLASSES,
  SESSION_AUTHORITY_EFFECT_CLASSES,
  SESSION_AUTHORITY_RESOURCE_KINDS,
} from "../src/session-authority.js";
import {
  SESSION_RUNTIME_OPERATIONS,
  SESSION_RUNTIME_DEFAULT_LIST_LIMIT,
  SESSION_RUNTIME_DEFAULT_FILE_TEXT_BYTES,
  SESSION_RUNTIME_MAX_FILE_TEXT_BYTES,
  SESSION_RUNTIME_MAX_LIST_LIMIT,
  SESSION_RUNTIME_MAX_RESPONSE_BYTES,
  SESSION_RUNTIME_MAX_TURN_ATTACHMENTS,
  SESSION_RUNTIME_MAX_WAIT_TIMEOUT_MS,
  SESSION_RUNTIME_ERROR_SCHEMA_VERSION,
  SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
  SESSION_RUNTIME_RESULT_SCHEMA_VERSION,
  SessionRuntimeValidationError,
  createSessionRuntimeError,
  parseSessionRuntimeOperationInput,
  sessionRuntimeOperationMayHaveEffect,
  type SessionRuntimeEffect,
  type SessionRuntimeOperation,
  type SessionRuntimeRequestEnvelope,
} from "../src/session-external-runtime-contract.js";
import {
  SessionRuntimeClientError,
  SessionRuntimeDiscoveryError,
  callSessionRuntime,
  discoverSessionRuntime,
  mapSessionRuntimeDiscoveryCode,
  validateSessionRuntimeClientResponse,
  type SessionRuntimeClientResponse,
  type SessionRuntimeConnection,
} from "./withmate-session-runtime-client.js";

type McpRuntimeDeps = {
  env?: NodeJS.ProcessEnv;
  discover?: typeof discoverSessionRuntime;
  call?: typeof callSessionRuntime;
  requestTimeoutMs?: number;
};

import {
  createSessionRuntimeAdvertisedInputSchema,
  createSessionRuntimeOutputSchema,
} from "../src/session-external-runtime-schema.js";
export const SESSION_MCP_SERVER_INSTRUCTIONS = [
  "Use session.self only to resolve the bound actor Session; keep every target of other Session operations explicit.",
  "Generate, retain, and reuse the same caller-owned idempotency key when retrying effect-bearing operations.",
  "Use the target Session revision for work.create and turn.run/enqueue expectedContainerRevision, and the execution revision for turn.cancel expectedRevision; refresh after each mutation.",
  "Treat runtime.catalog authority operations as classifications, not current grants; baselineChildSessionRoleTemplates are grant issuance templates.",
  "Read budget.get before capacity-sensitive effects; soft-limit alerts guide Agent choices, while hard-limit and deadline errors block new effects. Root hard-limit and per-execution retry-limit increases require trusted user or issuer authority.",
  "Never answer a user_only interaction or create a user-principal receipt; provider approvals and elicitations require the trusted GUI.",
  "A failed terminal execution is a successful tool result; inspect execution.state and errorCode.",
  "Use a delegated Work Item to track one assignment across multiple executions; do not treat an execution as the Work Item identity.",
  "A delegated target reports its state and result while its creator alone can cancel it; a root owner keeps its self-owned Root Work Item current with work.revise and work.history.append.",
  "Coordination events are public records separate from the normal response; do not change the normal response format when recording one.",
  "Record a coordination event for a scope or policy decision, an ancestor or user decision request, a blocker opening or clearing, a major work milestone, or a correction.",
  "Use user_decision_required for user confirmation, selection, or free text; use blocker only for an external condition that prevents your work, and resolve your blocker after work can resume.",
  "A user may provide or revise a free-text response to your blocker until you apply and consume its latest resolutionSequence; this response does not resolve the blocker.",
  "Never record secrets, raw logs, stack traces, large diffs, provider responses, private reasoning, or personal environment paths.",
  "A progress or decision recording failure must not stop the normal response. If user_decision_required cannot be recorded, state the failure and a safe next action in the normal response.",
].join(" ");

export const SESSION_MCP_TOOL_DEFINITIONS = [
  { name: "runtime.catalog", title: "Get runtime catalog", description: "Read the current public Provider and model catalog.", readOnly: true, destructive: false },
  { name: "budget.get", title: "Get resource budget", description: "Read the resource budget account for one visible Session.", readOnly: true, destructive: false },
  { name: "budget.list", title: "List resource budgets", description: "List resource budget accounts visible within the bound actor's root.", readOnly: true, destructive: false },
  { name: "budget.configure", title: "Configure resource budget", description: "Configure limits within the actor's existing allocation; increasing a root hard limit requires trusted user authority.", readOnly: false, destructive: false },
  { name: "session.self", title: "Resolve actor Session", description: "Resolve the current provider actor Session from its runtime binding.", readOnly: true, destructive: false },
  { name: "session.create", title: "Create child Session", description: "Create an authorized child Session from the actor's current expectedContainerRevision and an explicit workspace.", readOnly: false, destructive: false },
  { name: "session.list", title: "List Sessions", description: "List normal Sessions with keyset pagination.", readOnly: true, destructive: false },
  { name: "session.get", title: "Get Session", description: "Read one normal Session.", readOnly: true, destructive: false },
  { name: "session.rename", title: "Rename Session", description: "Rename one normal Session.", readOnly: false, destructive: false },
  { name: "session.configure", title: "Configure Session", description: "Change one complete Session configuration tuple.", readOnly: false, destructive: false },
  { name: "session.move.manifest", title: "Preview Session move", description: "Read the resource closure required for a Session move.", readOnly: true, destructive: false },
  { name: "session.move", title: "Move Session", description: "Reparent or transfer one Session using a validated move manifest.", readOnly: false, destructive: false },
  { name: "session.clone", title: "Clone Session", description: "Clone a Session into an explicit placement.", readOnly: false, destructive: false },
  { name: "session.restore", title: "Restore Session", description: "Restore an archived root or child Session.", readOnly: false, destructive: false },
  { name: "session.archive", title: "Archive Session", description: "Archive a Session while retaining its history.", readOnly: false, destructive: false },
  { name: "session.delete.manifest", title: "Preview Session deletion", description: "Read the deletion manifest before physical deletion.", readOnly: true, destructive: false },
  { name: "session.delete", title: "Delete Session", description: "Physically delete a Session using the reviewed manifest revision.", readOnly: false, destructive: true },
  { name: "session.files.list", title: "List Session files", description: "List UTF-8-capable files in one SessionFolder.", readOnly: true, destructive: false },
  { name: "session.files.read_text", title: "Read Session text file", description: "Read one bounded UTF-8 text file from a SessionFolder.", readOnly: true, destructive: false },
  { name: "session.files.write_text", title: "Write Session text file", description: "Atomically write one bounded UTF-8 text file to a SessionFolder.", readOnly: false, destructive: true },
  { name: "work.create", title: "Create Work Item", description: "Create one stable delegated assignment at the target Session's current expectedContainerRevision.", readOnly: false, destructive: false },
  { name: "work.list", title: "List Work Items", description: "List visible Work Items with bounded keyset pagination.", readOnly: true, destructive: false },
  { name: "work.get", title: "Get Work Item", description: "Read one visible Work Item.", readOnly: true, destructive: false },
  { name: "work.revise", title: "Revise Root Work Item", description: "Revise the bound root Work Item contract.", readOnly: false, destructive: false },
  { name: "work.reassign", title: "Reassign Work Item", description: "Transfer an assignment to another authorized target using an explicit transfer policy.", readOnly: false, destructive: false },
  { name: "work.move", title: "Move Work Item", description: "Move an assignment to another parent while preserving assignment history.", readOnly: false, destructive: false },
  { name: "work.clone", title: "Clone Work Item", description: "Clone only the Work Item contract into a new identity.", readOnly: false, destructive: false },
  { name: "work.reopen", title: "Reopen Work Item", description: "Create a successor for a terminal Work Item while retaining its result.", readOnly: false, destructive: false },
  { name: "work.archive", title: "Archive Work Item", description: "Archive a Work Item while retaining its history.", readOnly: false, destructive: false },
  { name: "work.restore", title: "Restore Work Item", description: "Restore an archived Work Item through a new lifecycle revision.", readOnly: false, destructive: false },
  { name: "work.delete", title: "Delete Work Item", description: "Delete an eligible Work Item and retain its replay tombstone.", readOnly: false, destructive: true },
  { name: "work.history.append", title: "Append Work Item history", description: "Record progress or handoff history for the bound root Work Item.", readOnly: false, destructive: false },
  { name: "work.history.list", title: "List Work Item history", description: "Read bounded Work Item history.", readOnly: true, destructive: false },
  { name: "work.transition", title: "Transition Work Item", description: "Start, wait, or resume a Work Item assigned to the bound Session.", readOnly: false, destructive: false },
  { name: "work.result", title: "Report Work Item result", description: "Atomically report a strict result and terminal Work Item state.", readOnly: false, destructive: false },
  { name: "work.result.correct", title: "Correct Work Item result", description: "Append a corrected terminal result revision and propagate stale state.", readOnly: false, destructive: false },
  { name: "work.cancel", title: "Cancel Work Item", description: "Cancel an active Work Item created by the bound Session.", readOnly: false, destructive: true },
  { name: "work.aggregation.get", title: "Get Work Item aggregation", description: "Get bounded aggregation counts for one parent Work Item.", readOnly: true, destructive: false },
  { name: "work.aggregation.list", title: "List Work Item aggregation", description: "List descendant summaries and decisions using bounded depth, filters, and a cursor.", readOnly: true, destructive: false },
  { name: "work.aggregation.decide", title: "Decide Work Item result", description: "Accept or exclude one terminal direct child result.", readOnly: false, destructive: false },
  { name: "work.aggregation.retry", title: "Retry Work Item result", description: "Atomically record a retry decision and create its replacement Work Item.", readOnly: false, destructive: false },
  { name: "work.aggregation.correct", title: "Correct Work Item aggregation", description: "Correct an immutable child decision with an explicit current result revision.", readOnly: false, destructive: false },
  { name: "turn.options", title: "Get Session turn options", description: "Read valid turn options for one normal Session.", readOnly: true, destructive: false },
  { name: "turn.run", title: "Run Session turn", description: "Start one turn immediately at the target Session's current expectedContainerRevision.", readOnly: false, destructive: true },
  { name: "turn.enqueue", title: "Enqueue Session turn", description: "Append one turn at the target Session's current expectedContainerRevision.", readOnly: false, destructive: true },
  { name: "turn.list", title: "List Session executions", description: "List execution records for the specified Session.", readOnly: true, destructive: false },
  { name: "turn.get", title: "Get Session execution", description: "Read one execution from the specified Session.", readOnly: true, destructive: false },
  { name: "turn.cancel", title: "Cancel Session execution", description: "Cancel one queued or running execution at its current expectedRevision.", readOnly: false, destructive: true },
  { name: "interaction.list", title: "List Session interactions", description: "List public interactions for the specified Session.", readOnly: true, destructive: false },
  { name: "interaction.respond", title: "Respond to Session interaction", description: "Respond at the current expectedRevision only when the stored decisionClass permits the Agent principal; provider approvals and elicitations are user_only.", readOnly: false, destructive: true },
  { name: "coordination.event.create", title: "Create coordination event", description: "Record a public coordination event at the actor's current expectedContainerRevision and return its stable eventId.", readOnly: false, destructive: false },
  { name: "coordination.event.list", title: "List coordination events", description: "List visible coordination event summaries, including each stable eventId.", readOnly: true, destructive: false },
  { name: "coordination.event.get", title: "Get coordination event", description: "Read one visible coordination event by eventId, or recover it and its stable eventId by the create idempotencyKey.", readOnly: true, destructive: false },
  { name: "coordination.event.resolve", title: "Resolve coordination event", description: "Resolve an authorized escalation or blocker using the exact eventId returned by create, list, or get.", readOnly: false, destructive: false },
  { name: "coordination.event.consume", title: "Consume coordination response", description: "Mark the exact user decision answer or blocker response identified by expectedResolutionSequence as applied by its owner Session. Consuming a blocker response does not resolve the blocker.", readOnly: false, destructive: false },
  { name: "coordination.event.cancel", title: "Cancel coordination event", description: "Cancel an open coordination event created by the bound Session.", readOnly: false, destructive: true },
  { name: "coordination.event.correct", title: "Correct coordination event", description: "Append a correction and supersede an event created by the bound Session.", readOnly: false, destructive: true },
  { name: "transcript.export", title: "Export Session transcript", description: "Export a Session transcript inline or into its SessionFolder.", readOnly: false, destructive: true },
] as const;

function annotations(definition: (typeof SESSION_MCP_TOOL_DEFINITIONS)[number]) {
  return {
    readOnlyHint: definition.readOnly,
    destructiveHint: definition.destructive,
    idempotentHint: true,
    openWorldHint: definition.name === "turn.run" || definition.name === "turn.enqueue"
      || definition.name === "interaction.respond" || definition.name === "transcript.export",
  };
}

function toolResult(value: Record<string, unknown>, isError: boolean) {
  if (isError) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(value) }],
      isError: true as const,
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

async function executeOperation(
  operation: SessionRuntimeOperation,
  input: unknown,
  deps: McpRuntimeDeps,
) {
  let parsedInput: unknown;
  try {
    parsedInput = parseSessionRuntimeOperationInput(operation, input);
  } catch (error) {
    if (error instanceof SessionRuntimeValidationError) {
      return toolResult(createSessionRuntimeError({
        code: error.code,
        message: error.message,
        effect: "not_applied",
        details: error.details,
      }), true);
    }
    throw error;
  }
  let connection: SessionRuntimeConnection | null;
  try {
    connection = await (deps.discover ?? discoverSessionRuntime)({ adapter: "mcp", env: deps.env });
  } catch (error) {
    if (error instanceof SessionRuntimeDiscoveryError) {
      return toolResult(createSessionRuntimeError({
        code: mapSessionRuntimeDiscoveryCode(error.code),
        message: "WithMate Session runtime discovery could not select a runtime.",
        retryable: error.code === "runtime_unavailable" || error.code === "runtime_stale",
      }), true);
    }
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
    input: parsedInput,
  };
  try {
    const candidate = await (deps.call ?? callSessionRuntime)(
      connection,
      envelope,
      AbortSignal.timeout(deps.requestTimeoutMs ?? 305_000),
    );
    const response = validateSessionRuntimeClientResponse(operation, candidate);
    return response.ok
      ? toolResult(response.value as unknown as Record<string, unknown>, false)
      : toolResult(response.value as unknown as Record<string, unknown>, true);
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
    return toolResult(createTransportError(operation, parsedInput, dispatched, dispatched
      ? "Session runtime response was not received after dispatch."
      : "Session runtime is unavailable."), true);
  }
}

function createTransportError(
  operation: SessionRuntimeOperation,
  input: unknown,
  dispatched: boolean,
  message: string,
): ReturnType<typeof createSessionRuntimeError> {
  const effect: SessionRuntimeEffect = dispatched && sessionRuntimeOperationMayHaveEffect(operation, input)
    ? "indeterminate"
    : "not_applied";
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
    inputSchema: createSessionRuntimeAdvertisedInputSchema("runtime.catalog"),
    outputSchema: createSessionRuntimeOutputSchema("runtime.catalog"),
  }, async (input) => executeOperation("runtime.catalog", input, deps));
  server.registerTool("budget.get", {
    ...definitions.get("budget.get")!,
    annotations: annotations(definitions.get("budget.get")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("budget.get"),
    outputSchema: createSessionRuntimeOutputSchema("budget.get"),
  }, async (input) => executeOperation("budget.get", input, deps));
  server.registerTool("budget.list", {
    ...definitions.get("budget.list")!,
    annotations: annotations(definitions.get("budget.list")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("budget.list"),
    outputSchema: createSessionRuntimeOutputSchema("budget.list"),
  }, async (input) => executeOperation("budget.list", input, deps));
  server.registerTool("budget.configure", {
    ...definitions.get("budget.configure")!,
    annotations: annotations(definitions.get("budget.configure")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("budget.configure"),
    outputSchema: createSessionRuntimeOutputSchema("budget.configure"),
  }, async (input) => executeOperation("budget.configure", input, deps));
  server.registerTool("session.self", {
    ...definitions.get("session.self")!,
    annotations: annotations(definitions.get("session.self")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("runtime.catalog"),
    outputSchema: createSessionRuntimeOutputSchema("session.self"),
  }, async (input) => executeOperation("session.self", input, deps));
  server.registerTool("session.create", {
    ...definitions.get("session.create")!,
    annotations: annotations(definitions.get("session.create")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("session.create"),
    outputSchema: createSessionRuntimeOutputSchema("session.create"),
  }, async (input) => executeOperation("session.create", input, deps));
  server.registerTool("session.list", {
    ...definitions.get("session.list")!,
    annotations: annotations(definitions.get("session.list")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("session.list"),
    outputSchema: createSessionRuntimeOutputSchema("session.list"),
  }, async (input) => executeOperation("session.list", input, deps));
  server.registerTool("session.get", {
    ...definitions.get("session.get")!,
    annotations: annotations(definitions.get("session.get")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("session.get"),
    outputSchema: createSessionRuntimeOutputSchema("session.get"),
  }, async (input) => executeOperation("session.get", input, deps));
  server.registerTool("session.rename", {
    ...definitions.get("session.rename")!,
    annotations: annotations(definitions.get("session.rename")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("session.rename"),
    outputSchema: createSessionRuntimeOutputSchema("session.rename"),
  }, async (input) => executeOperation("session.rename", input, deps));
  server.registerTool("session.configure", { ...definitions.get("session.configure")!, annotations: annotations(definitions.get("session.configure")!), inputSchema: createSessionRuntimeAdvertisedInputSchema("session.configure"), outputSchema: createSessionRuntimeOutputSchema("session.configure") }, async (input) => executeOperation("session.configure", input, deps));
  server.registerTool("session.move.manifest", { ...definitions.get("session.move.manifest")!, annotations: annotations(definitions.get("session.move.manifest")!), inputSchema: createSessionRuntimeAdvertisedInputSchema("session.move.manifest"), outputSchema: createSessionRuntimeOutputSchema("session.move.manifest") }, async (input) => executeOperation("session.move.manifest", input, deps));
  server.registerTool("session.move", { ...definitions.get("session.move")!, annotations: annotations(definitions.get("session.move")!), inputSchema: createSessionRuntimeAdvertisedInputSchema("session.move"), outputSchema: createSessionRuntimeOutputSchema("session.move") }, async (input) => executeOperation("session.move", input, deps));
  server.registerTool("session.clone", { ...definitions.get("session.clone")!, annotations: annotations(definitions.get("session.clone")!), inputSchema: createSessionRuntimeAdvertisedInputSchema("session.clone"), outputSchema: createSessionRuntimeOutputSchema("session.clone") }, async (input) => executeOperation("session.clone", input, deps));
  server.registerTool("session.restore", { ...definitions.get("session.restore")!, annotations: annotations(definitions.get("session.restore")!), inputSchema: createSessionRuntimeAdvertisedInputSchema("session.restore"), outputSchema: createSessionRuntimeOutputSchema("session.restore") }, async (input) => executeOperation("session.restore", input, deps));
  server.registerTool("session.archive", { ...definitions.get("session.archive")!, annotations: annotations(definitions.get("session.archive")!), inputSchema: createSessionRuntimeAdvertisedInputSchema("session.archive"), outputSchema: createSessionRuntimeOutputSchema("session.archive") }, async (input) => executeOperation("session.archive", input, deps));
  server.registerTool("session.delete.manifest", { ...definitions.get("session.delete.manifest")!, annotations: annotations(definitions.get("session.delete.manifest")!), inputSchema: createSessionRuntimeAdvertisedInputSchema("session.delete.manifest"), outputSchema: createSessionRuntimeOutputSchema("session.delete.manifest") }, async (input) => executeOperation("session.delete.manifest", input, deps));
  server.registerTool("session.delete", { ...definitions.get("session.delete")!, annotations: annotations(definitions.get("session.delete")!), inputSchema: createSessionRuntimeAdvertisedInputSchema("session.delete"), outputSchema: createSessionRuntimeOutputSchema("session.delete") }, async (input) => executeOperation("session.delete", input, deps));
  server.registerTool("session.files.list", {
    ...definitions.get("session.files.list")!,
    annotations: annotations(definitions.get("session.files.list")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("session.files.list"),
    outputSchema: createSessionRuntimeOutputSchema("session.files.list"),
  }, async (input) => executeOperation("session.files.list", input, deps));
  server.registerTool("session.files.read_text", {
    ...definitions.get("session.files.read_text")!,
    annotations: annotations(definitions.get("session.files.read_text")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("session.files.read_text"),
    outputSchema: createSessionRuntimeOutputSchema("session.files.read_text"),
  }, async (input) => executeOperation("session.files.read_text", input, deps));
  server.registerTool("session.files.write_text", {
    ...definitions.get("session.files.write_text")!,
    annotations: annotations(definitions.get("session.files.write_text")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("session.files.write_text"),
    outputSchema: createSessionRuntimeOutputSchema("session.files.write_text"),
  }, async (input) => executeOperation("session.files.write_text", input, deps));
  server.registerTool("work.create", {
    ...definitions.get("work.create")!, annotations: annotations(definitions.get("work.create")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("work.create"), outputSchema: createSessionRuntimeOutputSchema("work.create"),
  }, async (input) => executeOperation("work.create", input, deps));
  server.registerTool("work.list", {
    ...definitions.get("work.list")!, annotations: annotations(definitions.get("work.list")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("work.list"), outputSchema: createSessionRuntimeOutputSchema("work.list"),
  }, async (input) => executeOperation("work.list", input, deps));
  server.registerTool("work.get", {
    ...definitions.get("work.get")!, annotations: annotations(definitions.get("work.get")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("work.get"), outputSchema: createSessionRuntimeOutputSchema("work.get"),
  }, async (input) => executeOperation("work.get", input, deps));
  server.registerTool("work.revise", { ...definitions.get("work.revise")!, annotations: annotations(definitions.get("work.revise")!), inputSchema: createSessionRuntimeAdvertisedInputSchema("work.revise"), outputSchema: createSessionRuntimeOutputSchema("work.revise") }, async (input) => executeOperation("work.revise", input, deps));
  for (const operation of ["work.reassign", "work.move", "work.clone", "work.reopen", "work.archive", "work.restore", "work.delete"] as const) {
    server.registerTool(operation, { ...definitions.get(operation)!, annotations: annotations(definitions.get(operation)!), inputSchema: createSessionRuntimeAdvertisedInputSchema(operation), outputSchema: createSessionRuntimeOutputSchema(operation) }, async (input) => executeOperation(operation, input, deps));
  }
  server.registerTool("work.history.append", { ...definitions.get("work.history.append")!, annotations: annotations(definitions.get("work.history.append")!), inputSchema: createSessionRuntimeAdvertisedInputSchema("work.history.append"), outputSchema: createSessionRuntimeOutputSchema("work.history.append") }, async (input) => executeOperation("work.history.append", input, deps));
  server.registerTool("work.history.list", { ...definitions.get("work.history.list")!, annotations: annotations(definitions.get("work.history.list")!), inputSchema: createSessionRuntimeAdvertisedInputSchema("work.history.list"), outputSchema: createSessionRuntimeOutputSchema("work.history.list") }, async (input) => executeOperation("work.history.list", input, deps));
  server.registerTool("work.transition", {
    ...definitions.get("work.transition")!, annotations: annotations(definitions.get("work.transition")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("work.transition"), outputSchema: createSessionRuntimeOutputSchema("work.transition"),
  }, async (input) => executeOperation("work.transition", input, deps));
  server.registerTool("work.result", {
    ...definitions.get("work.result")!, annotations: annotations(definitions.get("work.result")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("work.result"), outputSchema: createSessionRuntimeOutputSchema("work.result"),
  }, async (input) => executeOperation("work.result", input, deps));
  server.registerTool("work.result.correct", {
    ...definitions.get("work.result.correct")!, annotations: annotations(definitions.get("work.result.correct")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("work.result.correct"), outputSchema: createSessionRuntimeOutputSchema("work.result.correct"),
  }, async (input) => executeOperation("work.result.correct", input, deps));
  server.registerTool("work.cancel", {
    ...definitions.get("work.cancel")!, annotations: annotations(definitions.get("work.cancel")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("work.cancel"), outputSchema: createSessionRuntimeOutputSchema("work.cancel"),
  }, async (input) => executeOperation("work.cancel", input, deps));
  server.registerTool("work.aggregation.get", {
    ...definitions.get("work.aggregation.get")!, annotations: annotations(definitions.get("work.aggregation.get")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("work.aggregation.get"), outputSchema: createSessionRuntimeOutputSchema("work.aggregation.get"),
  }, async (input) => executeOperation("work.aggregation.get", input, deps));
  server.registerTool("work.aggregation.list", {
    ...definitions.get("work.aggregation.list")!, annotations: annotations(definitions.get("work.aggregation.list")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("work.aggregation.list"), outputSchema: createSessionRuntimeOutputSchema("work.aggregation.list"),
  }, async (input) => executeOperation("work.aggregation.list", input, deps));
  server.registerTool("work.aggregation.decide", {
    ...definitions.get("work.aggregation.decide")!, annotations: annotations(definitions.get("work.aggregation.decide")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("work.aggregation.decide"), outputSchema: createSessionRuntimeOutputSchema("work.aggregation.decide"),
  }, async (input) => executeOperation("work.aggregation.decide", input, deps));
  server.registerTool("work.aggregation.retry", {
    ...definitions.get("work.aggregation.retry")!, annotations: annotations(definitions.get("work.aggregation.retry")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("work.aggregation.retry"), outputSchema: createSessionRuntimeOutputSchema("work.aggregation.retry"),
  }, async (input) => executeOperation("work.aggregation.retry", input, deps));
  server.registerTool("work.aggregation.correct", {
    ...definitions.get("work.aggregation.correct")!, annotations: annotations(definitions.get("work.aggregation.correct")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("work.aggregation.correct"), outputSchema: createSessionRuntimeOutputSchema("work.aggregation.correct"),
  }, async (input) => executeOperation("work.aggregation.correct", input, deps));
  server.registerTool("turn.options", {
    ...definitions.get("turn.options")!,
    annotations: annotations(definitions.get("turn.options")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("session.get"),
    outputSchema: createSessionRuntimeOutputSchema("turn.options"),
  }, async (input) => executeOperation("turn.options", input, deps));
  server.registerTool("turn.run", {
    ...definitions.get("turn.run")!,
    annotations: annotations(definitions.get("turn.run")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("turn.run"),
    outputSchema: createSessionRuntimeOutputSchema("turn.run"),
  }, async (input) => executeOperation("turn.run", input, deps));
  server.registerTool("turn.enqueue", {
    ...definitions.get("turn.enqueue")!,
    annotations: annotations(definitions.get("turn.enqueue")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("turn.enqueue"),
    outputSchema: createSessionRuntimeOutputSchema("turn.enqueue"),
  }, async (input) => executeOperation("turn.enqueue", input, deps));
  server.registerTool("turn.list", {
    ...definitions.get("turn.list")!,
    annotations: annotations(definitions.get("turn.list")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("turn.list"),
    outputSchema: createSessionRuntimeOutputSchema("turn.list"),
  }, async (input) => executeOperation("turn.list", input, deps));
  server.registerTool("turn.get", {
    ...definitions.get("turn.get")!,
    annotations: annotations(definitions.get("turn.get")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("turn.get"),
    outputSchema: createSessionRuntimeOutputSchema("turn.get"),
  }, async (input) => executeOperation("turn.get", input, deps));
  server.registerTool("turn.cancel", {
    ...definitions.get("turn.cancel")!,
    annotations: annotations(definitions.get("turn.cancel")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("turn.cancel"),
    outputSchema: createSessionRuntimeOutputSchema("turn.cancel"),
  }, async (input) => executeOperation("turn.cancel", input, deps));
  server.registerTool("interaction.list", {
    ...definitions.get("interaction.list")!,
    annotations: annotations(definitions.get("interaction.list")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("interaction.list"),
    outputSchema: createSessionRuntimeOutputSchema("interaction.list"),
  }, async (input) => executeOperation("interaction.list", input, deps));
  server.registerTool("interaction.respond", {
    ...definitions.get("interaction.respond")!,
    annotations: annotations(definitions.get("interaction.respond")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("interaction.respond"),
    outputSchema: createSessionRuntimeOutputSchema("interaction.respond"),
  }, async (input) => executeOperation("interaction.respond", input, deps));
  server.registerTool("coordination.event.create", {
    ...definitions.get("coordination.event.create")!, annotations: annotations(definitions.get("coordination.event.create")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("coordination.event.create"), outputSchema: createSessionRuntimeOutputSchema("coordination.event.create"),
  }, async (input) => executeOperation("coordination.event.create", input, deps));
  server.registerTool("coordination.event.list", {
    ...definitions.get("coordination.event.list")!, annotations: annotations(definitions.get("coordination.event.list")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("coordination.event.list"), outputSchema: createSessionRuntimeOutputSchema("coordination.event.list"),
  }, async (input) => executeOperation("coordination.event.list", input, deps));
  server.registerTool("coordination.event.get", {
    ...definitions.get("coordination.event.get")!, annotations: annotations(definitions.get("coordination.event.get")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("coordination.event.get"), outputSchema: createSessionRuntimeOutputSchema("coordination.event.get"),
  }, async (input) => executeOperation("coordination.event.get", input, deps));
  server.registerTool("coordination.event.resolve", {
    ...definitions.get("coordination.event.resolve")!, annotations: annotations(definitions.get("coordination.event.resolve")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("coordination.event.resolve"), outputSchema: createSessionRuntimeOutputSchema("coordination.event.resolve"),
  }, async (input) => executeOperation("coordination.event.resolve", input, deps));
  server.registerTool("coordination.event.consume", {
    ...definitions.get("coordination.event.consume")!, annotations: annotations(definitions.get("coordination.event.consume")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("coordination.event.consume"), outputSchema: createSessionRuntimeOutputSchema("coordination.event.consume"),
  }, async (input) => executeOperation("coordination.event.consume", input, deps));
  server.registerTool("coordination.event.cancel", {
    ...definitions.get("coordination.event.cancel")!, annotations: annotations(definitions.get("coordination.event.cancel")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("coordination.event.cancel"), outputSchema: createSessionRuntimeOutputSchema("coordination.event.cancel"),
  }, async (input) => executeOperation("coordination.event.cancel", input, deps));
  server.registerTool("coordination.event.correct", {
    ...definitions.get("coordination.event.correct")!, annotations: annotations(definitions.get("coordination.event.correct")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("coordination.event.correct"), outputSchema: createSessionRuntimeOutputSchema("coordination.event.correct"),
  }, async (input) => executeOperation("coordination.event.correct", input, deps));
  server.registerTool("transcript.export", {
    ...definitions.get("transcript.export")!,
    annotations: annotations(definitions.get("transcript.export")!),
    inputSchema: createSessionRuntimeAdvertisedInputSchema("transcript.export"),
    outputSchema: createSessionRuntimeOutputSchema("transcript.export"),
  }, async (input) => executeOperation("transcript.export", input, deps));

  return server;
}

export async function startWithMateSessionMcpServer(deps: McpRuntimeDeps = {}): Promise<McpServer> {
  const server = createWithMateSessionMcpServer(deps);
  await server.connect(new StdioServerTransport());
  return server;
}

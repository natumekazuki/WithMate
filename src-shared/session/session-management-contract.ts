import { z } from "zod";
import { SESSION_TURN_CLIENT_REQUEST_ID_PATTERN } from "./runtime-state.js";
import { sessionTargetSchema } from "./session-target.js";
import {
  executionOperationRequestSchemas,
  executionOperationResultSchemas,
  EXECUTION_OPERATION_DESCRIPTIONS,
} from "./session-execution-read.js";
import {
  sessionCoordinationRequestSchemas,
  sessionCoordinationSuccessSchemas,
  SESSION_COORDINATION_DESCRIPTIONS,
} from "./session-coordination-contract.js";
import { APPROVAL_MODE_VALUES } from "../settings/approval-mode.js";
import { CODEX_SANDBOX_MODE_VALUES } from "../settings/codex-sandbox-mode.js";
import { SESSION_HISTORY_USAGE_NOTICE } from "../session-history/session-history-contract.js";
export { sessionTargetSchema, type SessionTarget } from "./session-target.js";

const id = z.string().trim().min(1).max(256);
const queueRequestId = z.string().trim().regex(SESSION_TURN_CLIENT_REQUEST_ID_PATTERN, "requestId must be a UUID.");
const page = {
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(100).optional(),
};
const provider = z.enum(["codex", "copilot", "claude", "opencode"]);
const child = z
  .object({
    requestId: id,
    role: z.enum(["task-coordinator", "executor"]),
    provider,
    model: z.string().min(1).max(500),
    reasoningEffort: z.string().max(100),
    approvalMode: z.enum(APPROVAL_MODE_VALUES),
    codexSandboxMode: z.enum(CODEX_SANDBOX_MODE_VALUES).optional(),
    workspacePath: z.string().min(1).max(32768),
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(10000).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.provider === "codex"
        ? value.codexSandboxMode !== undefined
        : value.codexSandboxMode === undefined,
    "Codex requires codexSandboxMode; other Providers do not accept this unsupported setting.",
  );
export const sessionOperationRequestSchemas = {
  ...executionOperationRequestSchemas,
  ...sessionCoordinationRequestSchemas,
  create_child: child,
  get_catalog: z
    .object({
      provider: provider.optional(),
      workspacePath: z.string().min(1).max(32768).optional(),
    })
    .strict(),
  self: z.object({}).strict(),
  list: z
    .object({
      rootSessionId: id.optional(),
      allCrews: z.boolean().optional(),
      role: z
        .enum([
          "standalone",
          "overall-coordinator",
          "task-coordinator",
          "executor",
          "auxiliary",
        ])
        .optional(),
      relationship: z.enum(["all", "created", "creator"]).optional(),
      searchText: z.string().max(1000).optional(),
      ...page,
    })
    .strict(),
  get: z.object({ target: sessionTargetSchema }).strict(),
  update_metadata: z
    .object({
      title: z.string().trim().min(1).max(500).optional(),
      description: z.string().max(10000).optional(),
    })
    .strict()
    .refine(
      (value) => value.title !== undefined || value.description !== undefined,
      "Title or description is required.",
    ),
  enqueue: z
    .object({
      target: sessionTargetSchema,
      requestId: queueRequestId,
      message: z.string().trim().min(1).max(100000),
      deliveryTiming: z.enum(["immediate", "after_source_turn"]).optional(),
    })
    .strict(),
  get_receipt: z
    .object({ target: sessionTargetSchema, requestId: queueRequestId })
    .strict(),
  cancel_receipt: z
    .object({ target: sessionTargetSchema, receiptId: id })
    .strict(),
  stop_turn: z.object({ target: sessionTargetSchema, turnId: id }).strict(),
} as const;
export type SessionOperation = keyof typeof sessionOperationRequestSchemas;
export type SessionOperationRequest<K extends SessionOperation> = z.infer<
  (typeof sessionOperationRequestSchemas)[K]
>;
export type SessionOperationResult =
  | { ok: true; [key: string]: unknown }
  | {
      ok: false;
      code: string;
      message?: string;
      effect: "none" | "unknown";
      [key: string]: unknown;
    };
export const sessionOperationFailureSchema = z
  .object({
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string().optional(),
    effect: z.enum(["none", "unknown"]),
  })
  .passthrough();
export const sessionOperationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).passthrough(),
  sessionOperationFailureSchema,
]);
const relatedSessionSchema = z
  .object({
    id,
    incarnationId: id,
    kind: z.enum(["main", "auxiliary"]),
    role: z.enum([
      "standalone",
      "overall-coordinator",
      "task-coordinator",
      "executor",
      "auxiliary",
    ]),
    sessionRole: z.enum([
      "standalone",
      "overall-coordinator",
      "task-coordinator",
      "executor",
    ]),
    rootSessionId: id,
    parentSessionId: id.nullable(),
    createdBySessionId: id.nullable(),
    mainSessionId: id,
    mainIncarnationId: id,
    title: z.string(),
    description: z.string(),
    runState: z.string(),
  })
  .passthrough();
const crewFolderSchema = z
  .object({ rootSessionId: id, path: z.string().min(1) })
  .strict();
const receiptSchema = z
  .object({
    id,
    requestId: id,
    sessionId: id,
    incarnationId: id,
    state: z.enum([
      "queued",
      "starting",
      "running",
      "completed",
      "failed",
      "canceled",
      "interrupted",
    ]),
    turnId: z.string().nullable(),
    sourceTurnPhase: z
      .enum(["running", "completed", "failed", "canceled", "unknown"])
      .optional(),
    sourceTurnPendingRelease: z.boolean().optional(),
  })
  .passthrough();
export const sessionOperationSuccessSchemas = {
  ...executionOperationResultSchemas,
  ...sessionCoordinationSuccessSchemas,
  create_child: z
    .object({
      ok: z.literal(true),
      session: relatedSessionSchema,
      character: z.object({ id: z.string(), name: z.string() }).strict(),
      provider,
      workspacePath: z.string(),
      executionOptions: z
        .object({
          model: z.string(),
          reasoningEffort: z.string(),
          approvalMode: z.enum(APPROVAL_MODE_VALUES),
          codexSandboxMode: z.enum(CODEX_SANDBOX_MODE_VALUES),
        })
        .passthrough(),
    })
    .strict(),
  get_catalog: z
    .object({
      ok: z.literal(true),
      catalog: z
        .object({
          providers: z.array(
            z
              .object({
                id: z.string(),
                models: z.array(
                  z
                    .object({
                      id: z.string(),
                      reasoningEfforts: z.array(z.string()),
                    })
                    .passthrough(),
                ),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
      options: z.array(
        z
          .object({
            provider: z.string(),
            approvalModes: z.array(
              z.object({ value: z.string(), label: z.string() }).passthrough(),
            ),
            sandboxModes: z.array(
              z.object({ value: z.string(), label: z.string() }).passthrough(),
            ),
          })
          .strict(),
      ),
    })
    .strict(),
  self: z
    .object({
      ok: z.literal(true),
      session: relatedSessionSchema,
      currentTurn: z
        .object({
          turnId: z.string().nullable(),
          receipt: z.unknown().nullable(),
          origin: z.unknown().nullable(),
        })
        .strict(),
      crewFolder: crewFolderSchema,
    })
    .strict(),
  list: z
    .object({
      ok: z.literal(true),
      entries: z.array(relatedSessionSchema),
      total: z.number().int().nonnegative(),
      hasMore: z.boolean(),
    })
    .strict(),
  get: z
    .object({
      ok: z.literal(true),
      session: relatedSessionSchema,
      crewFolder: crewFolderSchema,
    })
    .strict(),
  update_metadata: z
    .object({
      ok: z.literal(true),
      metadata: z.union([
        z
          .object({ id, taskTitle: z.string(), description: z.string() })
          .passthrough(),
        z
          .object({ id, title: z.string(), description: z.string() })
          .passthrough(),
      ]),
    })
    .strict(),
  enqueue: z.object({ ok: z.literal(true), receipt: receiptSchema }).strict(),
  get_receipt: z
    .object({ ok: z.literal(true), receipt: receiptSchema.nullable() })
    .strict(),
  cancel_receipt: z
    .object({
      ok: z.literal(true),
      result: z
        .object({
          outcome: z.enum(["applied", "not-applied"]),
          receipt: receiptSchema,
        })
        .strict(),
    })
    .strict(),
  stop_turn: z
    .object({
      ok: z.literal(true),
      result: z
        .object({
          outcome: z.enum(["applied", "not-applied"]),
          turnId: z.string().nullable(),
        })
        .strict(),
    })
    .strict(),
} as const;
/** MCP requires an object root; both successful and error structured content are public results. */
export function sessionOperationOutputSchema(operation: SessionOperation) {
  return z
    .object({ ok: z.boolean() })
    .passthrough()
    .meta({
      anyOf: [
        z.toJSONSchema(sessionOperationSuccessSchemas[operation], {
          unrepresentable: "any",
        }),
        z.toJSONSchema(sessionOperationFailureSchema),
      ],
    });
}
export const SESSION_RUNTIME_OPERATION_PATHS = Object.fromEntries(
  Object.keys(sessionOperationRequestSchemas).map((key) => [
    key,
    `/v1/session/${key.replaceAll("_", "-")}`,
  ]),
) as Record<SessionOperation, string>;
export const sessionRuntimeOperationByPath = new Map(
  Object.entries(SESSION_RUNTIME_OPERATION_PATHS).map(([operation, path]) => [
    path,
    operation as SessionOperation,
  ]),
);
export const sessionAgentRuntimeOperation = (
  operation: SessionOperation,
): string => `session.route.${operation}`;
export const getSessionAgentRuntimeOperations = (): string[] =>
  Object.keys(sessionOperationRequestSchemas).map((operation) =>
    sessionAgentRuntimeOperation(operation as SessionOperation),
  );
export const SESSION_TOOL_OPERATIONS = Object.fromEntries(
  Object.keys(sessionOperationRequestSchemas).map((operation) => [
    `session.${operation}`,
    sessionAgentRuntimeOperation(operation as SessionOperation),
  ]),
);
export const SESSION_READ_OPERATIONS: readonly SessionOperation[] = [
  "self",
  "list",
  "get",
  "get_receipt",
  "get_catalog",
  "coordination_list",
  "coordination_get",
  ...(Object.keys(
    executionOperationRequestSchemas,
  ) as (keyof typeof executionOperationRequestSchemas)[]),
];
export const SESSION_OPERATION_DESCRIPTIONS: Record<SessionOperation, string> =
  {
    ...(Object.fromEntries(
      Object.entries(EXECUTION_OPERATION_DESCRIPTIONS).map(
        ([operation, description]) => [
          operation,
          `${description} ${SESSION_HISTORY_USAGE_NOTICE}`,
        ],
      ),
    ) as Record<keyof typeof EXECUTION_OPERATION_DESCRIPTIONS, string>),
    ...SESSION_COORDINATION_DESCRIPTIONS,
    create_child:
      "Create a saved normal direct child: overall-coordinator may create task-coordinator/executor, task-coordinator only executor. Provider, model, reasoningEffort, approvalMode and workspacePath are explicit; Codex also requires codexSandboxMode, unsupported sandbox settings for other Providers are rejected. Character is selected automatically from least-used normal Mains in this Crew, never caller-selected. requestId recovers the same child/Character/settings on identical retry. No Worktree creation/merge/deletion or user approval is performed. Parent selection policy remains in your Provider-managed runbook, not WithMate config synchronization.",
    get_catalog:
      "Read existing available Provider/model/depth catalog and native approval/sandbox options for child selection. Omit provider for all Providers; omit workspacePath to use the actual bound actor's Workspace. An empty reasoningEfforts/options list means unsupported, not permission to invent a value. Use exact available values; create never silently substitutes GUI defaults or a different model.",
    self: "Read the actual bound actor, own Crew Folder path, current WithMate Turn and its saved receipt/origin references. Absent references are null; later Turns do not inherit the first task's receipt. The Crew Folder is a shared save location, not the runtime directory or permission to write another Crew's files.",
    list: "List saved Session metadata across the current Crew by default. Explicit rootSessionId or allCrews can read other Crews. Descriptions are complete, not previews. Page with offset/limit (maximum 100). Listing grants no write permission.",
    get: "Read metadata, saved relationships, execution state and public Crew Folder reference of one exact Session/incarnation, without loading its conversation. An explicit other-Crew Folder reference does not mount that directory or grant filesystem write permission. List does not register every Crew's filesystem root.",
    update_metadata:
      "Update only this actor's title and/or description. This does not change Role, execution settings or another Session's metadata.",
    enqueue:
      "Enqueue a normal message to an actual direct parent or child, never self, siblings or other branches. deliveryTiming defaults to immediate; explicitly choose after_source_turn to start the recipient's normal new Turn only after this exact sending Session/incarnation/Turn is terminal and saved (completed, failed or canceled). Both modes return a durable acceptance receipt immediately, never auto-Steer. Unknown source state does not release delayed delivery. Delayed messages do not block immediate consultation or GUI input. requestId must be a UUID and identifies the immutable acceptance, including deliveryTiming; reuse only with identical input. A receipt is acceptance, not a completed Turn. On unknown outcome query get_receipt with the same requestId; do not create a new request automatically.",
    get_receipt:
      "Recover this sender's receipt by its original UUID requestId and exact target. Delayed receipts expose sourceTurnPhase (running, completed, failed, canceled or unknown); sourceTurnPendingRelease marks execution still releasing even when a terminal phase is saved. Source failure or cancellation is not successful work. Later active Turns of this sender may recover it. A requestId is not authority to read another sender's receipt.",
    cancel_receipt:
      "Cancel one exact pending receipt of a direct child. Parent authority does not depend on who sent the receipt. If started, report its actual state without stopping its Turn.",
    stop_turn:
      "Stop one specified WithMate Turn of a direct child, including all committed additional inputs. Never stop the latest Turn instead. A terminal Turn reports not-applied; this does not withdraw one instruction.",
  };

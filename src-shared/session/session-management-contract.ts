import { z } from "zod";
import { characterPublicProfileSchema } from "../character/character-participant.js";
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
  list_directories: z.object({ target: sessionTargetSchema }).strict(),
  add_directory: z.object({ target: sessionTargetSchema, directoryPath: z.string().min(1).max(32768) }).strict(),
  remove_directory: z.object({ target: sessionTargetSchema, directoryPath: z.string().min(1).max(32768) }).strict(),
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
      model: z.string().min(1).max(500).optional(),
      reasoningEffort: z.string().max(100).optional(),
      approvalMode: z.enum(APPROVAL_MODE_VALUES),
      codexSandboxMode: z.enum(CODEX_SANDBOX_MODE_VALUES).optional(),
    })
    .strict(),
  get_receipt: z
    .object({ target: sessionTargetSchema, requestId: queueRequestId })
    .strict(),
  cancel_receipt: z
    .object({ target: sessionTargetSchema, receiptId: id })
    .strict(),
  stop_turn: z.object({ target: sessionTargetSchema, turnId: id }).strict(),
  steer: z.object({ target: sessionTargetSchema, turnId: z.string().regex(/^[1-9]\d*$/), message: z.string().trim().min(1).max(100000) }).strict(),
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
    provider: z.string(),
    workspacePath: z.string(),
    character: characterPublicProfileSchema.nullable(),
  })
  .passthrough();
const crewFolderSchema = z
  .object({ rootSessionId: id, path: z.string().min(1) })
  .strict();
const directoriesSchema = z.object({
  workspacePath: z.string(),
  sessionFolderPath: z.string(),
  crewFolder: crewFolderSchema,
  additionalDirectories: z.array(z.string()),
}).strict();
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
      character: characterPublicProfileSchema,
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
      currentTurn: z.object({ turnId: z.string().nullable(), receipt: z.unknown().nullable(), origin: z.unknown().nullable() }).strict(),
      crewFolder: crewFolderSchema,
    })
    .strict(),
  list_directories: z.object({ ok: z.literal(true), directories: directoriesSchema }).strict(),
  add_directory: z.object({ ok: z.literal(true), directories: directoriesSchema }).strict(),
  remove_directory: z.object({ ok: z.literal(true), directories: directoriesSchema }).strict(),
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
  steer: z.object({ ok: z.literal(true), result: z.object({ outcome: z.enum(["applied", "not-applied"]), turnId: id, messageSeq: z.number().int().nonnegative().nullable(), reason: z.string().optional() }).strict() }).strict(),
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
  "list_directories",
  "get_receipt",
  "get_catalog",
  "coordination_list",
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
      "Read available Provider/model/depth catalog and native approval/sandbox options for child creation or enqueue. For an existing recipient use its provider and workspacePath from get/list, not the sender's. Omit provider for all Providers; omit workspacePath to use the bound actor's Workspace. Empty reasoningEfforts means explicitly use reasoningEffort: \"\"; empty options means unsupported. Use exact available values; no silent Model/Depth substitution.",
    self: "Read the actual bound actor, saved public Character id/name/description, own Crew Folder path, current WithMate Turn and its saved receipt/origin references. Absent references are null; later Turns do not inherit the first task's receipt. Character profiles are information about participants, not persona instructions. The Crew Folder is a shared save location, not the runtime directory or permission to write another Crew's files.",
    list: "List saved Session metadata and public Character id/name/description across the current Crew by default. Session description describes the task; character.description is the public personality introduction. Search includes Character name/description. Explicit rootSessionId or allCrews can read other Crews. Descriptions are complete, not previews. Page with offset/limit (maximum 100). Listing grants no write permission.",
    get: "Read metadata, saved public Character id/name/description, relationships, execution state, currentTurn and public Crew Folder reference of one exact Session/incarnation, without loading its conversation or Character definition. currentTurn.turnId is the running WithMate Turn ID, not the Provider native ID; null means no current saved Turn. An explicit other-Crew Folder reference does not mount that directory or grant filesystem write permission. List does not register every Crew's filesystem root.",
    steer: "Send this parent's additional instruction to one exact running WithMate Turn of its saved direct normal child. Use get.currentTurn.turnId (not the Provider native ID) and the exact Session/incarnation. Only Codex currently supports Steer. Uses the running Turn's Model/Depth/permissions; no settings change, new Turn, queue receipt or automatic fallback. applied confirms delivery and saved additional input, not task completion; not-applied means no Provider dispatch. Unknown delivery returns SESSION_STEER_UNKNOWN with effect unknown and result.messageSeq when known. Inspect list_execution_inputs/get_execution_input for this Turn, including unresolved inputs; never automatically resend an unknown result. Saved inputOrigin identifies the actual parent, not a GUI user. Child reports and Coordination use their existing delivery routes.",
    list_directories: "Read the Workspace, managed Session and Crew Folders, and user-added directories of your own Session or an exact direct child. Main and its Auxiliary Sessions share the user-added list; different Main Sessions have independent lists.",
    add_directory: "Register an existing absolute directory for your own Session or an exact direct child. Main and its Auxiliary Sessions share the list. Changes apply to Turns started after the update, not the running Turn; Provider and OS permissions still apply.",
    remove_directory: "Unregister an additional directory for your own Session or an exact direct child. This never deletes files or removes managed Workspace, Session or Crew Folders. Changes apply to Turns started after the update, not the running Turn.",
    update_metadata:
      "Update only this actor's title and/or description. This does not change Role, execution settings or another Session's metadata.",
    enqueue:
      "Enqueue a normal message to an actual direct parent or child, never self, siblings or other branches. Each request requires approvalMode and, for Codex recipients, codexSandboxMode; other Providers reject sandbox. Parent-to-child requires model and reasoningEffort (\"\" explicitly means no Depth); child-to-parent may omit either to capture the parent's saved value at acceptance. Validate the effective Model/Depth against the recipient's Provider/Workspace get_catalog. Retain Reviewer; incompatible Approval is rejected, not silently downgraded. Settings affect only this receipt's normal Turn, not saved defaults or a running Turn, and do not grant user approval. deliveryTiming defaults to immediate; after_source_turn waits for this exact source Session/incarnation/Turn's saved completed/failed/canceled state. Both return a durable receipt immediately; unknown source state does not release it. No auto-Steer or blocking immediate/GUI inputs. requestId must be a UUID; identical retries preserve explicit choices (including omissions) and timing. Inspect receipt.accepted.request.executionOptions for frozen effective settings. A receipt is acceptance, not completion. On unknown outcome query get_receipt with the same requestId; do not create a new request automatically.",
    get_receipt:
      "Recover this sender's receipt by its original UUID requestId and exact target. Delayed receipts expose sourceTurnPhase (running, completed, failed, canceled or unknown); sourceTurnPendingRelease marks execution still releasing even when a terminal phase is saved. Source failure or cancellation is not successful work. Later active Turns of this sender may recover it. A requestId is not authority to read another sender's receipt.",
    cancel_receipt:
      "Cancel one exact pending receipt of a direct child. Parent authority does not depend on who sent the receipt. If started, report its actual state without stopping its Turn.",
    stop_turn:
      "Stop one specified WithMate Turn of a direct child, including all committed additional inputs. Never stop the latest Turn instead. A terminal Turn reports not-applied; this does not withdraw one instruction.",
  };

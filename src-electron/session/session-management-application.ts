import { projectCharacterPublicProfile } from "../../src-shared/character/character-participant.js";
import {
  sessionOperationRequestSchemas,
  type SessionOperation,
  type SessionOperationRequest,
  type SessionOperationResult,
  type SessionTarget,
} from "../../src-shared/session/session-management-contract.js";
import {
  assertDirectChildSessionControl,
  assertDirectSessionSend,
  queryRelatedSessions,
  type RelatedSession,
} from "./session-relationship-resolver.js";
import type {
  ExecutionReadOperation,
  ExecutionReadRequest,
} from "../../src-shared/session/session-execution-read.js";
import {
  coordinationRequestSchema,
  type CoordinationRequest,
  type CoordinationResult,
} from "../../src-shared/coordination/coordination-contract.js";
import {
  assertChildSessionRole,
  normalizeSessionRelationship,
} from "../../src-shared/session/session-role.js";
import {
  getSessionIncarnationId,
  type Session,
} from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import {
  getApprovalOptionsForProvider,
  getSandboxOptionsForProvider,
} from "../../src-shared/settings/provider-runtime-options.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";

export type SessionCurrentTurn = {
  turnId: string | null;
  receipt: unknown | null;
  origin: unknown | null;
};
export type SessionManagementContext = {
  actor: SessionTarget;
  assertCurrent(): void;
};
export type SessionManagementApplicationDeps = {
  listSessions(): Promise<RelatedSession[]>;
  currentTurn(actor: RelatedSession): Promise<SessionCurrentTurn>;
  crewFolder(
    actor: RelatedSession,
  ): Promise<{ rootSessionId: string; path: string }>;
  directories(target: RelatedSession, change: { operation: "add" | "remove"; directoryPath: string } | null, assertCurrent: () => void): Promise<{
    workspacePath: string; sessionFolderPath: string; crewFolder: { rootSessionId: string; path: string }; additionalDirectories: string[];
  }>;
  updateMetadata(
    actor: RelatedSession,
    patch: SessionOperationRequest<"update_metadata">,
    assertCurrent: () => void,
  ): Promise<unknown>;
  enqueue(
    target: RelatedSession,
    input: SessionOperationRequest<"enqueue">,
    actor: RelatedSession,
    turnId: string,
    assertCurrent: () => void,
  ): Promise<unknown>;
  getReceipt(
    target: RelatedSession,
    requestId: string,
  ): Promise<{
    accepted?: {
      origin?: {
        kind: string;
        actorKind?: "main" | "auxiliary";
        actorSessionId?: string;
        actorIncarnationId?: string;
        targetSessionId: string;
        targetIncarnationId: string;
        operation: string;
      };
    } | null;
  } | null>;
  cancelReceipt(
    target: RelatedSession,
    receiptId: string,
    assertCurrent: () => void,
  ): Promise<unknown>;
  stopTurn(
    target: RelatedSession,
    turnId: string,
    assertCurrent: () => void,
  ): Promise<unknown>;
  readExecution(
    target: RelatedSession,
    operation: ExecutionReadOperation,
    request: ExecutionReadRequest,
    assertCurrent: () => void,
  ): Promise<SessionOperationResult>;
  coordinate(
    actor: RelatedSession,
    turnId: string | null,
    request: CoordinationRequest,
    assertCurrent: () => void,
  ): Promise<CoordinationResult>;
  createChild(
    actor: RelatedSession,
    request: SessionOperationRequest<"create_child">,
    assertCurrent: () => void,
  ): Promise<Session>;
  catalog(
    actor: RelatedSession,
    request: SessionOperationRequest<"get_catalog">,
  ): Promise<ModelCatalogSnapshot>;
};
export class SessionManagementError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Saved relationships authorize writes; public saved metadata remains readable across Crews. */
export class SessionManagementApplication {
  constructor(readonly deps: SessionManagementApplicationDeps) {}

  async execute(
    operation: SessionOperation,
    body: unknown,
    context: SessionManagementContext,
  ): Promise<SessionOperationResult> {
    const parsed = sessionOperationRequestSchemas[operation].safeParse(body);
    if (!parsed.success)
      return {
        ok: false,
        code: "SESSION_INVALID_REQUEST",
        effect: "none",
        message: parsed.error.message,
      };
    const entries = await this.deps.listSessions();
    context.assertCurrent();
    const matches = (entry: RelatedSession, reference: SessionTarget) =>
      entry.id === reference.sessionId &&
      entry.kind === reference.kind &&
      entry.incarnationId === reference.incarnationId &&
      (reference.kind !== "auxiliary" ||
        (entry.mainSessionId === reference.mainSessionId &&
          entries.some(
            (main) =>
              main.kind === "main" &&
              main.id === reference.mainSessionId &&
              main.incarnationId === reference.mainIncarnationId,
          )));
    const actor = entries.find((entry) => matches(entry, context.actor));
    if (!actor)
      throw new SessionManagementError(
        "SESSION_ACTOR_UNAVAILABLE",
        "The bound actor no longer exists.",
      );
    const target = (reference: SessionTarget): RelatedSession => {
      const found = entries.find(
        (entry) =>
          entry.id === reference.sessionId && entry.kind === reference.kind,
      );
      if (!found)
        throw new SessionManagementError(
          "SESSION_NOT_FOUND",
          "The target Session does not exist.",
        );
      if (!matches(found, reference))
        throw new SessionManagementError(
          "SESSION_REPLACED",
          "The target Session incarnation changed.",
        );
      return found;
    };
    switch (operation) {
      case "get_catalog": {
        const catalog = await this.deps.catalog(
          actor,
          parsed.data as SessionOperationRequest<"get_catalog">,
        );
        context.assertCurrent();
        return {
          ok: true,
          catalog,
          options: catalog.providers.map((provider) => ({
            provider: provider.id,
            approvalModes: getApprovalOptionsForProvider(provider.id),
            sandboxModes: getSandboxOptionsForProvider(provider.id),
          })),
        };
      }
      case "create_child": {
        const request = parsed.data as SessionOperationRequest<"create_child">;
        try {
          if (actor.kind !== "main") throw new Error();
          assertChildSessionRole(actor.sessionRole, request.role);
        } catch {
          throw new SessionManagementError(
            "SESSION_FORBIDDEN",
            "This actual Session Role cannot create the requested child.",
          );
        }
        context.assertCurrent();
        const created = await this.deps.createChild(
          actor,
          request,
          context.assertCurrent,
        );
        const relationship = normalizeSessionRelationship(created);
        const incarnationId = getSessionIncarnationId(created);
        return {
          ok: true,
          session: {
            ...relationship,
            id: created.id,
            incarnationId,
            kind: "main",
            role: relationship.sessionRole,
            mainSessionId: created.id,
            mainIncarnationId: incarnationId,
            title: created.taskTitle,
            description: created.description ?? "",
            runState: created.runState,
            provider: created.provider,
            workspacePath: created.workspacePath,
            character: projectCharacterPublicProfile(created),
          },
          character: projectCharacterPublicProfile(created),
          provider: created.provider,
          workspacePath: created.workspacePath,
          executionOptions: captureSessionExecutionOptions(created),
        };
      }
      case "coordination_list":
      case "coordination_get":
      case "coordination_create":
      case "coordination_deliver":
      case "coordination_escalate":
      case "coordination_answer":
      case "coordination_withdraw":
      case "coordination_resolve":
      case "coordination_consume":
      case "coordination_correct": {
        const request = coordinationRequestSchema.parse({
          ...parsed.data,
          operation: operation.slice("coordination_".length),
        });
        const read =
          request.operation === "list" || request.operation === "get";
        const turnId = read
          ? null
          : (await this.deps.currentTurn(actor)).turnId;
        context.assertCurrent();
        if (!read && !turnId)
          throw new SessionManagementError(
            "SESSION_TURN_UNAVAILABLE",
            "The actor has no current saved WithMate Turn.",
          );
        return {
          ok: true,
          ...(await this.deps.coordinate(
            actor,
            turnId,
            request,
            context.assertCurrent,
          )),
        };
      }
      case "list_sent_deliveries":
      case "list_executions":
      case "list_messages":
      case "get_message":
      case "list_operations":
      case "get_operation_detail":
      case "get_execution":
      case "list_execution_inputs":
      case "get_execution_input":
      case "list_execution_outputs":
      case "get_execution_output":
      case "list_execution_operations":
      case "get_execution_operation_detail": {
        const request = parsed.data as ExecutionReadRequest;
        const destination = target(request.target);
        context.assertCurrent();
        const result = await this.deps.readExecution(
          destination,
          operation,
          request,
          context.assertCurrent,
        );
        context.assertCurrent();
        return result;
      }
      case "self":
        return {
          ok: true,
          session: actor,
          currentTurn: await this.deps.currentTurn(actor),
          crewFolder: await this.deps.crewFolder(actor),
        };
      case "list":
        return {
          ok: true,
          ...queryRelatedSessions(
            entries,
            actor,
            parsed.data as SessionOperationRequest<"list">,
          ),
        };
      case "get": {
        const destination = target(
          (parsed.data as SessionOperationRequest<"get">).target,
        );
        return {
          ok: true,
          session: destination,
          crewFolder: await this.deps.crewFolder(destination),
        };
      }
      case "list_directories":
      case "add_directory":
      case "remove_directory": {
        const request = parsed.data as SessionOperationRequest<"list_directories"> | SessionOperationRequest<"add_directory"> | SessionOperationRequest<"remove_directory">;
        const destination = target(request.target);
        const self = actor.kind === destination.kind && actor.id === destination.id && actor.incarnationId === destination.incarnationId;
        if (!self) {
          try {
            assertDirectChildSessionControl(actor, destination);
          } catch {
            throw new SessionManagementError("SESSION_FORBIDDEN", "Directory management requires the actual Session or its direct child.");
          }
        }
        context.assertCurrent();
        const change = operation === "list_directories" ? null : {
          operation: operation === "add_directory" ? "add" as const : "remove" as const,
          directoryPath: (request as SessionOperationRequest<"add_directory">).directoryPath,
        };
        return { ok: true, directories: await this.deps.directories(destination, change, context.assertCurrent) };
      }
      case "update_metadata": {
        context.assertCurrent();
        return {
          ok: true,
          metadata: await this.deps.updateMetadata(
            actor,
            parsed.data as SessionOperationRequest<"update_metadata">,
            context.assertCurrent,
          ),
        };
      }
      case "enqueue": {
        const input = parsed.data as SessionOperationRequest<"enqueue">;
        const destination = target(input.target);
        try {
          assertDirectSessionSend(actor, destination);
        } catch {
          throw new SessionManagementError(
            "SESSION_FORBIDDEN",
            "Messages require actual direct parent-child Sessions.",
          );
        }
        if (destination.parentSessionId === actor.id && (input.model === undefined || input.reasoningEffort === undefined)) {
          throw new SessionManagementError("SESSION_INVALID_REQUEST", "Parent-to-child messages require model and reasoningEffort (use an empty string for no Depth).");
        }
        const current = await this.deps.currentTurn(actor);
        context.assertCurrent();
        if (!current.turnId)
          throw new SessionManagementError(
            "SESSION_TURN_UNAVAILABLE",
            "The actor has no current saved WithMate Turn.",
          );
        return {
          ok: true,
          receipt: await this.deps.enqueue(
            destination,
            input,
            actor,
            current.turnId,
            context.assertCurrent,
          ),
        };
      }
      case "get_receipt": {
        const input = parsed.data as SessionOperationRequest<"get_receipt">;
        const destination = target(input.target);
        const receipt = await this.deps.getReceipt(
          destination,
          input.requestId,
        );
        context.assertCurrent();
        const origin = receipt?.accepted?.origin;
        if (
          receipt &&
          (!origin ||
            origin.kind !== "session" ||
            origin.actorKind !== actor.kind ||
            origin.actorSessionId !== actor.id ||
            origin.actorIncarnationId !== actor.incarnationId ||
            origin.operation !== "send" ||
            origin.targetSessionId !== destination.id ||
            origin.targetIncarnationId !== destination.incarnationId)
        )
          throw new SessionManagementError(
            "SESSION_FORBIDDEN",
            "Request-key recovery is limited to the actual sender and target.",
          );
        return { ok: true, receipt };
      }
      case "cancel_receipt":
      case "stop_turn": {
        const input = parsed.data as
          | SessionOperationRequest<"cancel_receipt">
          | SessionOperationRequest<"stop_turn">;
        const destination = target(input.target);
        try {
          assertDirectChildSessionControl(actor, destination);
        } catch {
          throw new SessionManagementError(
            "SESSION_FORBIDDEN",
            "Only an actual direct parent may control this Session.",
          );
        }
        context.assertCurrent();
        return {
          ok: true,
          result:
            operation === "cancel_receipt"
              ? await this.deps.cancelReceipt(
                  destination,
                  (input as SessionOperationRequest<"cancel_receipt">)
                    .receiptId,
                  context.assertCurrent,
                )
              : await this.deps.stopTurn(
                  destination,
                  (input as SessionOperationRequest<"stop_turn">).turnId,
                  context.assertCurrent,
                ),
        };
      }
    }
  }
}

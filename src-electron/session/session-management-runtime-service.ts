import {
  sessionAgentRuntimeOperation,
  sessionRuntimeOperationByPath,
  SESSION_READ_OPERATIONS,
  sessionTargetSchema,
} from "../../src-shared/session/session-management-contract.js";
import type {
  AgentRuntimeExtensionRequest,
  AgentRuntimeExtensionResponse,
} from "../memory/memory-v6-http-server.js";
import type { AgentRuntimeBindingRegistry } from "../providers/agent-runtime-binding.js";
import type { ProviderAgentRuntimeTurnCoordinator } from "../providers/provider-agent-runtime-turn-coordinator.js";
import {
  SessionManagementApplication,
  SessionManagementError,
} from "./session-management-application.js";
import { runWithRuntimeTurnAdmission, RuntimeTurnInactiveError } from "../platform/memory/runtime-turn-admission.js";

export class SessionManagementRuntimeService {
  constructor(
    readonly deps: {
      application: SessionManagementApplication;
      bindingRegistry: Pick<AgentRuntimeBindingRegistry, "resolve">;
      providerAgentRuntimeTurns: ProviderAgentRuntimeTurnCoordinator;
    },
  ) {}

  async route(
    request: AgentRuntimeExtensionRequest,
  ): Promise<AgentRuntimeExtensionResponse | null> {
    const operation = sessionRuntimeOperationByPath.get(
      new URL(request.path, "http://127.0.0.1").pathname,
    );
    if (!operation) return null;
    const failure = (
      status: number,
      code: string,
      message: string,
      effect: "none" | "unknown" = "none",
    ): AgentRuntimeExtensionResponse => ({
      status,
      value: { ok: false, code, message, effect },
    });
    if (request.method !== "POST")
      return failure(
        405,
        "SESSION_INVALID_REQUEST",
        "Session operations require POST.",
      );
    const resolve = () =>
      this.deps.bindingRegistry.resolve(
        request.bindingReference,
        sessionAgentRuntimeOperation(operation),
      );
    const resolved = resolve();
    if (!resolved.ok)
      return failure(
        resolved.code === "SESSION_BINDING_FORBIDDEN" ? 403 : 401,
        resolved.code,
        "An active normal Session binding is required.",
      );
    const binding = resolved.binding;
    if (binding.backgroundScope)
      return failure(
        403,
        "SESSION_BINDING_FORBIDDEN",
        "Background execution cannot use normal Session operations.",
      );
    const actor = sessionTargetSchema.safeParse(
      binding.authoritySnapshot.sessionIdentity,
    );
    if (!actor.success || actor.data.sessionId !== binding.actorSessionId)
      return failure(
        401,
        "SESSION_BINDING_INVALID",
        "The binding has no exact saved Session identity.",
      );
    const admission = this.deps.providerAgentRuntimeTurns.admit({
      actorSessionId: binding.actorSessionId,
      providerId: binding.providerId,
      turnCapability: request.turnCapability,
    });
    if (!admission.ok)
      return failure(
        401,
        "SESSION_BINDING_INVALID",
        "The captured provider Turn is inactive.",
      );
    const assertCurrent = () => {
      const current = resolve();
      const turn = this.deps.providerAgentRuntimeTurns.admit({
        actorSessionId: binding.actorSessionId,
        providerId: binding.providerId,
        turnCapability: request.turnCapability,
      });
      if (
        !current.ok ||
        current.binding.bindingId !== binding.bindingId ||
        current.binding.executionGeneration !== binding.executionGeneration ||
        !turn.ok ||
        turn.handle !== admission.handle
      )
        throw new SessionManagementError(
          "SESSION_BINDING_INVALID",
          "The captured binding or provider Turn ended.",
        );
    };
    try {
      const execute = () =>
        this.deps.application.execute(operation, request.body, {
          actor: actor.data,
          assertCurrent,
        });
      // Reads, Coordination, and directory changes carry admission into Worker.
      // Coordination detaches its postcommit queue wake from this sender scope.
      const result = await (SESSION_READ_OPERATIONS.includes(operation) ||
      operation.startsWith("coordination_") || operation === "add_directory" || operation === "remove_directory"
        ? runWithRuntimeTurnAdmission(
            {
              state: admission.handle.revocationState,
              isCurrent: () => {
                try {
                  assertCurrent();
                  return true;
                } catch {
                  return false;
                }
              },
            },
            execute,
          )
        : execute());
      // A committed mutation remains applied even when the initiating provider Turn ends.
      if (SESSION_READ_OPERATIONS.includes(operation)) assertCurrent();
      return { status: result.ok ? 200 : 400, value: result };
    } catch (error) {
      if (error instanceof RuntimeTurnInactiveError) return failure(401, "SESSION_BINDING_INVALID", "The captured provider Turn ended before the operation was applied.");
      if (SESSION_READ_OPERATIONS.includes(operation)) {
        try {
          assertCurrent();
        } catch {
          return failure(
            401,
            "SESSION_BINDING_INVALID",
            "The captured binding or provider Turn ended before the read completed.",
          );
        }
      }
      if (error instanceof SessionManagementError)
        return failure(
          error.code === "SESSION_BINDING_INVALID"
            ? 401
            : error.code === "SESSION_FORBIDDEN"
              ? 403
              : 409,
          error.code,
          error.message,
        );
      return failure(
        500,
        "SESSION_OPERATION_FAILED",
        "Session operation could not be confirmed.",
        SESSION_READ_OPERATIONS.includes(operation) ? "none" : "unknown",
      );
    }
  }
}

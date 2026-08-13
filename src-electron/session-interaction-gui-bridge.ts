import type { LiveApprovalDecision, LiveElicitationResponse } from "../src/runtime-state.js";
import type { SessionInteractionService } from "./session-interaction-service.js";

type SessionInteractionGuiBridgeDeps = {
  interactionService: Pick<SessionInteractionService, "getPendingForExecution" | "respond">;
  currentTimestamp: () => string;
  resolveIdempotencyExpiresAt: (respondedAt: string) => string;
};

type ExternalInteractionContext = {
  sessionId: string;
  executionId: string | undefined;
  requestId: string;
  liveRequestId: string | undefined;
};

export function tryRespondToExternalApprovalInteraction(
  context: ExternalInteractionContext,
  decision: LiveApprovalDecision,
  deps: SessionInteractionGuiBridgeDeps,
): boolean {
  if (!context.executionId || context.liveRequestId !== context.requestId) return false;
  const pending = deps.interactionService.getPendingForExecution(context.executionId);
  if (pending?.kind !== "approval") return false;
  const respondedAt = deps.currentTimestamp();
  deps.interactionService.respond({
    sessionId: context.sessionId,
    executionId: context.executionId,
    interactionId: pending.id,
    response: { kind: "approval", decision },
    idempotencyKey: `gui:${pending.id}`,
    respondedAt,
    expiresAt: deps.resolveIdempotencyExpiresAt(respondedAt),
  });
  return true;
}

export function tryRespondToExternalElicitationInteraction(
  context: ExternalInteractionContext,
  response: LiveElicitationResponse,
  deps: SessionInteractionGuiBridgeDeps,
): boolean {
  if (!context.executionId || context.liveRequestId !== context.requestId) return false;
  const pending = deps.interactionService.getPendingForExecution(context.executionId);
  if (pending?.kind !== "elicitation") return false;
  const respondedAt = deps.currentTimestamp();
  deps.interactionService.respond({
    sessionId: context.sessionId,
    executionId: context.executionId,
    interactionId: pending.id,
    response: response.action === "accept"
      ? { kind: "elicitation", action: "accept", content: response.content ?? {} }
      : { kind: "elicitation", action: response.action },
    idempotencyKey: `gui:${pending.id}`,
    respondedAt,
    expiresAt: deps.resolveIdempotencyExpiresAt(respondedAt),
  });
  return true;
}

import type { LiveApprovalDecision, LiveElicitationResponse } from "../src/runtime-state.js";
import type { TrustedSessionInteractionResponder } from "./session-interaction-service.js";

type SessionInteractionGuiBridgeDeps = {
  trustedResponder: TrustedSessionInteractionResponder;
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
  const pending = deps.trustedResponder.getPendingForExecution(context.executionId);
  if (pending?.kind !== "approval") return false;
  const respondedAt = deps.currentTimestamp();
  deps.trustedResponder.respond({
    sessionId: context.sessionId,
    executionId: context.executionId,
    interactionId: pending.id,
    expectedRevision: pending.revision,
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
  const pending = deps.trustedResponder.getPendingForExecution(context.executionId);
  if (pending?.kind !== "elicitation") return false;
  const respondedAt = deps.currentTimestamp();
  deps.trustedResponder.respond({
    sessionId: context.sessionId,
    executionId: context.executionId,
    interactionId: pending.id,
    expectedRevision: pending.revision,
    response: response.action === "accept"
      ? { kind: "elicitation", action: "accept", content: response.content ?? {} }
      : { kind: "elicitation", action: response.action },
    idempotencyKey: `gui:${pending.id}`,
    respondedAt,
    expiresAt: deps.resolveIdempotencyExpiresAt(respondedAt),
  });
  return true;
}

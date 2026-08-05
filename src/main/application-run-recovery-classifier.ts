import type { RecoveryCandidate } from "../shared/repository-read-model.js";

export type ApplicationRunRecoveryAction =
  | Readonly<{ kind: "safe_pending_dispatch"; candidate: RecoveryCandidate }>
  | Readonly<{ kind: "binding_creation_ambiguous"; candidate: RecoveryCandidate }>
  | Readonly<{ kind: "dispatch_ambiguous"; candidate: RecoveryCandidate }>
  | Readonly<{ kind: "persistent_execution_reconcile"; candidate: RecoveryCandidate }>
  | Readonly<{ kind: "ephemeral_owner_lost"; candidate: RecoveryCandidate }>
  | Readonly<{ kind: "local_terminalization"; candidate: RecoveryCandidate }>
  | Readonly<{
      kind: "diagnostic_invalid";
      candidate: RecoveryCandidate;
      reason:
        | "attempt_cardinality"
        | "binding_cardinality"
        | "binding_scope"
        | "binding_creator_scope"
        | "dispatch_cardinality"
        | "state_combination";
    }>;

export function classifyApplicationRunRecovery(candidate: RecoveryCandidate): ApplicationRunRecoveryAction {
  if (candidate.currentAttemptCount !== 1 || candidate.attemptId === null || candidate.attemptState === null) {
    return diagnostic(candidate, "attempt_cardinality");
  }
  if (candidate.bindingCandidateCount !== 1 || candidate.bindingId === null) {
    return diagnostic(candidate, "binding_cardinality");
  }
  if (
    candidate.bindingSessionId !== candidate.sessionId ||
    candidate.bindingProviderId !== candidate.sessionProviderId
  ) {
    return diagnostic(candidate, "binding_scope");
  }
  if (
    candidate.bindingCreatorAttemptId === null ||
    candidate.bindingCreatorRunId === null ||
    candidate.bindingCreatorSessionId !== candidate.sessionId
  ) {
    return diagnostic(candidate, "binding_creator_scope");
  }
  if (candidate.dispatchCount !== 1 || candidate.dispatchState === null) {
    return diagnostic(candidate, "dispatch_cardinality");
  }

  const bindingOwnedByAttempt = candidate.bindingCreatorAttemptId === candidate.attemptId;
  const bindingCreatedByRun = candidate.bindingCreatorRunId === candidate.runId;
  const directBinding = candidate.attemptProviderBindingId === candidate.bindingId;
  if (
    candidate.attemptState === "preparing" &&
    candidate.bindingState === "creating" &&
    bindingOwnedByAttempt &&
    bindingCreatedByRun &&
    candidate.attemptProviderBindingId === null &&
    candidate.externalConversationId === null &&
    candidate.externalExecutionId === null &&
    candidate.dispatchState === "pending" &&
    (candidate.runPhase === "queued" || candidate.runPhase === "starting")
  ) {
    return Object.freeze({ kind: "binding_creation_ambiguous", candidate });
  }

  if (
    candidate.bindingState === "active" &&
    candidate.persistenceMode === "ephemeral" &&
    bindingOwnedByAttempt &&
    bindingCreatedByRun &&
    directBinding
  ) {
    return Object.freeze({ kind: "ephemeral_owner_lost", candidate });
  }

  if (
    candidate.bindingState === "active" &&
    candidate.persistenceMode === "persistent" &&
    directBinding &&
    candidate.externalConversationId !== null
  ) {
    if (
      candidate.attemptState === "preparing" &&
      candidate.externalExecutionId === null &&
      candidate.dispatchState === "pending" &&
      (candidate.runPhase === "queued" || candidate.runPhase === "starting")
    ) {
      return Object.freeze({ kind: "safe_pending_dispatch", candidate });
    }
    if (
      candidate.attemptState === "preparing" &&
      candidate.externalExecutionId === null &&
      (candidate.dispatchState === "dispatching" || candidate.dispatchState === "ambiguous") &&
      (candidate.runPhase === "starting" || candidate.runPhase === "canceling")
    ) {
      return Object.freeze({ kind: "dispatch_ambiguous", candidate });
    }
    if (
      candidate.attemptState === "active" &&
      candidate.externalExecutionId !== null &&
      candidate.dispatchState === "accepted" &&
      (candidate.runPhase === "active" || candidate.runPhase === "canceling" || candidate.runPhase === "finalizing")
    ) {
      return Object.freeze({ kind: "persistent_execution_reconcile", candidate });
    }
  }

  if (
    candidate.attemptState === "preparing" &&
    (candidate.dispatchState === "rejected" || candidate.dispatchState === "aborted")
  ) {
    return Object.freeze({ kind: "local_terminalization", candidate });
  }
  return diagnostic(candidate, "state_combination");
}

function diagnostic(
  candidate: RecoveryCandidate,
  reason: Extract<ApplicationRunRecoveryAction, Readonly<{ kind: "diagnostic_invalid" }>>["reason"],
): Extract<ApplicationRunRecoveryAction, Readonly<{ kind: "diagnostic_invalid" }>> {
  return Object.freeze({ kind: "diagnostic_invalid", candidate, reason });
}

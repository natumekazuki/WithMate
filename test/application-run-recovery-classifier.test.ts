import assert from "node:assert/strict";
import test from "node:test";

import { classifyApplicationRunRecovery } from "../src/main/application-run-recovery-classifier.js";
import type { RecoveryCandidate } from "../src/shared/repository-read-model.js";

const baseCandidate: RecoveryCandidate = Object.freeze({
  runId: "run-1",
  sessionId: "session-1",
  workspaceKey: "workspace",
  sessionProviderId: "codex",
  runPhase: "queued",
  runVersion: 1,
  initiatingMessageId: "message-1",
  runCreatedAt: 1,
  runUpdatedAt: 1,
  cancelRequestedAt: null,
  externalSideEffectState: "none",
  currentAttemptCount: 1,
  attemptId: "attempt-1",
  attemptOrdinal: 1,
  attemptState: "preparing",
  attemptProviderBindingId: "binding-1",
  externalExecutionId: null,
  bindingCandidateCount: 1,
  bindingId: "binding-1",
  bindingSessionId: "session-1",
  bindingProviderId: "codex",
  persistenceMode: "persistent",
  bindingState: "active",
  bindingCreatorAttemptId: "attempt-1",
  bindingCreatorRunId: "run-1",
  bindingCreatorSessionId: "session-1",
  externalConversationId: "thread-1",
  dispatchCount: 1,
  dispatchState: "pending",
  providerIdempotencyKey: null,
});

test("recovery classifier permits only the exact persistent pending tuple to start a new Turn", () => {
  assert.equal(classifyApplicationRunRecovery(baseCandidate).kind, "safe_pending_dispatch");
  for (const candidate of [
    { ...baseCandidate, persistenceMode: "ephemeral" as const },
    { ...baseCandidate, dispatchState: "dispatching" as const, runPhase: "starting" as const },
    { ...baseCandidate, bindingProviderId: "other" },
    { ...baseCandidate, currentAttemptCount: 0, attemptId: null, attemptState: null },
  ]) {
    assert.notEqual(classifyApplicationRunRecovery(candidate).kind, "safe_pending_dispatch");
  }
});

test("recovery classifier keeps creation and dispatch uncertainty monotonic", () => {
  for (const persistenceMode of ["persistent", "ephemeral"] as const) {
    assert.equal(
      classifyApplicationRunRecovery({
        ...baseCandidate,
        attemptProviderBindingId: null,
        bindingState: "creating",
        persistenceMode,
        externalConversationId: null,
      }).kind,
      "binding_creation_ambiguous",
    );
  }
  for (const dispatchState of ["dispatching", "ambiguous"] as const) {
    assert.equal(
      classifyApplicationRunRecovery({ ...baseCandidate, runPhase: "starting", dispatchState }).kind,
      "dispatch_ambiguous",
    );
  }
});

test("recovery classifier accepts only an exact durable execution for Provider reconciliation", () => {
  const accepted: RecoveryCandidate = {
    ...baseCandidate,
    runPhase: "active",
    attemptState: "active",
    externalExecutionId: "turn-1",
    dispatchState: "accepted",
    externalSideEffectState: "present",
  };
  assert.equal(classifyApplicationRunRecovery(accepted).kind, "persistent_execution_reconcile");
  assert.equal(
    classifyApplicationRunRecovery({ ...accepted, bindingCreatorSessionId: "other-session" }).kind,
    "diagnostic_invalid",
  );
  assert.equal(
    classifyApplicationRunRecovery({
      ...accepted,
      bindingCreatorAttemptId: "earlier-attempt",
      bindingCreatorRunId: "earlier-run",
    }).kind,
    "persistent_execution_reconcile",
  );
  assert.equal(
    classifyApplicationRunRecovery({
      ...accepted,
      persistenceMode: "ephemeral",
    }).kind,
    "ephemeral_owner_lost",
  );
});

test("recovery classifier permits a persistent Binding reused from an earlier Run in the same Session", () => {
  const reused = {
    ...baseCandidate,
    bindingCreatorAttemptId: "earlier-attempt",
    bindingCreatorRunId: "earlier-run",
  };

  assert.equal(classifyApplicationRunRecovery(reused).kind, "safe_pending_dispatch");
  assert.equal(
    classifyApplicationRunRecovery({
      ...reused,
      persistenceMode: "ephemeral",
    }).kind,
    "diagnostic_invalid",
  );
});

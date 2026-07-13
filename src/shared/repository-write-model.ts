export const REPOSITORY_WRITE_OPERATIONS = {
  sessionCreate: "repository.session.create",
  sessionTransition: "repository.session.transition",
  runAdmit: "repository.run.admit",
  runRetry: "repository.run.retry",
  bindingResolve: "repository.binding.resolve",
  dispatchBegin: "repository.dispatch.begin",
  dispatchResolve: "repository.dispatch.resolve",
  runInputAdmit: "repository.run.input.admit",
  runInputBegin: "repository.run.input.begin",
  runInputResolve: "repository.run.input.resolve",
} as const;

export type SessionLifecycleStatus = "active" | "archived" | "closed";

export type RepositoryJsonValue =
  null | boolean | number | string | readonly RepositoryJsonValue[] | Readonly<{ [key: string]: RepositoryJsonValue }>;

export type RunExecutionSnapshot = Readonly<{
  providerId: string;
  model: string;
  reasoning: RepositoryJsonValue;
  approval: RepositoryJsonValue;
  sandbox: RepositoryJsonValue;
  workspace: Readonly<{ [key: string]: RepositoryJsonValue }>;
  character: Readonly<{ [key: string]: RepositoryJsonValue }> | null;
}>;

export type SessionCreateCommand = Readonly<{
  idempotencyKey: string;
  session: Readonly<{
    id: string;
    providerId: string;
    workspaceKey: string;
    allowedAdditionalDirectories: readonly string[];
    defaultCharacterId: string;
    maxConcurrentChildRuns: number;
  }>;
}>;

export type SessionTransitionCommand = Readonly<{
  sessionId: string;
  workspaceKey: string;
  idempotencyKey: string;
  expectedLifecycleStatus: "active" | "archived";
  targetLifecycleStatus: SessionLifecycleStatus;
}>;

export type RunAdmissionBindingIntent =
  | Readonly<{ kind: "reuse"; bindingId: string }>
  | Readonly<{
      kind: "create";
      bindingId: string;
      persistenceMode: "persistent" | "ephemeral";
    }>;

export type RunAdmissionDispatch = Readonly<{
  providerRequest: Readonly<{ [key: string]: RepositoryJsonValue }>;
  providerIdempotencyKey: string | null;
}>;

export type RunAdmissionDraft = Readonly<{
  id: string;
  executionSnapshot: RunExecutionSnapshot;
}>;

export type NormalRunAdmissionCommand = Readonly<{
  sessionId: string;
  workspaceKey: string;
  idempotencyKey: string;
  message: Readonly<{
    id: string;
    contentBlocks: readonly RepositoryJsonValue[];
  }>;
  run: RunAdmissionDraft;
  attemptId: string;
  bindingIntent: RunAdmissionBindingIntent;
  dispatch: RunAdmissionDispatch;
}>;

export type RetryRunAdmissionCommand = Readonly<{
  sessionId: string;
  workspaceKey: string;
  idempotencyKey: string;
  retryOfRunId: string;
  run: RunAdmissionDraft;
  attemptId: string;
  bindingIntent: RunAdmissionBindingIntent;
  dispatch: RunAdmissionDispatch;
}>;

export type ProviderBindingResolutionCommand = Readonly<{
  sessionId: string;
  workspaceKey: string;
  runId: string;
  attemptId: string;
  bindingId: string;
  resolution:
    | Readonly<{
        kind: "active";
        externalConversationId: string;
        ephemeralOwnerToken: string | null;
      }>
    | Readonly<{
        kind: "ambiguous";
        failureOrigin: "transport" | "process" | "unknown";
        errorSummary: string | null;
      }>;
}>;

export type RunDispatchBeginCommand = Readonly<{
  sessionId: string;
  workspaceKey: string;
  runId: string;
  attemptId: string;
  bindingId: string;
  providerRequest: Readonly<{ [key: string]: RepositoryJsonValue }>;
  ephemeralOwnerToken: string | null;
}>;

export type RunDispatchResolutionCommand = Readonly<{
  sessionId: string;
  workspaceKey: string;
  runId: string;
  attemptId: string;
  bindingId: string;
  ephemeralOwnerToken: string | null;
  outcome:
    | Readonly<{ kind: "accepted"; externalExecutionId: string }>
    | Readonly<{ kind: "rejected" }>
    | Readonly<{ kind: "ambiguous" }>;
}>;

export type RunInputAdmissionCommand = Readonly<{
  sessionId: string;
  workspaceKey: string;
  idempotencyKey: string;
  runId: string;
  attemptId: string;
  ephemeralOwnerToken: string | null;
  message: Readonly<{
    id: string;
    contentBlocks: readonly RepositoryJsonValue[];
  }>;
}>;

export type RunInputBeginCommand = Readonly<{
  sessionId: string;
  workspaceKey: string;
  runId: string;
  attemptId: string;
  messageId: string;
  bindingId: string;
  ephemeralOwnerToken: string | null;
}>;

export type RunInputResolutionCode = "provider_rejected" | "transport_unknown" | "process_unknown";

export type RunInputResolutionCommand = Readonly<{
  sessionId: string;
  workspaceKey: string;
  runId: string;
  attemptId: string;
  messageId: string;
  bindingId: string;
  ephemeralOwnerToken: string | null;
  outcome:
    | Readonly<{ kind: "accepted" }>
    | Readonly<{ kind: "rejected"; resolutionCode: "provider_rejected" }>
    | Readonly<{ kind: "ambiguous"; resolutionCode: "transport_unknown" | "process_unknown" }>;
}>;

export type RepositoryCommandErrorCode =
  | "request_invalid"
  | "not_found"
  | "reference_invalid"
  | "lifecycle_conflict"
  | "session_busy"
  | "capacity_exceeded"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "idempotency_expired";

export type RepositoryCommandResult<T> =
  | Readonly<{ ok: true; value: T; replayed: boolean }>
  | Readonly<{
      ok: false;
      error: Readonly<{ code: RepositoryCommandErrorCode; message: string; retryable: boolean }>;
      replayed: false;
    }>;

export type SessionCreateResult = Readonly<{
  sessionId: string;
  workspaceKey: string;
  lifecycleStatus: "active";
  createdAt: number;
}>;

export type SessionTransitionResult = Readonly<{
  sessionId: string;
  lifecycleStatus: SessionLifecycleStatus;
  updatedAt: number;
}>;

export type NormalRunAdmissionResult = Readonly<{
  sessionId: string;
  messageId: string;
  runId: string;
  attemptId: string;
  bindingId: string;
  bindingState: "creating" | "active";
  dispatchState: "pending";
  admittedAt: number;
}>;

export type RetryRunAdmissionResult = NormalRunAdmissionResult &
  Readonly<{
    retryOfRunId: string;
  }>;

export type ProviderBindingResolutionResult = Readonly<{
  sessionId: string;
  runId: string;
  attemptId: string;
  bindingId: string;
  bindingState: "active" | "invalidated";
  externalConversationId: string | null;
  ephemeralOwnership: "not_applicable" | "registered" | "unavailable";
}>;

export type RunDispatchBeginResult = Readonly<{
  sessionId: string;
  runId: string;
  attemptId: string;
  bindingId: string;
  runPhase: "starting" | "canceling";
  dispatchState: "dispatching";
  dispatchingAt: number;
  sendAllowed: boolean;
}>;

export type RunDispatchResolutionResult = Readonly<{
  sessionId: string;
  runId: string;
  attemptId: string;
  bindingId: string;
  dispatchState: "accepted" | "rejected" | "ambiguous";
  externalExecutionId: string | null;
  resolvedAt: number;
}>;

export type RunInputAdmissionResult = Readonly<{
  sessionId: string;
  runId: string;
  attemptId: string;
  messageId: string;
  bindingId: string;
  deliveryState: "pending" | "accepted" | "rejected" | "ambiguous";
  resolutionCode: RunInputResolutionCode | null;
  admittedAt: number;
  dispatchingAt: number | null;
  resolvedAt: number | null;
}>;

export type RunInputBeginResult = Readonly<{
  sessionId: string;
  runId: string;
  attemptId: string;
  messageId: string;
  bindingId: string;
  deliveryState: "dispatching";
  dispatchingAt: number;
  sendAllowed: boolean;
}>;

export type RunInputResolutionResult = Readonly<{
  sessionId: string;
  runId: string;
  attemptId: string;
  messageId: string;
  bindingId: string;
  deliveryState: "accepted" | "rejected" | "ambiguous";
  resolutionCode: RunInputResolutionCode | null;
  resolvedAt: number;
}>;

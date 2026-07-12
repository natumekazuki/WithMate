export const REPOSITORY_WRITE_OPERATIONS = {
  sessionCreate: "repository.session.create",
  sessionTransition: "repository.session.transition",
  runAdmit: "repository.run.admit",
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

export type NormalRunAdmissionCommand = Readonly<{
  sessionId: string;
  workspaceKey: string;
  idempotencyKey: string;
  message: Readonly<{
    id: string;
    contentBlocks: readonly RepositoryJsonValue[];
  }>;
  run: Readonly<{
    id: string;
    executionSnapshot: RunExecutionSnapshot;
  }>;
  attemptId: string;
  bindingIntent:
    | Readonly<{ kind: "reuse"; bindingId: string }>
    | Readonly<{
        kind: "create";
        bindingId: string;
        persistenceMode: "persistent" | "ephemeral";
      }>;
  dispatch: Readonly<{
    providerRequest: Readonly<{ [key: string]: RepositoryJsonValue }>;
    providerIdempotencyKey: string | null;
  }>;
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

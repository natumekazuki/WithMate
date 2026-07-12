export const REPOSITORY_WRITE_OPERATIONS = {
  sessionCreate: "repository.session.create",
  sessionTransition: "repository.session.transition",
} as const;

export type SessionLifecycleStatus = "active" | "archived" | "closed";

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

export type RepositoryCommandErrorCode =
  | "request_invalid"
  | "not_found"
  | "reference_invalid"
  | "lifecycle_conflict"
  | "session_busy"
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

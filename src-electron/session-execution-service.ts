import {
  type SessionExecution,
  type SessionExecutionOperation,
  type SessionExecutionStorageRecord,
} from "../src/session-execution.js";
import {
  SessionExecutionBusyError,
  SessionExecutionStateConflictError,
  type SessionExecutionStorageV6,
} from "./session-execution-storage-v6.js";

export type SessionExecutionDispatchResult = {
  state: "completed" | "failed" | "canceled";
  result: unknown | null;
  errorCode?: string;
  reason?: string;
};

export type CreateSessionExecutionInput = {
  sessionId: string;
  request: unknown;
  idempotencyKey: string;
  requestFingerprint: string;
};

export type CancelSessionExecutionInput = {
  sessionId: string;
  executionId: string;
  idempotencyKey: string;
  requestFingerprint: string;
};

export type SessionExecutionServiceDeps = {
  storage: Pick<
    SessionExecutionStorageV6,
    | "admitNextQueued"
    | "cancelQueuedIdempotent"
    | "cleanupExpiredIdempotency"
    | "completeRunning"
    | "enqueue"
    | "get"
    | "interruptRunningForRestart"
    | "listSessionExecutions"
    | "listSessionExecutionsPage"
    | "listQueuedSessionIds"
    | "resolveIdempotency"
    | "recordIdempotency"
    | "startImmediate"
  >;
  validateTurn(sessionId: string, request: unknown): Promise<void> | void;
  dispatchTurn(
    sessionId: string,
    executionId: string,
    request: unknown,
  ): Promise<SessionExecutionDispatchResult>;
  cancelRunningTurn(sessionId: string, executionId: string): Promise<void> | void;
  isSessionRunInFlight(sessionId: string): boolean;
  createExecutionId(): string;
  currentTimestamp(): string;
  resolveIdempotencyExpiresAt(createdAt: string): string;
};

export class SessionExecutionNotFoundError extends Error {
  readonly code = "EXECUTION_NOT_FOUND";

  constructor(readonly executionId: string) {
    super(`Session execution was not found: ${executionId}`);
    this.name = "SessionExecutionNotFoundError";
  }
}

export class SessionExecutionOwnerMismatchError extends Error {
  readonly code = "EXECUTION_OWNER_MISMATCH";

  constructor(readonly sessionId: string, readonly executionId: string) {
    super(`Session execution does not belong to the requested session: ${executionId}`);
    this.name = "SessionExecutionOwnerMismatchError";
  }
}

export class SessionExecutionService {
  private readonly sessionLocks = new Map<string, Promise<void>>();
  private readonly idempotencyLocks = new Map<string, Promise<void>>();
  private readonly dispatches = new Map<string, Promise<SessionExecution>>();
  private acceptingDispatches = true;

  constructor(private readonly deps: SessionExecutionServiceDeps) {}

  beginShutdown(): void {
    this.acceptingDispatches = false;
  }

  async run(input: CreateSessionExecutionInput): Promise<SessionExecution> {
    const replay = this.resolveReplay("turn.run", input);
    if (replay) {
      return replay;
    }
    await this.deps.validateTurn(input.sessionId, input.request);
    return this.withSessionLock(input.sessionId, () => {
      this.requireDispatchAdmission();
      const replay = this.deps.storage.resolveIdempotency(
        "turn.run",
        input.idempotencyKey,
        input.requestFingerprint,
      );
      if (replay) {
        return toPublicExecution(replay);
      }
      if (this.deps.isSessionRunInFlight(input.sessionId)) {
        throw new SessionExecutionBusyError(input.sessionId);
      }

      const createdAt = this.deps.currentTimestamp();
      const started = this.deps.storage.startImmediate({
        id: this.issueExecutionId(),
        sessionId: input.sessionId,
        request: input.request,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        createdAt,
        expiresAt: this.deps.resolveIdempotencyExpiresAt(createdAt),
      });
      if (!started.replayed) {
        this.startDispatch(started.execution);
      }
      return toPublicExecution(started.execution);
    });
  }

  async enqueue(input: CreateSessionExecutionInput): Promise<SessionExecution> {
    const replay = this.resolveReplay("turn.enqueue", input);
    if (replay) {
      return replay;
    }
    await this.deps.validateTurn(input.sessionId, input.request);
    const queued = await this.withSessionLock(input.sessionId, () => {
      this.requireDispatchAdmission();
      const createdAt = this.deps.currentTimestamp();
      return this.deps.storage.enqueue({
        id: this.issueExecutionId(),
        sessionId: input.sessionId,
        request: input.request,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        createdAt,
        expiresAt: this.deps.resolveIdempotencyExpiresAt(createdAt),
      });
    });
    if (!queued.replayed) {
      void this.drainSession(input.sessionId);
    }
    return toPublicExecution(queued.execution);
  }

  get(sessionId: string, executionId: string): SessionExecution {
    return toPublicExecution(this.getOwned(sessionId, executionId));
  }

  list(sessionId: string): SessionExecution[] {
    return this.deps.storage.listSessionExecutions(sessionId).map(toPublicExecution);
  }

  listPage(sessionId: string, afterSequence: number | null, limit: number): SessionExecutionStorageRecord[] {
    return this.deps.storage.listSessionExecutionsPage(sessionId, afterSequence, limit);
  }

  resolveReplay(operation: SessionExecutionOperation, input: CreateSessionExecutionInput): SessionExecution | null {
    const replay = this.deps.storage.resolveIdempotency(
      operation,
      input.idempotencyKey,
      input.requestFingerprint,
    );
    return replay ? toPublicExecution(replay) : null;
  }

  async cancel(input: CancelSessionExecutionInput): Promise<SessionExecution> {
    const replay = this.deps.storage.resolveIdempotency(
      "turn.cancel",
      input.idempotencyKey,
      input.requestFingerprint,
    );
    if (replay) {
      return toPublicExecution(replay);
    }
    return this.withIdempotencyLock(`turn.cancel:${input.idempotencyKey}`, () => this.withSessionLock(input.sessionId, async () => {
      const lockedReplay = this.deps.storage.resolveIdempotency(
        "turn.cancel",
        input.idempotencyKey,
        input.requestFingerprint,
      );
      if (lockedReplay) {
        return toPublicExecution(lockedReplay);
      }
      const execution = this.getOwned(input.sessionId, input.executionId);
      const createdAt = this.deps.currentTimestamp();
      const expiresAt = this.deps.resolveIdempotencyExpiresAt(createdAt);
      if (execution.state === "queued") {
        return toPublicExecution(
          this.deps.storage.cancelQueuedIdempotent({
            executionId: execution.id,
            idempotencyKey: input.idempotencyKey,
            requestFingerprint: input.requestFingerprint,
            canceledAt: createdAt,
            expiresAt,
          }),
        );
      }
      if (execution.state === "running") {
        await this.deps.cancelRunningTurn(input.sessionId, input.executionId);
        return toPublicExecution(this.deps.storage.recordIdempotency({
          operation: "turn.cancel",
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          executionId: input.executionId,
          createdAt,
          expiresAt,
        }));
      }
      throw new SessionExecutionStateConflictError(execution.id, execution.state);
    }));
  }

  async reconcileAfterRestart(): Promise<SessionExecution[]> {
    const interruptedAt = this.deps.currentTimestamp();
    this.deps.storage.cleanupExpiredIdempotency(interruptedAt);
    const interrupted = this.deps.storage.interruptRunningForRestart(
      interruptedAt,
      this.deps.resolveIdempotencyExpiresAt(interruptedAt),
    );
    for (const sessionId of this.deps.storage.listQueuedSessionIds()) {
      await this.drainSession(sessionId);
    }
    return interrupted.map(toPublicExecution);
  }

  resumeQueue(sessionId: string): Promise<void> {
    return this.drainSession(sessionId);
  }

  cleanupExpiredIdempotency(): number {
    return this.deps.storage.cleanupExpiredIdempotency(this.deps.currentTimestamp());
  }

  async waitForTerminal(sessionId: string, executionId: string): Promise<SessionExecution> {
    const execution = this.getOwned(sessionId, executionId);
    const dispatch = this.dispatches.get(executionId);
    if (dispatch) {
      return dispatch;
    }
    return toPublicExecution(execution);
  }

  private startDispatch(execution: SessionExecutionStorageRecord): void {
    const dispatch = this.runDispatch(execution);
    this.dispatches.set(execution.id, dispatch);
    const cleanup = () => {
      this.dispatches.delete(execution.id);
    };
    dispatch.then(cleanup, cleanup);
  }

  private async runDispatch(execution: SessionExecutionStorageRecord): Promise<SessionExecution> {
    let outcome: SessionExecutionDispatchResult;
    try {
      outcome = await this.deps.dispatchTurn(execution.sessionId, execution.id, execution.request);
    } catch {
      outcome = {
        state: "failed",
        result: null,
        errorCode: "PROVIDER_FAILURE",
        reason: "session_runtime_failed",
      };
    }

    const completed = await this.withSessionLock(execution.sessionId, () => {
      const current = this.getOwned(execution.sessionId, execution.id);
      if (current.state !== "running") {
        throw new SessionExecutionStateConflictError(current.id, current.state);
      }
      const completedAt = this.deps.currentTimestamp();
      return this.deps.storage.completeRunning({
        executionId: execution.id,
        state: outcome.state,
        result: outcome.result,
        errorCode: outcome.errorCode ?? "",
        reason: outcome.reason ?? "",
        completedAt,
        expiresAt: this.deps.resolveIdempotencyExpiresAt(completedAt),
      });
    });
    void this.drainSession(execution.sessionId);
    return toPublicExecution(completed);
  }

  private async drainSession(sessionId: string): Promise<void> {
    await this.withSessionLock(sessionId, () => {
      if (!this.acceptingDispatches) {
        return;
      }
      if (this.deps.isSessionRunInFlight(sessionId)) {
        return;
      }
      const admitted = this.deps.storage.admitNextQueued(sessionId, this.deps.currentTimestamp());
      if (admitted) {
        this.startDispatch(admitted);
      }
    });
  }

  private getOwned(sessionId: string, executionId: string): SessionExecutionStorageRecord {
    const execution = this.deps.storage.get(executionId);
    if (!execution) {
      throw new SessionExecutionNotFoundError(executionId);
    }
    if (execution.sessionId !== sessionId) {
      throw new SessionExecutionOwnerMismatchError(sessionId, executionId);
    }
    return execution;
  }

  private issueExecutionId(): string {
    const executionId = this.deps.createExecutionId().trim();
    if (!executionId) {
      throw new Error("Session execution ID is empty.");
    }
    return executionId;
  }

  private requireDispatchAdmission(): void {
    if (!this.acceptingDispatches) {
      throw new SessionExecutionShuttingDownError();
    }
  }

  private withIdempotencyLock<T>(key: string, run: () => Promise<T> | T): Promise<T> {
    const previous = this.idempotencyLocks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    const released = next.then(() => undefined, () => undefined);
    this.idempotencyLocks.set(key, released);
    void released.finally(() => {
      if (this.idempotencyLocks.get(key) === released) {
        this.idempotencyLocks.delete(key);
      }
    });
    return next;
  }

  private withSessionLock<T>(sessionId: string, run: () => Promise<T> | T): Promise<T> {
    const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    const released = next.then(() => undefined, () => undefined);
    this.sessionLocks.set(sessionId, released);
    void released.finally(() => {
      if (this.sessionLocks.get(sessionId) === released) {
        this.sessionLocks.delete(sessionId);
      }
    });
    return next;
  }
}

export class SessionExecutionShuttingDownError extends Error {
  readonly code = "RUNTIME_SHUTTING_DOWN";

  constructor() {
    super("The Session runtime is shutting down.");
    this.name = "SessionExecutionShuttingDownError";
  }
}

export function toPublicExecution(execution: SessionExecutionStorageRecord): SessionExecution {
  return {
    id: execution.id,
    sessionId: execution.sessionId,
    operation: execution.operation,
    state: execution.state,
    result: execution.result,
    errorCode: execution.errorCode,
    reason: execution.reason,
    createdAt: execution.createdAt,
    admittedAt: execution.admittedAt,
    completedAt: execution.completedAt,
    updatedAt: execution.updatedAt,
  };
}

export function isTerminalSessionExecution(execution: SessionExecution): boolean {
  return isTerminalSessionExecutionState(execution.state);
}

function isTerminalSessionExecutionState(state: SessionExecution["state"]): boolean {
  return state === "completed"
    || state === "failed"
    || state === "canceled"
    || state === "interrupted";
}

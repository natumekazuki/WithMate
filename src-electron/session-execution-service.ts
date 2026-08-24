import {
  type SessionExecution,
  type SessionExecutionOriginSnapshot,
  type SessionExecutionOperation,
  type SessionInboundExecutionRecord,
  type SessionOutboundExecutionRecord,
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
  origin?: SessionExecutionOriginSnapshot;
  workItemId?: string;
};

export type CancelSessionExecutionInput = {
  sessionId: string;
  executionId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  expectedState?: "queued";
};

export type SessionExecutionServiceDeps = {
  storage: Pick<
    SessionExecutionStorageV6,
    | "admitNextQueued"
    | "failNextQueued"
    | "cancelQueuedIdempotent"
    | "cleanupExpiredIdempotency"
    | "completeRunning"
    | "enqueue"
    | "get"
    | "interruptRunningForRestart"
    | "interruptRunningForShutdown"
    | "listSessionExecutions"
    | "listSessionExecutionProjectionRecords"
    | "listSessionInboundExecutions"
    | "listSessionOutboundExecutions"
    | "listSessionExecutionsPage"
    | "iterateSessionExecutionsPage"
    | "listQueuedSessionIds"
    | "listTerminalFailureNotificationCandidates"
    | "resolveIdempotency"
    | "recordIdempotency"
    | "startImmediate"
  >;
  validateTurn(sessionId: string, request: unknown): Promise<unknown> | unknown;
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
  queueRetryDelayMs?: number;
  shutdownGraceMs?: number;
  onExecutionChanged?(executionId: string): void;
  onExecutionTerminal?(
    executionId: string,
    reason: "execution_canceled" | "execution_terminal",
    occurredAt: string,
  ): void;
};

const DEFAULT_QUEUE_RETRY_DELAY_MS = 25;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_000;
const MAX_QUEUE_ADMISSION_ATTEMPTS = 2;
const MAX_QUEUE_RETRY_DELAY_MS = 30_000;

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
  private readonly activeDispatches = new Map<string, SessionExecutionStorageRecord>();
  private readonly drainAttempts = new Map<string, Promise<void>>();
  private readonly drainRetryTimers = new Map<string, NodeJS.Timeout>();
  private readonly drainFailureCounts = new Map<string, number>();
  private readonly shutdownTerminalExecutions = new Map<string, SessionExecutionStorageRecord>();
  private readonly queueRetryDelayMs: number;
  private readonly shutdownGraceMs: number;
  private acceptingDispatches = true;
  private persistenceFenced = false;
  private shutdownDrain: Promise<void> | null = null;

  constructor(private readonly deps: SessionExecutionServiceDeps) {
    this.queueRetryDelayMs = requirePositiveInteger(
      deps.queueRetryDelayMs ?? DEFAULT_QUEUE_RETRY_DELAY_MS,
      "queueRetryDelayMs",
    );
    this.shutdownGraceMs = requirePositiveInteger(
      deps.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
      "shutdownGraceMs",
    );
  }

  beginShutdown(): void {
    this.acceptingDispatches = false;
    for (const retry of this.drainRetryTimers.values()) {
      clearTimeout(retry);
    }
    this.drainRetryTimers.clear();
    this.drainFailureCounts.clear();
  }

  hasInFlightExecutions(): boolean {
    return this.activeDispatches.size > 0 || this.dispatches.size > 0;
  }

  async drainForShutdown(): Promise<void> {
    this.beginShutdown();
    if (!this.shutdownDrain) {
      this.shutdownDrain = this.performShutdownDrain();
    }
    await this.shutdownDrain;
  }

  async run(input: CreateSessionExecutionInput): Promise<SessionExecution> {
    this.requirePersistenceAvailable();
    const replay = this.resolveReplay("turn.run", input);
    if (replay) {
      return replay;
    }
    const validatedRequest = await this.deps.validateTurn(input.sessionId, input.request);
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
        request: validatedRequest,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        createdAt,
        expiresAt: this.deps.resolveIdempotencyExpiresAt(createdAt),
        origin: input.origin,
      });
      if (!started.replayed) {
        this.notifyChanged(started.execution.id);
        this.startDispatch(started.execution);
      }
      return toPublicExecution(started.execution);
    });
  }

  async enqueue(input: CreateSessionExecutionInput): Promise<SessionExecution> {
    this.requirePersistenceAvailable();
    const replay = this.resolveReplay("turn.enqueue", input);
    if (replay) {
      return replay;
    }
    const validatedRequest = await this.deps.validateTurn(input.sessionId, input.request);
    const queued = await this.withSessionLock(input.sessionId, () => {
      this.requireDispatchAdmission();
      const createdAt = this.deps.currentTimestamp();
      return this.deps.storage.enqueue({
        id: this.issueExecutionId(),
        sessionId: input.sessionId,
        request: validatedRequest,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        createdAt,
        expiresAt: this.deps.resolveIdempotencyExpiresAt(createdAt),
        origin: input.origin,
      });
    });
    if (!queued.replayed) {
      this.notifyChanged(queued.execution.id);
      void this.requestDrain(input.sessionId);
    }
    return toPublicExecution(queued.execution);
  }

  get(sessionId: string, executionId: string): SessionExecution {
    this.requirePersistenceAvailable();
    return toPublicExecution(this.getOwned(sessionId, executionId));
  }

  getRecord(sessionId: string, executionId: string): SessionExecutionStorageRecord {
    this.requirePersistenceAvailable();
    return this.getOwned(sessionId, executionId);
  }

  list(sessionId: string): SessionExecution[] {
    this.requirePersistenceAvailable();
    return this.deps.storage.listSessionExecutions(sessionId).map(toPublicExecution);
  }

  listRecords(sessionId: string): SessionExecutionStorageRecord[] {
    this.requirePersistenceAvailable();
    return this.deps.storage.listSessionExecutionProjectionRecords(sessionId);
  }

  listOutboundRecords(sessionId: string): SessionOutboundExecutionRecord[] {
    this.requirePersistenceAvailable();
    return this.deps.storage.listSessionOutboundExecutions(sessionId);
  }

  listInboundRecords(sessionId: string): SessionInboundExecutionRecord[] {
    this.requirePersistenceAvailable();
    return this.deps.storage.listSessionInboundExecutions(sessionId);
  }

  listPage(sessionId: string, afterSequence: number | null, limit: number): Iterable<SessionExecutionStorageRecord> {
    this.requirePersistenceAvailable();
    return this.deps.storage.iterateSessionExecutionsPage(sessionId, afterSequence, limit);
  }

  resolveReplay(operation: SessionExecutionOperation, input: CreateSessionExecutionInput): SessionExecution | null {
    this.requirePersistenceAvailable();
    const replay = this.deps.storage.resolveIdempotency(
      operation,
      input.idempotencyKey,
      input.requestFingerprint,
    );
    return replay ? toPublicExecution(replay) : null;
  }

  async cancel(input: CancelSessionExecutionInput): Promise<SessionExecution> {
    this.requirePersistenceAvailable();
    const replay = this.deps.storage.resolveIdempotency(
      "turn.cancel",
      input.idempotencyKey,
      input.requestFingerprint,
    );
    if (replay) {
      if (input.expectedState && replay.state !== input.expectedState && replay.state !== "canceled") {
        throw new SessionExecutionStateConflictError(replay.id, replay.state);
      }
      if (replay.state === "running") {
        await this.deps.cancelRunningTurn(replay.sessionId, replay.id);
      }
      return toPublicExecution(replay);
    }
    return this.withIdempotencyLock(`turn.cancel:${input.idempotencyKey}`, () => this.withSessionLock(input.sessionId, async () => {
      this.requirePersistenceAvailable();
      const lockedReplay = this.deps.storage.resolveIdempotency(
        "turn.cancel",
        input.idempotencyKey,
        input.requestFingerprint,
      );
      if (lockedReplay) {
        if (input.expectedState && lockedReplay.state !== input.expectedState && lockedReplay.state !== "canceled") {
          throw new SessionExecutionStateConflictError(lockedReplay.id, lockedReplay.state);
        }
        if (lockedReplay.state === "running") {
          await this.deps.cancelRunningTurn(lockedReplay.sessionId, lockedReplay.id);
        }
        return toPublicExecution(lockedReplay);
      }
      const execution = this.getOwned(input.sessionId, input.executionId);
      if (input.expectedState && execution.state !== input.expectedState) {
        throw new SessionExecutionStateConflictError(execution.id, execution.state);
      }
      const createdAt = this.deps.currentTimestamp();
      const expiresAt = this.deps.resolveIdempotencyExpiresAt(createdAt);
      if (execution.state === "queued") {
        const canceled = this.deps.storage.cancelQueuedIdempotent({
            executionId: execution.id,
            idempotencyKey: input.idempotencyKey,
            requestFingerprint: input.requestFingerprint,
            canceledAt: createdAt,
            expiresAt,
          });
        this.notifyTerminal(canceled.id, "execution_canceled", createdAt);
        this.notifyChanged(canceled.id);
        return toPublicExecution(canceled);
      }
      if (execution.state === "running") {
        const canonical = this.deps.storage.recordIdempotency({
          operation: "turn.cancel",
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          executionId: input.executionId,
          createdAt,
          expiresAt,
        });
        await this.deps.cancelRunningTurn(input.sessionId, input.executionId);
        return toPublicExecution(canonical);
      }
      throw new SessionExecutionStateConflictError(execution.id, execution.state);
    }));
  }

  async reconcileAfterRestart(): Promise<SessionExecution[]> {
    this.requirePersistenceAvailable();
    const interruptedAt = this.deps.currentTimestamp();
    this.deps.storage.cleanupExpiredIdempotency(interruptedAt);
    const interrupted = this.deps.storage.interruptRunningForRestart(
      interruptedAt,
      this.deps.resolveIdempotencyExpiresAt(interruptedAt),
    );
    for (const execution of interrupted) {
      this.notifyTerminal(execution.id, "execution_terminal", interruptedAt);
      this.notifyChanged(execution.id);
    }
    for (const sessionId of this.deps.storage.listQueuedSessionIds()) {
      await this.requestDrain(sessionId);
    }
    return interrupted.map(toPublicExecution);
  }

  resumeQueue(sessionId: string): Promise<void> {
    return this.requestDrain(sessionId);
  }

  cleanupExpiredIdempotency(): number {
    this.requirePersistenceAvailable();
    return this.deps.storage.cleanupExpiredIdempotency(this.deps.currentTimestamp());
  }

  async waitForTerminal(sessionId: string, executionId: string): Promise<SessionExecution> {
    const shutdownTerminal = this.shutdownTerminalExecutions.get(executionId);
    if (shutdownTerminal) {
      if (shutdownTerminal.sessionId !== sessionId) {
        throw new SessionExecutionOwnerMismatchError(sessionId, executionId);
      }
      return toPublicExecution(shutdownTerminal);
    }
    this.requirePersistenceAvailable();
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
    this.activeDispatches.set(execution.id, execution);
    const cleanup = () => {
      this.dispatches.delete(execution.id);
      this.activeDispatches.delete(execution.id);
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

    if (this.persistenceFenced) {
      return toPublicExecution(this.getShutdownTerminalExecution(execution));
    }

    const completed = await this.withSessionLock(execution.sessionId, () => {
      if (this.persistenceFenced) {
        return this.getShutdownTerminalExecution(execution);
      }
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
    this.notifyTerminal(
      completed.id,
      completed.state === "canceled" ? "execution_canceled" : "execution_terminal",
      completed.completedAt ?? completed.updatedAt,
    );
    void this.requestDrain(execution.sessionId);
    this.notifyChanged(completed.id);
    return toPublicExecution(completed);
  }

  private requestDrain(sessionId: string, allowRetry = true): Promise<void> {
    const existing = this.drainAttempts.get(sessionId);
    if (existing) {
      return existing;
    }
    let drainNextAfterCleanup = false;
    const attempt = this.drainSession(sessionId)
      .catch(() => {
        if (allowRetry) {
          const failures = (this.drainFailureCounts.get(sessionId) ?? 0) + 1;
          this.drainFailureCounts.set(sessionId, failures);
          if (failures < MAX_QUEUE_ADMISSION_ATTEMPTS) {
            this.scheduleDrainRetry(sessionId);
          } else {
            const exhaustion = this.failQueuedAfterAdmissionExhaustion(sessionId);
            drainNextAfterCleanup = exhaustion === "failed";
            if (exhaustion === "retry") {
              this.scheduleDrainRetry(sessionId);
            }
          }
        }
      })
      .finally(() => {
        if (this.drainAttempts.get(sessionId) === attempt) {
          this.drainAttempts.delete(sessionId);
          if (drainNextAfterCleanup) {
            void this.requestDrain(sessionId);
          }
        }
      });
    this.drainAttempts.set(sessionId, attempt);
    return attempt;
  }

  private scheduleDrainRetry(sessionId: string): void {
    if (!this.acceptingDispatches || this.persistenceFenced || this.drainRetryTimers.has(sessionId)) {
      return;
    }
    const retry = setTimeout(() => {
      this.drainRetryTimers.delete(sessionId);
      if (!this.acceptingDispatches || this.persistenceFenced) {
        return;
      }
      void this.requestDrain(sessionId);
    }, Math.min(
      this.queueRetryDelayMs * (2 ** Math.min((this.drainFailureCounts.get(sessionId) ?? 1) - 1, 10)),
      MAX_QUEUE_RETRY_DELAY_MS,
    ));
    retry.unref();
    this.drainRetryTimers.set(sessionId, retry);
  }

  private async drainSession(sessionId: string): Promise<void> {
    await this.withSessionLock(sessionId, () => {
      if (!this.acceptingDispatches || this.persistenceFenced) {
        return;
      }
      if (this.deps.isSessionRunInFlight(sessionId)) {
        return;
      }
      const admitted = this.deps.storage.admitNextQueued(sessionId, this.deps.currentTimestamp());
      if (admitted) {
        this.drainFailureCounts.delete(sessionId);
        this.notifyChanged(admitted.id);
        this.startDispatch(admitted);
      }
    });
  }

  private failQueuedAfterAdmissionExhaustion(sessionId: string): "failed" | "empty" | "retry" {
    if (!this.acceptingDispatches || this.persistenceFenced) {
      return "empty";
    }
    try {
      const failedAt = this.deps.currentTimestamp();
      const failed = this.deps.storage.failNextQueued(
        sessionId,
        failedAt,
        this.deps.resolveIdempotencyExpiresAt(failedAt),
      );
      this.drainFailureCounts.delete(sessionId);
      if (failed) {
        this.notifyTerminal(failed.id, "execution_terminal", failedAt);
        this.notifyChanged(failed.id);
        return "failed";
      }
      return "empty";
    } catch (error) {
      // Keep the durable queue recoverable after a transient terminal-write failure.
      // The tracked timer is unref'd and canceled by beginShutdown().
      void error;
      return "retry";
    }
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

  private requirePersistenceAvailable(): void {
    if (this.persistenceFenced) {
      throw new SessionExecutionShuttingDownError();
    }
  }

  private async performShutdownDrain(): Promise<void> {
    for (const execution of this.activeDispatches.values()) {
      try {
        void Promise.resolve(this.deps.cancelRunningTurn(execution.sessionId, execution.id)).catch(() => undefined);
      } catch {
        // Provider cancellation is best effort; the finite grace still settles persistence.
      }
    }

    await waitForPromisesWithin([...this.dispatches.values()], this.shutdownGraceMs);

    const interruptedAt = this.deps.currentTimestamp();
    try {
      const interrupted = this.deps.storage.interruptRunningForShutdown(
        interruptedAt,
        this.deps.resolveIdempotencyExpiresAt(interruptedAt),
      );
      for (const execution of interrupted) {
        this.shutdownTerminalExecutions.set(execution.id, execution);
        this.notifyTerminal(execution.id, "execution_terminal", interruptedAt);
        this.notifyChanged(execution.id);
      }
    } finally {
      this.persistenceFenced = true;
    }
  }

  private getShutdownTerminalExecution(execution: SessionExecutionStorageRecord): SessionExecutionStorageRecord {
    const terminal = this.shutdownTerminalExecutions.get(execution.id);
    if (!terminal) {
      throw new SessionExecutionStateConflictError(execution.id, execution.state);
    }
    return terminal;
  }

  private notifyChanged(executionId: string): void {
    try {
      this.deps.onExecutionChanged?.(executionId);
    } catch {
      // The execution state is already committed. Projection observers are best-effort
      // and must not block provider dispatch or durable queue progress.
    }
  }

  private notifyTerminal(
    executionId: string,
    reason: "execution_canceled" | "execution_terminal",
    occurredAt: string,
  ): void {
    try {
      this.deps.onExecutionTerminal?.(executionId, reason, occurredAt);
    } catch {
      // Terminal state is already committed. Observers are wake-up/cleanup signals
      // and must not change the source execution outcome or block queue progress.
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

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Session execution ${name} must be a positive integer.`);
  }
  return value;
}

async function waitForPromisesWithin(promises: Promise<unknown>[], timeoutMs: number): Promise<void> {
  if (promises.length === 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, timeoutMs);
    void Promise.allSettled(promises).then(finish);
  });
}

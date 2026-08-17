import { createHash } from "node:crypto";

import type {
  CreateSessionScheduleInput,
  SessionSchedule,
  SessionScheduleChangedEvent,
  SessionScheduleProjection,
  SessionScheduleRevisionRequest,
  SessionScheduleTurn,
  SessionScheduleTrigger,
  UpdateSessionScheduleInput,
} from "../src/session-schedule.js";

export type SessionScheduleFireClaim = {
  id: string;
  scheduleId: string;
  sessionId: string;
  scheduleRevision: number;
  kind: "scheduled" | "run_now";
  triggerKind: SessionScheduleTrigger["type"];
  logicalFireAt: string;
  enqueueIdempotencyKey: string;
  turnSnapshot: unknown;
};

export type SessionScheduleDueResolution = {
  /** The latest occurrence at or before now. Earlier missed occurrences are intentionally collapsed. */
  logicalFireAt: string;
  /** The first occurrence strictly after now, calculated from the saved recurrence. */
  nextFireAt: string | null;
};

export type SessionScheduleEnqueueResult =
  | { ok: true; executionId: string }
  | {
      ok: false;
      errorCode: string;
      reason: string;
      pauseSchedule: boolean;
    };

export type CreateSessionScheduleRequest = CreateSessionScheduleInput & {
  sessionId: string;
};

export type UpdateSessionScheduleRequest = UpdateSessionScheduleInput & {
  sessionId: string;
};

export type SessionScheduleMutationRequest = SessionScheduleRevisionRequest & {
  sessionId: string;
};

export type SessionScheduleStorage = {
  create(
    input: Omit<SessionSchedule, "revision" | "state"> & { state?: "active" },
  ): SessionSchedule;
  get(id: string): SessionSchedule | null;
  list(sessionId?: string): SessionScheduleProjection[];
  update(input: {
    id: string;
    expectedRevision: number;
    name: string;
    trigger: SessionScheduleTrigger;
    turn: SessionScheduleTurn;
    nextFireAt: string | null;
    updatedAt: string;
  }): SessionSchedule;
  listActiveSchedules(): SessionSchedule[];
  setScheduleState(input: {
    id: string;
    expectedRevision: number;
    state: "active" | "paused";
    nextFireAt: string | null;
    updatedAt: string;
  }): SessionSchedule;
  deleteSchedule(input: {
    id: string;
    expectedRevision: number;
    updatedAt: string;
  }): void;
  listPendingFireClaims(claimedAt: string): SessionScheduleFireClaim[];
  claimScheduledFire(input: {
    scheduleId: string;
    expectedRevision: number;
    expectedNextFireAt: string;
    logicalFireAt: string;
    nextFireAt: string | null;
    fireId: string;
    idempotencyKey: string;
    claimedAt: string;
  }): SessionScheduleFireClaim | null;
  claimRunNowFire(input: {
    scheduleId: string;
    requestId: string;
    logicalFireAt: string;
    fireId: string;
    idempotencyKey: string;
    claimedAt: string;
  }): SessionScheduleFireClaim;
  settleFireEnqueued(input: {
    fireId: string;
    executionId: string;
    settledAt: string;
    completeOnce: boolean;
  }): void;
  settleFireFailed(input: {
    fireId: string;
    errorCode: string;
    reason: string;
    settledAt: string;
    pauseSchedule: boolean;
  }): void;
};

export type SessionScheduleTimerHandle = {
  unref?(): void;
};

export type SessionScheduleServiceDeps = {
  storage: SessionScheduleStorage;
  createScheduleId(): string;
  validateTrigger(trigger: SessionScheduleTrigger, now: Date): void;
  nextTriggerInstant(trigger: SessionScheduleTrigger, after: Date): Date;
  validateScheduleTurn(
    sessionId: string,
    turn: SessionScheduleTurn,
  ): Promise<SessionScheduleTurn> | SessionScheduleTurn;
  resolveDueOccurrence(
    schedule: SessionSchedule,
    now: Date,
  ): SessionScheduleDueResolution | null;
  enqueueTurn(input: {
    sessionId: string;
    turn: SessionScheduleTurn;
    idempotencyKey: string;
  }): Promise<SessionScheduleEnqueueResult>;
  now?(): Date;
  setTimer?(callback: () => void, delayMs: number): SessionScheduleTimerHandle;
  clearTimer?(handle: SessionScheduleTimerHandle): void;
  pendingRetryDelayMs?: number;
  maxTimerDelayMs?: number;
  onChanged?(event: SessionScheduleChangedEvent): void;
  onBackgroundError?(error: unknown): void;
};

const DEFAULT_PENDING_RETRY_DELAY_MS = 5_000;
const DEFAULT_MAX_TIMER_DELAY_MS = 60_000;

export class SessionScheduleNotFoundError extends Error {
  readonly code = "SCHEDULE_NOT_FOUND";
  constructor(readonly scheduleId: string) {
    super(`Session schedule was not found: ${scheduleId}`);
    this.name = "SessionScheduleNotFoundError";
  }
}

export class SessionScheduleOwnerMismatchError extends Error {
  readonly code = "SCHEDULE_OWNER_MISMATCH";
  constructor(
    readonly sessionId: string,
    readonly scheduleId: string,
  ) {
    super(
      `Session schedule does not belong to the requested Session: ${scheduleId}`,
    );
    this.name = "SessionScheduleOwnerMismatchError";
  }
}

export class SessionScheduleRevisionConflictError extends Error {
  readonly code = "SCHEDULE_REVISION_CONFLICT";
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Session schedule revision changed from ${expectedRevision} to ${actualRevision}.`,
    );
    this.name = "SessionScheduleRevisionConflictError";
  }
}

/** Owns schedule mutations and the single process-lifetime scheduling loop. */
export class SessionScheduleService {
  private readonly pendingRetryDelayMs: number;
  private readonly maxTimerDelayMs: number;
  private timer: SessionScheduleTimerHandle | null = null;
  private started = false;
  private stopped = false;
  private requestedWhileRunning = false;
  private reconciliation: Promise<void> | null = null;
  private drainRequestedWhileRunning = false;
  private drain: Promise<void> | null = null;

  constructor(private readonly deps: SessionScheduleServiceDeps) {
    this.pendingRetryDelayMs = requirePositiveFiniteInteger(
      deps.pendingRetryDelayMs ?? DEFAULT_PENDING_RETRY_DELAY_MS,
      "pendingRetryDelayMs",
    );
    this.maxTimerDelayMs = requirePositiveFiniteInteger(
      deps.maxTimerDelayMs ?? DEFAULT_MAX_TIMER_DELAY_MS,
      "maxTimerDelayMs",
    );
  }

  async create(
    request: CreateSessionScheduleRequest,
  ): Promise<SessionSchedule> {
    this.requireRunning();
    const now = this.now();
    const sessionId = requireNonEmpty(request.sessionId, "sessionId");
    const name = requireScheduleName(request.name);
    this.deps.validateTrigger(request.trigger, now);
    const turn = await this.deps.validateScheduleTurn(sessionId, request.turn);
    const id = requireNonEmpty(this.deps.createScheduleId(), "scheduleId");
    const timestamp = now.toISOString();
    const created = this.deps.storage.create({
      id,
      sessionId,
      name,
      trigger: request.trigger,
      turn,
      nextFireAt: this.deps
        .nextTriggerInstant(request.trigger, now)
        .toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp,
      state: "active",
    });
    this.notifyChanged("created", created);
    this.requestReconcileInBackground();
    return created;
  }

  list(sessionId?: string): SessionScheduleProjection[] {
    this.requireRunning();
    return this.deps.storage.list(
      sessionId === undefined
        ? undefined
        : requireNonEmpty(sessionId, "sessionId"),
    );
  }

  get(sessionId: string, scheduleId: string): SessionSchedule {
    this.requireRunning();
    return this.requireOwnedSchedule(sessionId, scheduleId);
  }

  async update(
    request: UpdateSessionScheduleRequest,
  ): Promise<SessionSchedule> {
    this.requireRunning();
    const current = this.requireOwnedSchedule(
      request.sessionId,
      request.scheduleId,
    );
    requireExpectedRevision(request.expectedRevision, current);
    const now = this.now();
    const name = requireScheduleName(request.name);
    this.deps.validateTrigger(request.trigger, now);
    const turn = await this.deps.validateScheduleTurn(
      current.sessionId,
      request.turn,
    );
    const updated = this.deps.storage.update({
      id: current.id,
      expectedRevision: request.expectedRevision,
      name,
      trigger: request.trigger,
      turn,
      nextFireAt: this.deps
        .nextTriggerInstant(request.trigger, now)
        .toISOString(),
      updatedAt: now.toISOString(),
    });
    this.notifyChanged("updated", updated);
    this.requestReconcileInBackground();
    return updated;
  }

  async pause(
    request: SessionScheduleMutationRequest,
  ): Promise<SessionSchedule> {
    this.requireRunning();
    const current = this.requireOwnedSchedule(
      request.sessionId,
      request.scheduleId,
    );
    requireExpectedRevision(request.expectedRevision, current);
    const paused = this.deps.storage.setScheduleState({
      id: current.id,
      expectedRevision: request.expectedRevision,
      state: "paused",
      nextFireAt: null,
      updatedAt: this.now().toISOString(),
    });
    this.notifyChanged("paused", paused);
    this.requestReconcileInBackground();
    return paused;
  }

  async resume(
    request: SessionScheduleMutationRequest,
  ): Promise<SessionSchedule> {
    this.requireRunning();
    const current = this.requireOwnedSchedule(
      request.sessionId,
      request.scheduleId,
    );
    requireExpectedRevision(request.expectedRevision, current);
    const now = this.now();
    const resumed = this.deps.storage.setScheduleState({
      id: current.id,
      expectedRevision: request.expectedRevision,
      state: "active",
      // Paused occurrences are not missed fires. Resume starts strictly after now.
      nextFireAt: this.deps
        .nextTriggerInstant(current.trigger, now)
        .toISOString(),
      updatedAt: now.toISOString(),
    });
    this.notifyChanged("resumed", resumed);
    this.requestReconcileInBackground();
    return resumed;
  }

  async delete(request: SessionScheduleMutationRequest): Promise<void> {
    this.requireRunning();
    const current = this.requireOwnedSchedule(
      request.sessionId,
      request.scheduleId,
    );
    requireExpectedRevision(request.expectedRevision, current);
    this.deps.storage.deleteSchedule({
      id: current.id,
      expectedRevision: request.expectedRevision,
      updatedAt: this.now().toISOString(),
    });
    this.deps.onChanged?.({
      kind: "deleted",
      sessionId: current.sessionId,
      scheduleId: current.id,
    });
    this.requestReconcileInBackground();
  }

  async start(): Promise<void> {
    if (this.started && !this.stopped) return;
    if (this.stopped) {
      throw new Error(
        "Session schedule service cannot be restarted after shutdown.",
      );
    }
    this.started = true;
    await this.requestReconcile();
  }

  async schedulesChanged(): Promise<void> {
    this.requireRunning();
    await this.requestReconcile();
  }

  async runNow(
    sessionId: string,
    scheduleId: string,
    requestId: string,
  ): Promise<SessionScheduleFireClaim> {
    this.requireRunning();
    const current = this.requireOwnedSchedule(sessionId, scheduleId);
    const normalizedRequestId = requireNonEmpty(requestId, "requestId");
    const claimedAt = this.now().toISOString();
    const identity = deriveFireIdentity(
      current,
      claimedAt,
      "run_now",
      normalizedRequestId,
    );
    const claim = this.deps.storage.claimRunNowFire({
      scheduleId: current.id,
      requestId: normalizedRequestId,
      logicalFireAt: claimedAt,
      fireId: identity.fireId,
      idempotencyKey: identity.idempotencyKey,
      claimedAt,
    });
    await this.requestDrain();
    await this.requestReconcile();
    return claim;
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearArmedTimer();
    await this.reconciliation;
    await this.drain;
    this.clearArmedTimer();
  }

  private requestReconcile(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.clearArmedTimer();
    if (this.reconciliation) {
      this.requestedWhileRunning = true;
      return this.reconciliation;
    }
    const reconciliation = this.reconcileLoop()
      .catch((error) => {
        this.deps.onBackgroundError?.(error);
        if (!this.stopped) this.armRetryTimer();
        throw error;
      })
      .finally(() => {
        if (this.reconciliation === reconciliation) {
          this.reconciliation = null;
        }
      });
    this.reconciliation = reconciliation;
    return reconciliation;
  }

  private requestReconcileInBackground(): void {
    void this.requestReconcile().catch(() => undefined);
  }

  private async reconcileLoop(): Promise<void> {
    do {
      this.requestedWhileRunning = false;
      await this.reconcileOnce();
    } while (!this.stopped && this.requestedWhileRunning);
  }

  private async reconcileOnce(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    for (const schedule of this.deps.storage.listActiveSchedules()) {
      const due = this.deps.resolveDueOccurrence(schedule, now);
      if (!due) continue;
      const identity = deriveFireIdentity(
        schedule,
        due.logicalFireAt,
        "scheduled",
      );
      this.deps.storage.claimScheduledFire({
        scheduleId: schedule.id,
        expectedRevision: schedule.revision,
        expectedNextFireAt: requireNonEmpty(
          schedule.nextFireAt ?? "",
          "nextFireAt",
        ),
        logicalFireAt: due.logicalFireAt,
        nextFireAt: due.nextFireAt,
        fireId: identity.fireId,
        idempotencyKey: identity.idempotencyKey,
        claimedAt: now.toISOString(),
      });
    }
    if (this.stopped) return;
    // Re-arm from durable schedule state before touching the external enqueue
    // boundary. A slow provider/application response must not block later claims.
    this.armNextTimer(false);
    void this.requestDrain().catch((error) =>
      this.deps.onBackgroundError?.(error),
    );
  }

  private requestDrain(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.drain) {
      this.drainRequestedWhileRunning = true;
      return this.drain;
    }
    const drain = this.drainLoop().finally(() => {
      if (this.drain === drain) this.drain = null;
    });
    this.drain = drain;
    return drain;
  }

  private async drainLoop(): Promise<void> {
    let pendingAmbiguity = false;
    do {
      this.drainRequestedWhileRunning = false;
      const claims = deduplicateClaims(
        this.deps.storage.listPendingFireClaims(this.now().toISOString()),
      );
      for (const claim of claims) this.notifyFireChanged(claim);
      const outcomes = await Promise.all(
        claims.map((claim) => this.processClaim(claim)),
      );
      pendingAmbiguity = outcomes.some((outcome) => outcome === "pending");
      for (const claim of claims) this.notifyFireChanged(claim);
    } while (!this.stopped && this.drainRequestedWhileRunning);
    if (!this.stopped) this.armNextTimer(pendingAmbiguity);
  }

  private async processClaim(
    claim: SessionScheduleFireClaim,
  ): Promise<"settled" | "pending"> {
    requireClaimIdentity(claim);
    let enqueue: SessionScheduleEnqueueResult;
    try {
      enqueue = await this.deps.enqueueTurn({
        sessionId: claim.sessionId,
        turn: claim.turnSnapshot as SessionScheduleTurn,
        idempotencyKey: claim.enqueueIdempotencyKey,
      });
    } catch {
      // The execution may already have been accepted. Retrying the same
      // idempotency key is the only safe way to resolve response loss.
      return "pending";
    }

    if (!enqueue.ok) {
      try {
        this.deps.storage.settleFireFailed({
          fireId: claim.id,
          errorCode: enqueue.errorCode,
          reason: enqueue.reason,
          settledAt: this.now().toISOString(),
          pauseSchedule: enqueue.pauseSchedule,
        });
      } catch {
        return "pending";
      }
      return "settled";
    }

    try {
      this.deps.storage.settleFireEnqueued({
        fireId: claim.id,
        executionId: requireNonEmpty(enqueue.executionId, "executionId"),
        settledAt: this.now().toISOString(),
        completeOnce:
          claim.kind === "scheduled" && claim.triggerKind === "once",
      });
    } catch {
      return "pending";
    }
    return "settled";
  }

  private armNextTimer(pendingAmbiguity: boolean): void {
    this.clearArmedTimer();
    const nowMs = this.now().getTime();
    let delayMs = pendingAmbiguity
      ? this.pendingRetryDelayMs
      : Number.POSITIVE_INFINITY;
    for (const schedule of this.deps.storage.listActiveSchedules()) {
      if (!schedule.nextFireAt) continue;
      const instantMs = Date.parse(schedule.nextFireAt);
      if (!Number.isFinite(instantMs)) {
        throw new TypeError(`Schedule nextFireAt is invalid: ${schedule.id}`);
      }
      delayMs = Math.min(delayMs, Math.max(0, instantMs - nowMs));
    }
    if (!Number.isFinite(delayMs)) return;
    const boundedDelay = Math.min(delayMs, this.maxTimerDelayMs);
    this.installTimer(boundedDelay);
  }

  private armRetryTimer(): void {
    this.clearArmedTimer();
    this.installTimer(Math.min(this.pendingRetryDelayMs, this.maxTimerDelayMs));
  }

  private installTimer(delayMs: number): void {
    const handle = this.setTimer(() => {
      if (this.timer !== handle) return;
      this.timer = null;
      void this.requestReconcile().catch(() => undefined);
    }, delayMs);
    handle.unref?.();
    this.timer = handle;
  }

  private clearArmedTimer(): void {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private requireRunning(): void {
    if (!this.started || this.stopped) {
      throw new Error("Session schedule service is not running.");
    }
  }

  private requireOwnedSchedule(
    sessionId: string,
    scheduleId: string,
  ): SessionSchedule {
    const normalizedSessionId = requireNonEmpty(sessionId, "sessionId");
    const normalizedScheduleId = requireNonEmpty(scheduleId, "scheduleId");
    const schedule = this.deps.storage.get(normalizedScheduleId);
    if (!schedule) throw new SessionScheduleNotFoundError(normalizedScheduleId);
    if (schedule.sessionId !== normalizedSessionId) {
      throw new SessionScheduleOwnerMismatchError(
        normalizedSessionId,
        normalizedScheduleId,
      );
    }
    return schedule;
  }

  private notifyChanged(
    kind: Exclude<SessionScheduleChangedEvent["kind"], "deleted" | "fired">,
    schedule: Pick<SessionSchedule, "id" | "sessionId">,
  ): void {
    this.deps.onChanged?.({
      kind,
      sessionId: schedule.sessionId,
      scheduleId: schedule.id,
    });
  }

  private notifyFireChanged(claim: SessionScheduleFireClaim): void {
    this.deps.onChanged?.({
      kind: "fired",
      sessionId: claim.sessionId,
      scheduleId: claim.scheduleId,
    });
  }

  private now(): Date {
    const now = this.deps.now?.() ?? new Date();
    if (!Number.isFinite(now.getTime())) {
      throw new TypeError("Session schedule clock returned an invalid date.");
    }
    return new Date(now.getTime());
  }

  private setTimer(
    callback: () => void,
    delayMs: number,
  ): SessionScheduleTimerHandle {
    if (this.deps.setTimer) return this.deps.setTimer(callback, delayMs);
    return setTimeout(callback, delayMs);
  }

  private clearTimer(handle: SessionScheduleTimerHandle): void {
    if (this.deps.clearTimer) {
      this.deps.clearTimer(handle);
      return;
    }
    clearTimeout(handle as NodeJS.Timeout);
  }
}

function deduplicateClaims(
  claims: SessionScheduleFireClaim[],
): SessionScheduleFireClaim[] {
  const byId = new Map<string, SessionScheduleFireClaim>();
  for (const claim of claims) byId.set(claim.id, claim);
  return [...byId.values()];
}

function requireClaimIdentity(claim: SessionScheduleFireClaim): void {
  requireNonEmpty(claim.id, "fireId");
  requireNonEmpty(claim.scheduleId, "scheduleId");
  requireNonEmpty(claim.sessionId, "sessionId");
  requireNonEmpty(claim.enqueueIdempotencyKey, "enqueueIdempotencyKey");
}

function deriveFireIdentity(
  schedule: Pick<SessionSchedule, "id" | "revision">,
  logicalFireAt: string,
  kind: "scheduled" | "run_now",
  requestId = "",
): { fireId: string; idempotencyKey: string } {
  const payload =
    kind === "run_now"
      ? ["session-schedule-fire-v1", kind, schedule.id, requestId].join("\0")
      : [
          "session-schedule-fire-v1",
          kind,
          schedule.id,
          schedule.revision,
          logicalFireAt,
        ].join("\0");
  const digest = createHash("sha256").update(payload, "utf8").digest("hex");
  return {
    fireId: `schedule-fire-${digest}`,
    idempotencyKey: `schedule-enqueue-${digest}`,
  };
}

function requireScheduleName(value: string): string {
  const normalized = requireNonEmpty(value, "name");
  if (normalized.length > 120)
    throw new TypeError("Schedule name must be at most 120 characters.");
  return normalized;
}

function requireExpectedRevision(
  expectedRevision: number,
  current: SessionSchedule,
): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new TypeError("expectedRevision must be a positive integer.");
  }
  if (expectedRevision !== current.revision) {
    throw new SessionScheduleRevisionConflictError(
      expectedRevision,
      current.revision,
    );
  }
}

function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} is required.`);
  return normalized;
}

function requirePositiveFiniteInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

import { createHash, randomUUID } from "node:crypto";

import type { SessionExecutionStorageRecord } from "../src/session-execution.js";
import { projectSessionExecution } from "../src/session-external-runtime-contract.js";
import {
  TERMINAL_FAILURE_NOTIFICATION_CONTRACT_VERSION,
  parseSessionExecutionTurnRequest,
  type SessionExecutionTerminalFailureNotification,
} from "./session-execution-turn-request.js";
import type { SessionExecutionStorageV6 } from "./session-execution-storage-v6.js";
import { projectTerminalFailureNotificationPrompt } from "./session-terminal-failure-notification-prompt.js";
import type {
  SessionTerminalFailureNotificationDelivery,
  SessionTerminalFailureNotificationStorageV6,
} from "./session-terminal-failure-notification-storage-v6.js";

export type SessionTerminalFailureNotificationEnqueueResult =
  | { ok: true; executionId: string }
  | { ok: false; errorCode: string; retryable: boolean };

export type SessionTerminalFailureNotificationTimerHandle = { unref?(): void };

export type SessionTerminalFailureNotificationServiceDeps = {
  storage: Pick<
    SessionTerminalFailureNotificationStorageV6,
    | "claimNextDue"
    | "createPending"
    | "failExpired"
    | "getBySourceExecutionId"
    | "nextPendingAttemptAt"
    | "releaseClaimsForStartup"
    | "releaseForRetry"
    | "settleEnqueued"
    | "settleFailed"
  >;
  executionStorage: Pick<
    SessionExecutionStorageV6,
    "get" | "listTerminalFailureNotificationCandidates"
  >;
  enqueueTurn(input: {
    targetSessionId: string;
    initiator: SessionExecutionTerminalFailureNotification["sourceSession"];
    prompt: string;
    idempotencyKey: string;
  }): Promise<SessionTerminalFailureNotificationEnqueueResult>;
  now?(): Date;
  setTimer?(callback: () => void, delayMs: number): SessionTerminalFailureNotificationTimerHandle;
  clearTimer?(handle: SessionTerminalFailureNotificationTimerHandle): void;
  onDeliveryChanged?(sourceExecutionId: string): void;
  onBackgroundError?(error: unknown): void;
};

const RETRY_DEADLINE_MS = 24 * 60 * 60 * 1000;
const RETRY_INITIAL_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 5 * 60 * 1000;
const RECONCILIATION_BATCH_SIZE = 100;

type ClaimReleaseRecovery = {
  sourceExecutionId: string;
  deliveryId: string;
  claimToken: string;
  nextAttemptAt: string;
  releasedAt: string;
};

export class SessionTerminalFailureNotificationService {
  private started = false;
  private stopped = false;
  private work: Promise<void> | null = null;
  private workRequested = false;
  private timer: SessionTerminalFailureNotificationTimerHandle | null = null;
  private retryAfterFailure = false;
  private startupClaimsReleased = false;
  private startupReconciliationPending = true;
  private readonly wakeExecutionIds = new Set<string>();
  private readonly claimReleaseRecoveries = new Map<string, ClaimReleaseRecovery>();

  constructor(private readonly deps: SessionTerminalFailureNotificationServiceDeps) {}

  async start(): Promise<void> {
    if (this.started && !this.stopped) return;
    if (this.stopped) throw new Error("Terminal failure notification service cannot restart after shutdown.");
    this.started = true;
    await this.requestWork();
  }

  wake(sourceExecutionId?: string): void {
    if (!this.started || this.stopped) return;
    if (sourceExecutionId?.trim()) this.wakeExecutionIds.add(sourceExecutionId);
    void this.requestWork().catch((error) => this.reportBackgroundError(error));
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearArmedTimer();
    await this.work;
    this.clearArmedTimer();
  }

  private requestWork(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.clearArmedTimer();
    if (this.work) {
      this.workRequested = true;
      return this.work;
    }
    const work = this.workLoop()
      .catch((error) => {
        this.retryAfterFailure = true;
        this.reportBackgroundError(error);
      })
      .finally(() => {
        if (this.work === work) this.work = null;
        if (!this.stopped) this.armNextTimer();
      });
    this.work = work;
    return work;
  }

  private async workLoop(): Promise<void> {
    if (!this.startupClaimsReleased) {
      this.deps.storage.releaseClaimsForStartup(this.now().toISOString());
      this.startupClaimsReleased = true;
    }
    do {
      this.workRequested = false;
      this.recoverClaimReleases();
      this.reconcileWokenExecutions();
      this.reconcileStartupBatch();
      this.failExpired();
      await this.drainDue();
      if (this.startupReconciliationPending || this.wakeExecutionIds.size > 0) {
        this.workRequested = true;
        await yieldToEventLoop();
      }
    } while (!this.stopped && this.workRequested);
    this.retryAfterFailure = false;
  }

  private reconcileWokenExecutions(): void {
    const executionIds = Array.from(this.wakeExecutionIds).slice(0, RECONCILIATION_BATCH_SIZE);
    for (const executionId of executionIds) {
      const execution = this.deps.executionStorage.get(executionId);
      if (execution) this.reconcileExecution(execution, false);
      this.wakeExecutionIds.delete(executionId);
    }
  }

  private reconcileStartupBatch(): void {
    if (!this.startupReconciliationPending) return;
    const executions = this.deps.executionStorage.listTerminalFailureNotificationCandidates(
      RECONCILIATION_BATCH_SIZE,
    );
    for (const execution of executions) this.reconcileExecution(execution, true);
    this.startupReconciliationPending = executions.length === RECONCILIATION_BATCH_SIZE;
  }

  private reconcileExecution(
    execution: SessionExecutionStorageRecord,
    deliveryKnownMissing: boolean,
  ): void {
    if (execution.state !== "failed" && execution.state !== "interrupted") return;
    if (!deliveryKnownMissing && this.deps.storage.getBySourceExecutionId(execution.id)) return;
    const inspected = inspectNotification(execution.request);
    if (!inspected.targetSessionId) return;
    const terminalAt = execution.completedAt ?? execution.updatedAt;
    const identity = deriveDeliveryIdentity({
      sourceExecutionId: execution.id,
      terminalState: execution.state,
      targetSessionId: inspected.targetSessionId,
    });
    const delivery = this.deps.storage.createPending({
      ...identity,
      sourceExecutionId: execution.id,
      sourceSessionId: execution.sessionId,
      terminalState: execution.state,
      targetSessionId: inspected.targetSessionId,
      contractVersion: TERMINAL_FAILURE_NOTIFICATION_CONTRACT_VERSION,
      createdAt: terminalAt,
      deadlineAt: new Date(parseTimestamp(terminalAt) + RETRY_DEADLINE_MS).toISOString(),
    });
    this.notifyChanged(execution.id);
    if (!inspected.notification || inspected.notification.sourceSession.sessionId !== execution.sessionId) {
      this.deps.storage.settleFailed({
        deliveryId: delivery.id,
        claimToken: null,
        errorCode: "SENDER_SNAPSHOT_INVALID",
        errorMessage: "The saved source Session sender snapshot is invalid.",
        settledAt: this.now().toISOString(),
      });
      this.notifyChanged(execution.id);
    }
  }

  private failExpired(): void {
    for (const delivery of this.deps.storage.failExpired(this.now().toISOString())) {
      this.notifyChanged(delivery.sourceExecutionId);
    }
  }

  private async drainDue(): Promise<void> {
    while (!this.stopped) {
      const now = this.now().toISOString();
      const delivery = this.deps.storage.claimNextDue({
        now,
        claimToken: `terminal-notification-claim-${randomUUID()}`,
      });
      if (!delivery) return;
      await this.processClaim(delivery);
    }
  }

  private async processClaim(delivery: SessionTerminalFailureNotificationDelivery): Promise<void> {
    const claimToken = requireNonEmpty(delivery.claimToken, "claimToken");
    const source = this.deps.executionStorage.get(delivery.sourceExecutionId);
    if (!source || source.sessionId !== delivery.sourceSessionId || source.state !== delivery.terminalState) {
      this.settlePermanent(delivery, claimToken, "SOURCE_EXECUTION_INVALID");
      return;
    }
    const inspected = inspectNotification(source.request);
    if (
      !inspected.notification
      || inspected.notification.targetSessionId !== delivery.targetSessionId
      || inspected.notification.sourceSession.sessionId !== source.sessionId
    ) {
      this.settlePermanent(delivery, claimToken, "SENDER_SNAPSHOT_INVALID");
      return;
    }

    const publicSource = projectSessionExecution(source);
    const prompt = projectTerminalFailureNotificationPrompt({
      sourceSessionId: source.sessionId,
      sourceExecution: publicSource,
    });
    let result: SessionTerminalFailureNotificationEnqueueResult;
    try {
      result = await this.deps.enqueueTurn({
        targetSessionId: delivery.targetSessionId,
        initiator: inspected.notification.sourceSession,
        prompt,
        idempotencyKey: delivery.enqueueIdempotencyKey,
      });
    } catch {
      this.releaseRetry(delivery, claimToken);
      return;
    }
    if (!result.ok) {
      if (result.retryable && !isPermanentErrorCode(result.errorCode)) {
        this.releaseRetry(delivery, claimToken);
      } else {
        this.settlePermanent(delivery, claimToken, safePermanentErrorCode(result.errorCode));
      }
      return;
    }
    try {
      this.deps.storage.settleEnqueued({
        deliveryId: delivery.id,
        claimToken,
        notificationExecutionId: requireNonEmpty(result.executionId, "notificationExecutionId"),
        settledAt: this.now().toISOString(),
      });
      this.notifyChanged(delivery.sourceExecutionId);
    } catch (error) {
      this.reportBackgroundError(error);
      this.releaseRetry(delivery, claimToken);
    }
  }

  private releaseRetry(delivery: SessionTerminalFailureNotificationDelivery, claimToken: string): void {
    const releasedAt = this.now();
    const delayMs = Math.min(
      RETRY_INITIAL_DELAY_MS * (2 ** Math.max(0, delivery.attemptCount - 1)),
      RETRY_MAX_DELAY_MS,
    );
    const nextAttemptAt = new Date(Math.min(
      releasedAt.getTime() + delayMs,
      parseTimestamp(delivery.deadlineAt),
    )).toISOString();
    const recovery: ClaimReleaseRecovery = {
      sourceExecutionId: delivery.sourceExecutionId,
      deliveryId: delivery.id,
      claimToken,
      nextAttemptAt,
      releasedAt: releasedAt.toISOString(),
    };
    this.claimReleaseRecoveries.set(delivery.id, recovery);
    try {
      this.deps.storage.releaseForRetry(recovery);
      this.claimReleaseRecoveries.delete(delivery.id);
      this.notifyChanged(delivery.sourceExecutionId);
    } catch (error) {
      this.reportBackgroundError(error);
      throw error;
    }
  }

  private recoverClaimReleases(): void {
    for (const [deliveryId, recovery] of this.claimReleaseRecoveries) {
      const current = this.deps.storage.getBySourceExecutionId(recovery.sourceExecutionId);
      if (
        !current
        || current.state !== "pending"
        || current.claimToken !== recovery.claimToken
      ) {
        this.claimReleaseRecoveries.delete(deliveryId);
        if (current) this.notifyChanged(current.sourceExecutionId);
        continue;
      }
      this.deps.storage.releaseForRetry(recovery);
      this.claimReleaseRecoveries.delete(deliveryId);
      this.notifyChanged(recovery.sourceExecutionId);
    }
  }

  private settlePermanent(
    delivery: SessionTerminalFailureNotificationDelivery,
    claimToken: string,
    errorCode: string,
  ): void {
    this.deps.storage.settleFailed({
      deliveryId: delivery.id,
      claimToken,
      errorCode,
      errorMessage: "The terminal failure notification could not be delivered.",
      settledAt: this.now().toISOString(),
    });
    this.notifyChanged(delivery.sourceExecutionId);
  }

  private armNextTimer(): void {
    this.clearArmedTimer();
    let delayMs: number;
    if (this.retryAfterFailure) {
      delayMs = RETRY_INITIAL_DELAY_MS;
    } else {
      let nextAttemptAt: string | null;
      try {
        nextAttemptAt = this.deps.storage.nextPendingAttemptAt();
      } catch (error) {
        this.retryAfterFailure = true;
        this.reportBackgroundError(error);
        nextAttemptAt = null;
      }
      if (!nextAttemptAt && !this.retryAfterFailure) return;
      delayMs = nextAttemptAt
        ? Math.max(0, parseTimestamp(nextAttemptAt) - this.now().getTime())
        : RETRY_INITIAL_DELAY_MS;
    }
    const handle = this.setTimer(() => {
      if (this.timer !== handle) return;
      this.timer = null;
      void this.requestWork().catch((error) => this.reportBackgroundError(error));
    }, Math.min(delayMs, RETRY_MAX_DELAY_MS));
    handle.unref?.();
    this.timer = handle;
  }

  private clearArmedTimer(): void {
    if (!this.timer) return;
    if (this.deps.clearTimer) this.deps.clearTimer(this.timer);
    else clearTimeout(this.timer as NodeJS.Timeout);
    this.timer = null;
  }

  private setTimer(callback: () => void, delayMs: number): SessionTerminalFailureNotificationTimerHandle {
    return this.deps.setTimer?.(callback, delayMs) ?? setTimeout(callback, delayMs);
  }

  private now(): Date {
    const value = this.deps.now?.() ?? new Date();
    if (!Number.isFinite(value.getTime())) throw new TypeError("Terminal failure notification clock is invalid.");
    return new Date(value.getTime());
  }

  private notifyChanged(sourceExecutionId: string): void {
    try {
      this.deps.onDeliveryChanged?.(sourceExecutionId);
    } catch {
      // Projection refresh is an observer and does not own delivery settlement.
    }
  }

  private reportBackgroundError(error: unknown): void {
    try {
      this.deps.onBackgroundError?.(error);
    } catch {
      // Logging is an observer and does not own retry scheduling or settlement.
    }
  }
}

function inspectNotification(request: unknown): {
  targetSessionId: string | null;
  notification: SessionExecutionTerminalFailureNotification | null;
} {
  const raw = request && typeof request === "object" && !Array.isArray(request)
    ? (request as Record<string, unknown>).terminalFailureNotification
    : null;
  const rawTarget = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).targetSessionId
    : null;
  const targetSessionId = typeof rawTarget === "string" && rawTarget.trim() ? rawTarget : null;
  if (!targetSessionId) return { targetSessionId: null, notification: null };
  try {
    return {
      targetSessionId,
      notification: parseSessionExecutionTurnRequest(request).terminalFailureNotification,
    };
  } catch {
    return { targetSessionId, notification: null };
  }
}

export function deriveDeliveryIdentity(input: {
  sourceExecutionId: string;
  terminalState: "failed" | "interrupted";
  targetSessionId: string;
}): { id: string; enqueueIdempotencyKey: string } {
  const digest = createHash("sha256").update([
    "session-terminal-failure-notification-v1",
    input.sourceExecutionId,
    input.terminalState,
    input.targetSessionId,
    TERMINAL_FAILURE_NOTIFICATION_CONTRACT_VERSION,
  ].join("\0"), "utf8").digest("hex");
  return {
    id: `terminal-failure-notification-${digest}`,
    enqueueIdempotencyKey: `terminal-failure-notification-enqueue-${digest}`,
  };
}

function isPermanentErrorCode(code: string): boolean {
  return [
    "SESSION_NOT_FOUND",
    "SESSION_KIND_UNSUPPORTED",
    "EXECUTION_OWNER_MISMATCH",
    "SESSION_INITIATOR_UNAVAILABLE",
    "INVALID_INPUT",
    "SENDER_SNAPSHOT_INVALID",
  ].includes(code);
}

function safePermanentErrorCode(code: string): string {
  return isPermanentErrorCode(code) ? code : "DELIVERY_REJECTED";
}

function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError("Terminal failure notification timestamp is invalid.");
  return timestamp;
}

function requireNonEmpty(value: string | null, name: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new TypeError(`${name} is required.`);
  return normalized;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

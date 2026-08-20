import type { DatabaseSync } from "node:sqlite";

import type { TerminalFailureNotificationDeliveryState } from "../src/session-terminal-failure-notification.js";
import { ensureV6Schema } from "./database-schema-v6.js";
import { openAppDatabase } from "./sqlite-connection.js";

type DeliveryRow = {
  id: string;
  source_execution_id: string;
  source_session_id: string;
  terminal_state: "failed" | "interrupted";
  target_session_id: string;
  contract_version: number;
  state: TerminalFailureNotificationDeliveryState;
  enqueue_idempotency_key: string;
  notification_execution_id: string | null;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
  last_attempt_at: string | null;
  next_attempt_at: string;
  deadline_at: string;
  claim_token: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SessionTerminalFailureNotificationDelivery = {
  id: string;
  sourceExecutionId: string;
  sourceSessionId: string;
  terminalState: "failed" | "interrupted";
  targetSessionId: string;
  contractVersion: number;
  state: TerminalFailureNotificationDeliveryState;
  enqueueIdempotencyKey: string;
  notificationExecutionId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string;
  deadlineAt: string;
  claimToken: string | null;
  claimedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export class SessionTerminalFailureNotificationStorageV6 {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    ensureV6Schema(this.db);
  }

  createPending(input: {
    id: string;
    sourceExecutionId: string;
    sourceSessionId: string;
    terminalState: "failed" | "interrupted";
    targetSessionId: string;
    contractVersion: number;
    enqueueIdempotencyKey: string;
    createdAt: string;
    deadlineAt: string;
  }): SessionTerminalFailureNotificationDelivery {
    this.db.prepare(`
      INSERT INTO session_terminal_failure_notification_deliveries_v6 (
        id, source_execution_id, source_session_id, terminal_state, target_session_id,
        contract_version, state, enqueue_idempotency_key, next_attempt_at, deadline_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
      ON CONFLICT(source_execution_id) DO NOTHING
    `).run(
      input.id,
      input.sourceExecutionId,
      input.sourceSessionId,
      input.terminalState,
      input.targetSessionId,
      input.contractVersion,
      input.enqueueIdempotencyKey,
      input.createdAt,
      input.deadlineAt,
      input.createdAt,
      input.createdAt,
    );
    const delivery = this.getBySourceExecutionId(input.sourceExecutionId);
    if (!delivery) throw new Error("Terminal failure notification delivery was not created.");
    if (
      delivery.id !== input.id
      || delivery.sourceSessionId !== input.sourceSessionId
      || delivery.terminalState !== input.terminalState
      || delivery.targetSessionId !== input.targetSessionId
      || delivery.contractVersion !== input.contractVersion
      || delivery.enqueueIdempotencyKey !== input.enqueueIdempotencyKey
    ) {
      throw new Error("Terminal failure notification delivery identity conflict.");
    }
    return delivery;
  }

  getBySourceExecutionId(sourceExecutionId: string): SessionTerminalFailureNotificationDelivery | null {
    const row = this.db.prepare(`
      SELECT * FROM session_terminal_failure_notification_deliveries_v6
      WHERE source_execution_id = ?
    `).get(sourceExecutionId) as DeliveryRow | undefined;
    return row ? parseDelivery(row) : null;
  }

  releaseClaimsForStartup(releasedAt: string): number {
    const result = this.db.prepare(`
      UPDATE session_terminal_failure_notification_deliveries_v6
      SET claim_token = NULL,
          claimed_at = NULL,
          next_attempt_at = CASE WHEN next_attempt_at > ? THEN ? ELSE next_attempt_at END,
          updated_at = ?
      WHERE state = 'pending' AND claim_token IS NOT NULL
    `).run(releasedAt, releasedAt, releasedAt);
    return Number(result.changes);
  }

  failExpired(expiredAt: string): SessionTerminalFailureNotificationDelivery[] {
    const ids = (this.db.prepare(`
      SELECT id FROM session_terminal_failure_notification_deliveries_v6
      WHERE state = 'pending' AND deadline_at <= ?
      ORDER BY deadline_at ASC, id ASC
    `).all(expiredAt) as Array<{ id: string }>).map((row) => row.id);
    if (ids.length === 0) return [];
    this.db.prepare(`
      UPDATE session_terminal_failure_notification_deliveries_v6
      SET state = 'failed', error_code = 'DELIVERY_DEADLINE_EXPIRED',
          error_message = 'The terminal failure notification retry deadline expired.',
          claim_token = NULL, claimed_at = NULL, updated_at = ?
      WHERE state = 'pending' AND deadline_at <= ?
    `).run(expiredAt, expiredAt);
    return ids.map((id) => this.getRequired(id));
  }

  claimNextDue(input: {
    now: string;
    claimToken: string;
  }): SessionTerminalFailureNotificationDelivery | null {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT id FROM session_terminal_failure_notification_deliveries_v6
        WHERE state = 'pending'
          AND claim_token IS NULL
          AND next_attempt_at <= ?
          AND deadline_at > ?
        ORDER BY next_attempt_at ASC, created_at ASC, id ASC
        LIMIT 1
      `).get(input.now, input.now) as { id: string } | undefined;
      if (!row) return null;
      const updated = this.db.prepare(`
        UPDATE session_terminal_failure_notification_deliveries_v6
        SET claim_token = ?, claimed_at = ?, attempt_count = attempt_count + 1,
            last_attempt_at = ?, updated_at = ?
        WHERE id = ? AND state = 'pending' AND claim_token IS NULL
      `).run(input.claimToken, input.now, input.now, input.now, row.id);
      return updated.changes === 1 ? this.getRequired(row.id) : null;
    });
  }

  settleEnqueued(input: {
    deliveryId: string;
    claimToken: string;
    notificationExecutionId: string;
    settledAt: string;
  }): SessionTerminalFailureNotificationDelivery {
    const updated = this.db.prepare(`
      UPDATE session_terminal_failure_notification_deliveries_v6
      SET state = 'enqueued', notification_execution_id = ?,
          claim_token = NULL, claimed_at = NULL, updated_at = ?
      WHERE id = ? AND state = 'pending' AND claim_token = ?
    `).run(input.notificationExecutionId, input.settledAt, input.deliveryId, input.claimToken);
    if (updated.changes !== 1) throw new Error("Terminal failure notification enqueue settlement conflict.");
    return this.getRequired(input.deliveryId);
  }

  settleFailed(input: {
    deliveryId: string;
    claimToken: string | null;
    errorCode: string;
    errorMessage: string;
    settledAt: string;
  }): SessionTerminalFailureNotificationDelivery {
    const updated = input.claimToken === null
      ? this.db.prepare(`
          UPDATE session_terminal_failure_notification_deliveries_v6
          SET state = 'failed', error_code = ?, error_message = ?,
              claim_token = NULL, claimed_at = NULL, updated_at = ?
          WHERE id = ? AND state = 'pending'
        `).run(input.errorCode, input.errorMessage, input.settledAt, input.deliveryId)
      : this.db.prepare(`
          UPDATE session_terminal_failure_notification_deliveries_v6
          SET state = 'failed', error_code = ?, error_message = ?,
              claim_token = NULL, claimed_at = NULL, updated_at = ?
          WHERE id = ? AND state = 'pending' AND claim_token = ?
        `).run(input.errorCode, input.errorMessage, input.settledAt, input.deliveryId, input.claimToken);
    if (updated.changes !== 1) throw new Error("Terminal failure notification failure settlement conflict.");
    return this.getRequired(input.deliveryId);
  }

  releaseForRetry(input: {
    deliveryId: string;
    claimToken: string;
    nextAttemptAt: string;
    releasedAt: string;
  }): SessionTerminalFailureNotificationDelivery {
    const updated = this.db.prepare(`
      UPDATE session_terminal_failure_notification_deliveries_v6
      SET claim_token = NULL, claimed_at = NULL, next_attempt_at = ?, updated_at = ?
      WHERE id = ? AND state = 'pending' AND claim_token = ?
    `).run(input.nextAttemptAt, input.releasedAt, input.deliveryId, input.claimToken);
    if (updated.changes !== 1) throw new Error("Terminal failure notification retry release conflict.");
    return this.getRequired(input.deliveryId);
  }

  nextPendingAttemptAt(): string | null {
    const row = this.db.prepare(`
      SELECT MIN(next_attempt_at) AS next_attempt_at
      FROM session_terminal_failure_notification_deliveries_v6
      WHERE state = 'pending' AND claim_token IS NULL
    `).get() as { next_attempt_at: string | null };
    return row.next_attempt_at;
  }

  close(): void {
    this.db.close();
  }

  private getRequired(id: string): SessionTerminalFailureNotificationDelivery {
    const row = this.db.prepare(`
      SELECT * FROM session_terminal_failure_notification_deliveries_v6 WHERE id = ?
    `).get(id) as DeliveryRow | undefined;
    if (!row) throw new Error(`Terminal failure notification delivery not found: ${id}`);
    return parseDelivery(row);
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function parseDelivery(row: DeliveryRow): SessionTerminalFailureNotificationDelivery {
  return {
    id: row.id,
    sourceExecutionId: row.source_execution_id,
    sourceSessionId: row.source_session_id,
    terminalState: row.terminal_state,
    targetSessionId: row.target_session_id,
    contractVersion: row.contract_version,
    state: row.state,
    enqueueIdempotencyKey: row.enqueue_idempotency_key,
    notificationExecutionId: row.notification_execution_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at,
    nextAttemptAt: row.next_attempt_at,
    deadlineAt: row.deadline_at,
    claimToken: row.claim_token,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

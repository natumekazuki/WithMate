import type { DatabaseSync } from "node:sqlite";
import {
  parseSessionScheduleTrigger,
  type SessionSchedule,
  type SessionScheduleFire,
  type SessionScheduleFireState,
  type SessionScheduleProjection,
  type SessionScheduleState,
  type SessionScheduleTurn,
  type SessionScheduleTrigger,
} from "../src/session-schedule.js";
import { ensureV6Schema } from "./database-schema-v6.js";
import { openAppDatabase } from "./sqlite-connection.js";
import type {
  SessionScheduleFireClaim,
  SessionScheduleStorage,
} from "./session-schedule-service.js";

export class SessionScheduleConflictError extends Error {
  readonly code = "SCHEDULE_REVISION_CONFLICT";
}
export class SessionScheduleLimitError extends Error {
  readonly code = "SCHEDULE_LIMIT";
}

export type CreateSessionScheduleInput = Omit<
  SessionSchedule,
  "revision" | "state" | "nextFireAt"
> & { nextFireAt?: string | null; state?: SessionScheduleState };
export type UpdateSessionScheduleInput = {
  id: string;
  expectedRevision: number;
  name: string;
  trigger: SessionScheduleTrigger;
  turn: SessionScheduleTurn;
  nextFireAt: string | null;
  updatedAt: string;
};
export type ClaimSessionScheduleFireResult = {
  fire: SessionScheduleFire & { sessionId: string; turn: SessionScheduleTurn };
  schedule: SessionSchedule;
} | null;

type ScheduleRow = {
  id: string;
  session_id: string;
  revision: number;
  name: string;
  trigger_type: "once" | "cron";
  time_zone: string;
  cron_expression: string | null;
  once_local_datetime: string | null;
  turn_json: string;
  state: SessionScheduleState | "deleted";
  next_fire_at: string | null;
  created_at: string;
  updated_at: string;
};
type FireRow = {
  id: string;
  schedule_id: string;
  session_id: string;
  schedule_revision: number;
  trigger_type: "once" | "cron";
  logical_fire_at: string;
  kind: "scheduled" | "run_now";
  state: SessionScheduleFireState;
  idempotency_key: string;
  turn_json: string;
  execution_id: string | null;
  error_code: string | null;
  error_message: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
};

function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const v = fn();
    db.exec("COMMIT");
    return v;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw e;
  }
}
function triggerFromRow(row: ScheduleRow): SessionScheduleTrigger {
  return row.trigger_type === "once"
    ? parseSessionScheduleTrigger({
        type: "once",
        localDateTime: row.once_local_datetime,
        timeZone: row.time_zone,
      })
    : parseSessionScheduleTrigger({
        type: "cron",
        expression: row.cron_expression,
        timeZone: row.time_zone,
      });
}
function scheduleFromRow(row: ScheduleRow): SessionSchedule {
  return {
    id: row.id,
    sessionId: row.session_id,
    revision: row.revision,
    name: row.name,
    trigger: triggerFromRow(row),
    state: row.state === "deleted" ? "paused" : row.state,
    turn: JSON.parse(row.turn_json) as SessionScheduleTurn,
    nextFireAt: row.next_fire_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function fireFromRow(row: FireRow): SessionScheduleFire {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    scheduleRevision: row.schedule_revision,
    logicalFireAt: row.logical_fire_at,
    kind: row.kind,
    state: row.state,
    idempotencyKey: row.idempotency_key,
    executionId: row.execution_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SessionScheduleStorageV6 implements SessionScheduleStorage {
  private readonly db: DatabaseSync;
  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    ensureV6Schema(this.db);
  }
  close(): void {
    this.db.close();
  }
  create(input: CreateSessionScheduleInput): SessionSchedule {
    return tx(this.db, () => {
      const count = (
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM session_schedules_v6 WHERE session_id = ? AND state <> 'deleted'",
          )
          .get(input.sessionId) as { count: number }
      ).count;
      if (count >= 20)
        throw new SessionScheduleLimitError("Session schedule limit is 20.");
      const trigger = input.trigger;
      const now = input.updatedAt;
      this.db
        .prepare(
          `INSERT INTO session_schedules_v6 (id,session_id,revision,name,trigger_type,time_zone,cron_expression,once_local_datetime,turn_json,state,next_fire_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.id,
          input.sessionId,
          1,
          input.name,
          trigger.type,
          trigger.timeZone,
          trigger.type === "cron" ? trigger.expression : null,
          trigger.type === "once" ? trigger.localDateTime : null,
          JSON.stringify(input.turn),
          input.state ?? "active",
          input.nextFireAt ?? null,
          input.createdAt,
          now,
        );
      return this.get(input.id)!;
    });
  }
  get(id: string): SessionSchedule | null {
    const row = this.db
      .prepare(
        "SELECT * FROM session_schedules_v6 WHERE id = ? AND state <> 'deleted'",
      )
      .get(id) as ScheduleRow | undefined;
    return row ? scheduleFromRow(row) : null;
  }
  list(sessionId?: string): SessionScheduleProjection[] {
    const rows = (
      sessionId
        ? this.db
            .prepare(
              "SELECT * FROM session_schedules_v6 WHERE session_id = ? AND state <> 'deleted' ORDER BY updated_at DESC",
            )
            .all(sessionId)
        : this.db
            .prepare(
              "SELECT * FROM session_schedules_v6 WHERE state <> 'deleted' ORDER BY updated_at DESC",
            )
            .all()
    ) as ScheduleRow[];
    return rows.map((r) => ({
      ...scheduleFromRow(r),
      latestFire: this.latestFire(r.id),
    }));
  }
  listActiveSchedules(): SessionSchedule[] {
    return this.list().filter((s) => s.state === "active");
  }
  setScheduleState(input: {
    id: string;
    expectedRevision: number;
    state: SessionScheduleState;
    nextFireAt: string | null;
    updatedAt: string;
  }): SessionSchedule {
    return tx(this.db, () => {
      const r = this.db
        .prepare(
          "UPDATE session_schedules_v6 SET state=?,next_fire_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND state <> 'deleted'",
        )
        .run(
          input.state,
          input.nextFireAt,
          input.updatedAt,
          input.id,
          input.expectedRevision,
        );
      if (!r.changes)
        throw new SessionScheduleConflictError("Schedule revision changed.");
      return this.get(input.id)!;
    });
  }
  deleteSchedule(input: {
    id: string;
    expectedRevision: number;
    updatedAt: string;
  }): void {
    tx(this.db, () => {
      const r = this.db
        .prepare(
          "UPDATE session_schedules_v6 SET state='deleted',revision=revision+1,next_fire_at=NULL,updated_at=? WHERE id=? AND revision=?",
        )
        .run(input.updatedAt, input.id, input.expectedRevision);
      if (!r.changes)
        throw new SessionScheduleConflictError("Schedule revision changed.");
      this.purgeDeletedScheduleIfReplayed(input.id);
    });
  }
  update(input: UpdateSessionScheduleInput): SessionSchedule {
    return tx(this.db, () => {
      const current = this.db
        .prepare("SELECT revision FROM session_schedules_v6 WHERE id = ?")
        .get(input.id) as { revision: number } | undefined;
      if (!current || current.revision !== input.expectedRevision)
        throw new SessionScheduleConflictError("Schedule revision changed.");
      const t = input.trigger;
      this.db
        .prepare(
          "UPDATE session_schedules_v6 SET revision=revision+1,name=?,trigger_type=?,time_zone=?,cron_expression=?,once_local_datetime=?,turn_json=?,next_fire_at=?,updated_at=? WHERE id=? AND revision=?",
        )
        .run(
          input.name,
          t.type,
          t.timeZone,
          t.type === "cron" ? t.expression : null,
          t.type === "once" ? t.localDateTime : null,
          JSON.stringify(input.turn),
          input.nextFireAt,
          input.updatedAt,
          input.id,
          input.expectedRevision,
        );
      return this.get(input.id)!;
    });
  }
  setState(
    id: string,
    expectedRevision: number,
    state: SessionScheduleState,
    updatedAt: string,
  ): SessionSchedule {
    return tx(this.db, () => {
      const result = this.db
        .prepare(
          "UPDATE session_schedules_v6 SET state=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
        )
        .run(state, updatedAt, id, expectedRevision);
      if (!result.changes)
        throw new SessionScheduleConflictError("Schedule revision changed.");
      return this.get(id)!;
    });
  }
  delete(id: string): void {
    tx(this.db, () => {
      this.db
        .prepare(
          "UPDATE session_schedules_v6 SET state='deleted',revision=revision+1,next_fire_at=NULL,updated_at=datetime('now') WHERE id=? AND state <> 'deleted'",
        )
        .run(id);
    });
  }
  claimDueFire(
    scheduleId: string,
    expectedRevision: number,
    expectedNextFireAt: string,
    logicalFireAt: string,
    nextFireAt: string | null,
    fireId: string,
    key: string,
    now: string,
  ): ClaimSessionScheduleFireResult {
    return tx(this.db, () => {
      const row = this.db
        .prepare(
          "SELECT * FROM session_schedules_v6 WHERE id=? AND state='active' AND revision=? AND next_fire_at=?",
        )
        .get(scheduleId, expectedRevision, expectedNextFireAt) as
        ScheduleRow | undefined;
      if (!row) return null;
      this.db
        .prepare(
          "INSERT OR IGNORE INTO session_schedule_fires_v6 (id,schedule_id,session_id,schedule_revision,trigger_type,logical_fire_at,kind,state,idempotency_key,turn_json,created_at,updated_at) VALUES (?,?,?,?,?,?,'scheduled','pending',?,?,?,?)",
        )
        .run(
          fireId,
          scheduleId,
          row.session_id,
          row.revision,
          row.trigger_type,
          logicalFireAt,
          key,
          row.turn_json,
          now,
          now,
        );
      this.db
        .prepare(
          "UPDATE session_schedules_v6 SET next_fire_at=?,updated_at=? WHERE id=? AND revision=?",
        )
        .run(nextFireAt, now, scheduleId, expectedRevision);
      const fire = this.getFireByKey(key)!;
      const frow = this.db
        .prepare("SELECT * FROM session_schedule_fires_v6 WHERE id=?")
        .get(fire.id) as FireRow;
      return {
        fire: Object.assign(fire, {
          sessionId: row.session_id,
          turn: JSON.parse(frow.turn_json) as SessionScheduleTurn,
        }),
        schedule: scheduleFromRow({
          ...row,
          next_fire_at: nextFireAt,
          updated_at: now,
        }),
      };
    });
  }
  createRunNowFire(
    scheduleId: string,
    fireId: string,
    key: string,
    now: string,
  ): SessionScheduleFire {
    return tx(this.db, () => {
      const raw = this.db
        .prepare("SELECT state FROM session_schedules_v6 WHERE id=?")
        .get(scheduleId) as { state: string } | undefined;
      if (!raw || raw.state === "deleted")
        throw new Error("Schedule is deleted.");
      return this.insertFire(scheduleId, fireId, key, now, "run_now", now);
    });
  }
  createDueFire(
    scheduleId: string,
    fireId: string,
    key: string,
    logicalFireAt: string,
    now: string,
  ): SessionScheduleFire {
    return tx(this.db, () =>
      this.insertFire(scheduleId, fireId, key, logicalFireAt, "scheduled", now),
    );
  }
  private insertFire(
    scheduleId: string,
    fireId: string,
    key: string,
    logical: string,
    kind: "scheduled" | "run_now",
    now: string,
  ): SessionScheduleFire {
    const s = this.get(scheduleId);
    if (!s) throw new Error("Schedule not found.");
    this.db
      .prepare(
        "INSERT OR IGNORE INTO session_schedule_fires_v6 (id,schedule_id,session_id,schedule_revision,trigger_type,logical_fire_at,kind,state,idempotency_key,turn_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pending',?,?,?,?)",
      )
      .run(
        fireId,
        scheduleId,
        s.sessionId,
        s.revision,
        s.trigger.type,
        logical,
        kind,
        key,
        JSON.stringify(s.turn),
        now,
        now,
      );
    return this.getFireByKey(key)!;
  }
  claimPendingFire(
    fireId: string,
    claimedAt: string,
  ): ClaimSessionScheduleFireResult {
    return tx(this.db, () => {
      const row = this.db
        .prepare(
          "SELECT * FROM session_schedule_fires_v6 WHERE id=? AND state IN ('pending','claimed')",
        )
        .get(fireId) as FireRow | undefined;
      if (!row) return null;
      const scheduleRow = this.db
        .prepare("SELECT * FROM session_schedules_v6 WHERE id=?")
        .get(row.schedule_id) as ScheduleRow | undefined;
      if (!scheduleRow) return null;
      if (row.state === "pending")
        this.db
          .prepare(
            "UPDATE session_schedule_fires_v6 SET state='claimed',claimed_at=?,updated_at=? WHERE id=? AND state='pending'",
          )
          .run(claimedAt, claimedAt, fireId);
      const fire = fireFromRow({
        ...row,
        state: "claimed",
        claimed_at: row.claimed_at ?? claimedAt,
        updated_at: row.state === "pending" ? claimedAt : row.updated_at,
      });
      return {
        fire: Object.assign(fire, {
          sessionId: row.session_id,
          turn: JSON.parse(row.turn_json) as SessionScheduleTurn,
        }),
        schedule: scheduleFromRow(scheduleRow),
      };
    });
  }
  listPendingFires(): SessionScheduleFire[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM session_schedule_fires_v6 WHERE state IN ('pending','claimed') ORDER BY logical_fire_at ASC",
        )
        .all() as FireRow[]
    ).map(fireFromRow);
  }
  settleEnqueued(
    fireId: string,
    executionId: string,
    now: string,
  ): SessionScheduleFire {
    return this.settleFire(fireId, "enqueued", now, executionId, null, null);
  }
  settleFailed(
    fireId: string,
    errorCode: string,
    errorMessage: string,
    now: string,
  ): SessionScheduleFire {
    return this.settleFire(
      fireId,
      "failed",
      now,
      null,
      errorCode,
      errorMessage,
    );
  }
  settleFailedAndPause(
    fireId: string,
    errorCode: string,
    errorMessage: string,
    now: string,
  ): SessionScheduleFire {
    return tx(this.db, () => {
      const fire = this.db
        .prepare("SELECT * FROM session_schedule_fires_v6 WHERE id=?")
        .get(fireId) as FireRow | undefined;
      if (!fire) throw new Error("Fire not found.");
      const result = this.db
        .prepare(
          "UPDATE session_schedule_fires_v6 SET state='failed',error_code=?,error_message=?,updated_at=? WHERE id=? AND state IN ('pending','claimed')",
        )
        .run(errorCode, errorMessage, now, fireId);
      if (!result.changes)
        throw new SessionScheduleConflictError("Fire state changed.");
      this.db
        .prepare(
          "UPDATE session_schedules_v6 SET state='paused',revision=revision+1,next_fire_at=NULL,updated_at=? WHERE id=? AND revision=? AND state <> 'deleted'",
        )
        .run(now, fire.schedule_id, fire.schedule_revision);
      const settled = this.getFire(fireId)!;
      this.cleanupFires(fireId);
      return settled;
    });
  }
  settleEnqueuedAndCompleteOnce(
    fireId: string,
    executionId: string,
    now: string,
  ): SessionScheduleFire {
    return tx(this.db, () => {
      const fire = this.db
        .prepare("SELECT * FROM session_schedule_fires_v6 WHERE id=?")
        .get(fireId) as FireRow | undefined;
      if (!fire) throw new Error("Fire not found.");
      const result = this.db
        .prepare(
          "UPDATE session_schedule_fires_v6 SET state='enqueued',execution_id=?,updated_at=? WHERE id=? AND state IN ('pending','claimed')",
        )
        .run(executionId, now, fireId);
      if (!result.changes)
        throw new SessionScheduleConflictError("Fire state changed.");
      this.db
        .prepare(
          "UPDATE session_schedules_v6 SET state='completed',revision=revision+1,next_fire_at=NULL,updated_at=? WHERE id=? AND revision=? AND trigger_type='once' AND state <> 'deleted'",
        )
        .run(now, fire.schedule_id, fire.schedule_revision);
      const settled = this.getFire(fireId)!;
      this.cleanupFires(fireId);
      return settled;
    });
  }
  private settleFire(
    id: string,
    state: SessionScheduleFireState,
    now: string,
    executionId: string | null,
    errorCode: string | null,
    errorMessage: string | null,
  ): SessionScheduleFire {
    return tx(this.db, () => {
      const result = this.db
        .prepare(
          "UPDATE session_schedule_fires_v6 SET state=?,execution_id=?,error_code=?,error_message=?,updated_at=? WHERE id=? AND state IN ('pending','claimed')",
        )
        .run(state, executionId, errorCode, errorMessage, now, id);
      if (!result.changes)
        throw new SessionScheduleConflictError("Fire state changed.");
      const settled = this.getFire(id)!;
      this.cleanupFires(id);
      return settled;
    });
  }
  private cleanupFires(fireId: string): void {
    const row = this.db
      .prepare("SELECT schedule_id FROM session_schedule_fires_v6 WHERE id=?")
      .get(fireId) as { schedule_id: string } | undefined;
    if (!row) return;
    this.db
      .prepare(
        "DELETE FROM session_schedule_fires_v6 WHERE schedule_id=? AND state IN ('enqueued','failed') AND id NOT IN (SELECT id FROM session_schedule_fires_v6 WHERE schedule_id=? AND state IN ('enqueued','failed') ORDER BY created_at DESC,id DESC LIMIT 50)",
      )
      .run(row.schedule_id, row.schedule_id);
    this.purgeDeletedScheduleIfReplayed(row.schedule_id);
  }
  private purgeDeletedScheduleIfReplayed(scheduleId: string): void {
    const pending = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM session_schedule_fires_v6 WHERE schedule_id=? AND state IN ('pending','claimed')",
        )
        .get(scheduleId) as { n: number }
    ).n;
    if (pending === 0) {
      this.db
        .prepare("DELETE FROM session_schedules_v6 WHERE id=? AND state='deleted'")
        .run(scheduleId);
    }
  }
  getFire(id: string): SessionScheduleFire | null {
    const r = this.db
      .prepare("SELECT * FROM session_schedule_fires_v6 WHERE id=?")
      .get(id) as FireRow | undefined;
    return r ? fireFromRow(r) : null;
  }
  getFireByKey(key: string): SessionScheduleFire | null {
    const r = this.db
      .prepare(
        "SELECT * FROM session_schedule_fires_v6 WHERE idempotency_key=?",
      )
      .get(key) as FireRow | undefined;
    return r ? fireFromRow(r) : null;
  }
  latestFire(scheduleId: string): SessionScheduleFire | null {
    const r = this.db
      .prepare(
        "SELECT * FROM session_schedule_fires_v6 WHERE schedule_id=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(scheduleId) as FireRow | undefined;
    return r ? fireFromRow(r) : null;
  }
  listPendingFireClaims(claimedAt: string): SessionScheduleFireClaim[] {
    return this.listPendingFires().flatMap((fire) => {
      const claimed = this.claimPendingFire(fire.id, claimedAt);
      if (!claimed) return [];
      const row = this.db
        .prepare("SELECT * FROM session_schedule_fires_v6 WHERE id=?")
        .get(fire.id) as FireRow;
      return [this.fireClaimFromRow(row)];
    });
  }

  claimScheduledFire(
    input: Parameters<SessionScheduleStorage["claimScheduledFire"]>[0],
  ): SessionScheduleFireClaim | null {
    const claimed = this.claimDueFire(
      input.scheduleId,
      input.expectedRevision,
      input.expectedNextFireAt,
      input.logicalFireAt,
      input.nextFireAt,
      input.fireId,
      input.idempotencyKey,
      input.claimedAt,
    );
    if (!claimed) return null;
    const durable = this.claimPendingFire(claimed.fire.id, input.claimedAt);
    if (!durable) return null;
    const row = this.db
      .prepare("SELECT * FROM session_schedule_fires_v6 WHERE id=?")
      .get(claimed.fire.id) as FireRow;
    return this.fireClaimFromRow(row);
  }

  claimRunNowFire(
    input: Parameters<SessionScheduleStorage["claimRunNowFire"]>[0],
  ): SessionScheduleFireClaim {
    const fire = this.createRunNowFire(
      input.scheduleId,
      input.fireId,
      input.idempotencyKey,
      input.claimedAt,
    );
    const durable = this.claimPendingFire(fire.id, input.claimedAt);
    if (!durable)
      throw new SessionScheduleConflictError("Run-now fire state changed.");
    const row = this.db
      .prepare("SELECT * FROM session_schedule_fires_v6 WHERE id=?")
      .get(fire.id) as FireRow;
    return this.fireClaimFromRow(row);
  }

  settleFireEnqueued(
    input: Parameters<SessionScheduleStorage["settleFireEnqueued"]>[0],
  ): void {
    if (input.completeOnce) {
      this.settleEnqueuedAndCompleteOnce(
        input.fireId,
        input.executionId,
        input.settledAt,
      );
    } else {
      this.settleEnqueued(input.fireId, input.executionId, input.settledAt);
    }
  }

  settleFireFailed(
    input: Parameters<SessionScheduleStorage["settleFireFailed"]>[0],
  ): void {
    if (input.pauseSchedule) {
      this.settleFailedAndPause(
        input.fireId,
        input.errorCode,
        input.reason,
        input.settledAt,
      );
    } else {
      this.settleFailed(
        input.fireId,
        input.errorCode,
        input.reason,
        input.settledAt,
      );
    }
  }

  private fireClaimFromRow(row: FireRow): SessionScheduleFireClaim {
    return {
      id: row.id,
      scheduleId: row.schedule_id,
      sessionId: row.session_id,
      scheduleRevision: row.schedule_revision,
      kind: row.kind,
      triggerKind: row.trigger_type,
      logicalFireAt: row.logical_fire_at,
      enqueueIdempotencyKey: row.idempotency_key,
      turnSnapshot: JSON.parse(row.turn_json) as SessionScheduleTurn,
    };
  }
}

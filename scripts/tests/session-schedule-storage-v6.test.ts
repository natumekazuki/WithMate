import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  SessionScheduleLimitError,
  SessionScheduleStorageV6,
} from "../../src-electron/session-schedule-storage-v6.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "withmate-schedule-"));
  const path = join(dir, "db.sqlite");
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE sessions_v6 (id TEXT PRIMARY KEY,title TEXT NOT NULL,state TEXT NOT NULL,session_kind TEXT NOT NULL,provider_id TEXT NOT NULL,catalog_revision INTEGER NOT NULL,model_id TEXT NOT NULL,reasoning_effort TEXT NOT NULL,custom_agent_name TEXT NOT NULL,approval_mode TEXT NOT NULL,codex_sandbox_mode TEXT NOT NULL,allowed_additional_directories_json TEXT NOT NULL,runtime_policy_json TEXT NOT NULL,thread_id TEXT NOT NULL,character_id TEXT,character_snapshot_json TEXT,project_scope_id TEXT,workspace_path TEXT NOT NULL,is_pinned INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_active_at TEXT NOT NULL)",
  );
  db.prepare(
    "INSERT INTO sessions_v6 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    "s1",
    "S",
    "active",
    "default",
    "codex",
    1,
    "m",
    "high",
    "",
    "never",
    "workspace-write",
    "[]",
    "{}",
    "",
    null,
    null,
    null,
    "",
    0,
    "now",
    "now",
    "now",
  );
  db.close();
  return { dir, path };
}
function input(id: string): any {
  return {
    id,
    sessionId: "s1",
    name: id,
    trigger: { type: "cron", expression: "0 * * * *", timeZone: "UTC" },
    turn: {
      provider: "codex",
      userMessage: "hello",
      model: "m",
      reasoningEffort: "high",
      approvalMode: "never",
      codexSandboxMode: "workspace-write",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nextFireAt: "2026-01-01T01:00:00.000Z",
  };
}

test("schedule storage enforces limit, atomic claim, immutable replay and tombstone", async () => {
  const f = await fixture();
  const s = new SessionScheduleStorageV6(f.path);
  try {
    const first = s.create(input("a"));
    const fire = s.claimDueFire(
      first.id,
      1,
      first.nextFireAt!,
      "2026-01-01T01:00:00.000Z",
      "2026-01-01T02:00:00.000Z",
      "f1",
      "k1",
      "2026-01-01T01:00:00.000Z",
    )!;
    assert.equal(fire.fire.sessionId, "s1");
    s.update({
      id: first.id,
      expectedRevision: 1,
      name: "changed",
      trigger: first.trigger,
      turn: { ...first.turn, userMessage: "new" },
      nextFireAt: null,
      updatedAt: "2026-01-01T01:01:00.000Z",
    });
    const replay = s.claimPendingFire("f1", "2026-01-01T01:02:00.000Z")!;
    assert.equal(replay.fire.turn.userMessage, "hello");
    s.delete(first.id);
    assert.equal(s.get(first.id), null);
    assert.equal(s.getFire("f1")?.state, "claimed");
    for (let i = 0; i < 20; i++) s.create(input(`x${i}`));
    assert.throws(() => s.create(input("overflow")), SessionScheduleLimitError);
  } finally {
    s.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("terminal retention keeps newest 50 and never deletes pending/claimed", async () => {
  const f = await fixture();
  const s = new SessionScheduleStorageV6(f.path);
  try {
    const schedule = s.create(input("retention"));
    const db = (s as any).db as DatabaseSync;
    for (let i = 0; i < 52; i++) {
      db.prepare(
        "INSERT INTO session_schedule_fires_v6 (id,schedule_id,session_id,schedule_revision,logical_fire_at,kind,state,idempotency_key,turn_json,created_at,updated_at) VALUES (?,?,?,?,?,'scheduled','enqueued',?,?,?,?)",
      ).run(
        `t${i}`,
        schedule.id,
        "s1",
        1,
        `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
        `key-${i}`,
        JSON.stringify(schedule.turn),
        `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
        `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
      );
    }
    db.prepare(
      "INSERT INTO session_schedule_fires_v6 (id,schedule_id,session_id,schedule_revision,logical_fire_at,kind,state,idempotency_key,turn_json,created_at,updated_at) VALUES (?,?,?,?,?,'scheduled','pending',?,?,?,?)",
    ).run(
      "pending",
      schedule.id,
      "s1",
      1,
      "2026-01-02T00:00:00.000Z",
      "pending-key",
      JSON.stringify(schedule.turn),
      "2026-01-02T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    );
    s.settleFailed("pending", "E", "x", "2026-01-02T00:00:01.000Z");
    const terminal = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM session_schedule_fires_v6 WHERE schedule_id=? AND state IN ('enqueued','failed')",
        )
        .get(schedule.id) as any
    ).n;
    assert.equal(terminal, 50);
  } finally {
    s.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("old revision fire settlement does not pause or complete an updated schedule", async () => {
  const f = await fixture();
  const storage = new SessionScheduleStorageV6(f.path);
  try {
    const cron = storage.create(input("revision-cron"));
    storage.claimScheduledFire({
      scheduleId: cron.id,
      expectedRevision: cron.revision,
      expectedNextFireAt: cron.nextFireAt!,
      logicalFireAt: cron.nextFireAt!,
      nextFireAt: "2026-01-01T02:00:00.000Z",
      fireId: "revision-cron-fire",
      idempotencyKey: "revision-cron-key",
      claimedAt: cron.nextFireAt!,
    });
    storage.update({
      id: cron.id,
      expectedRevision: cron.revision,
      name: cron.name,
      trigger: cron.trigger,
      turn: cron.turn,
      nextFireAt: "2026-01-01T03:00:00.000Z",
      updatedAt: "2026-01-01T01:01:00.000Z",
    });
    storage.settleFireFailed({
      fireId: "revision-cron-fire",
      errorCode: "INVALID_INPUT",
      reason: "catalog changed",
      settledAt: "2026-01-01T01:02:00.000Z",
      pauseSchedule: true,
    });
    assert.equal(storage.get(cron.id)?.state, "active");
    assert.equal(storage.get(cron.id)?.revision, 2);

    const onceInput = input("revision-once");
    onceInput.trigger = {
      type: "once",
      localDateTime: "2026-01-02T00:00",
      timeZone: "UTC",
    };
    onceInput.nextFireAt = "2026-01-02T00:00:00.000Z";
    const once = storage.create(onceInput);
    storage.claimScheduledFire({
      scheduleId: once.id,
      expectedRevision: once.revision,
      expectedNextFireAt: once.nextFireAt!,
      logicalFireAt: once.nextFireAt!,
      nextFireAt: null,
      fireId: "revision-once-fire",
      idempotencyKey: "revision-once-key",
      claimedAt: once.nextFireAt!,
    });
    storage.update({
      id: once.id,
      expectedRevision: once.revision,
      name: once.name,
      trigger: once.trigger,
      turn: once.turn,
      nextFireAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-02T00:01:00.000Z",
    });
    storage.settleFireEnqueued({
      fireId: "revision-once-fire",
      executionId: "execution-once",
      settledAt: "2026-01-02T00:02:00.000Z",
      completeOnce: true,
    });
    assert.equal(storage.get(once.id)?.state, "active");
    assert.equal(storage.get(once.id)?.revision, 2);
  } finally {
    storage.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("run now requests at the same instant create distinct durable fires", async () => {
  const f = await fixture();
  const storage = new SessionScheduleStorageV6(f.path);
  try {
    const schedule = storage.create(input("run-now"));
    const claimedAt = "2026-01-01T00:00:00.000Z";
    const first = storage.claimRunNowFire({
      scheduleId: schedule.id,
      requestId: "request-1",
      logicalFireAt: claimedAt,
      fireId: "run-now-fire-1",
      idempotencyKey: "run-now-key-1",
      claimedAt,
    });
    const second = storage.claimRunNowFire({
      scheduleId: schedule.id,
      requestId: "request-2",
      logicalFireAt: claimedAt,
      fireId: "run-now-fire-2",
      idempotencyKey: "run-now-key-2",
      claimedAt,
    });
    assert.notEqual(first.id, second.id);
    assert.equal(storage.listPendingFireClaims(claimedAt).length, 2);
  } finally {
    storage.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("terminal cleanup keeps pending and claimed fires outside the newest 50", async () => {
  const f = await fixture();
  const storage = new SessionScheduleStorageV6(f.path);
  try {
    const schedule = storage.create(input("pending-retention"));
    const db = (storage as unknown as { db: DatabaseSync }).db;
    for (let index = 0; index < 51; index += 1) {
      db.prepare(
        "INSERT INTO session_schedule_fires_v6 (id,schedule_id,session_id,schedule_revision,logical_fire_at,kind,state,idempotency_key,turn_json,created_at,updated_at) VALUES (?,?,?,?,?,'scheduled','enqueued',?,?,?,?)",
      ).run(
        `terminal-${index}`,
        schedule.id,
        "s1",
        1,
        `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`,
        `terminal-key-${index}`,
        JSON.stringify(schedule.turn),
        `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`,
        `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`,
      );
    }
    for (const [id, state] of [
      ["keep-pending", "pending"],
      ["keep-claimed", "claimed"],
    ] as const) {
      db.prepare(
        "INSERT INTO session_schedule_fires_v6 (id,schedule_id,session_id,schedule_revision,logical_fire_at,kind,state,idempotency_key,turn_json,claimed_at,created_at,updated_at) VALUES (?,?,?,?,?,'run_now',?,?,?,?,?,?)",
      ).run(
        id,
        schedule.id,
        "s1",
        1,
        "2026-01-02T00:00:00.000Z",
        state,
        `${id}-key`,
        JSON.stringify(schedule.turn),
        state === "claimed" ? "2026-01-02T00:00:00.000Z" : null,
        "2026-01-02T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
      );
    }
    db.prepare(
      "INSERT INTO session_schedule_fires_v6 (id,schedule_id,session_id,schedule_revision,logical_fire_at,kind,state,idempotency_key,turn_json,created_at,updated_at) VALUES (?,?,?,?,?,'run_now','pending',?,?,?,?)",
    ).run(
      "cleanup-fire",
      schedule.id,
      "s1",
      1,
      "2026-01-02T00:01:00.000Z",
      "cleanup-key",
      JSON.stringify(schedule.turn),
      "2026-01-02T00:01:00.000Z",
      "2026-01-02T00:01:00.000Z",
    );
    storage.settleFailed(
      "cleanup-fire",
      "E",
      "cleanup",
      "2026-01-02T00:01:01.000Z",
    );
    assert.equal(storage.getFire("keep-pending")?.state, "pending");
    assert.equal(storage.getFire("keep-claimed")?.state, "claimed");
    const terminalCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM session_schedule_fires_v6 WHERE schedule_id=? AND state IN ('enqueued','failed')",
        )
        .get(schedule.id) as { count: number }
    ).count;
    assert.equal(terminalCount, 50);
  } finally {
    storage.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

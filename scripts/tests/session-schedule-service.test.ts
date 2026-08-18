import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SessionScheduleService,
  type SessionScheduleDueResolution,
  type SessionScheduleFireClaim,
  type SessionScheduleStorage,
  type SessionScheduleTimerHandle,
} from "../../src-electron/session-schedule-service.js";
import type {
  SessionSchedule,
  SessionScheduleProjection,
} from "../../src/session-schedule.js";

describe("SessionScheduleService", () => {
  it("createはtriggerとTurnを永続mutation前に検証しstrict-future nextを保存する", async () => {
    const fixture = createFixture();
    const events: string[] = [];
    const service = new SessionScheduleService({
      storage: fixture.storage,
      createScheduleId: () => "created-schedule",
      validateTrigger: () => events.push("trigger"),
      nextTriggerInstant: () => new Date("2026-08-18T00:11:00.000Z"),
      validateScheduleTurn: (_sessionId, turn) => {
        events.push("turn");
        return { ...turn, userMessage: "validated" };
      },
      resolveDueOccurrence: () => null,
      enqueueTurn: fixture.enqueue,
      now: () => fixture.now,
      setTimer: (callback, delayMs) => fixture.timers.set(callback, delayMs),
      clearTimer: (handle) => fixture.timers.clear(handle),
      onChanged: (event) => fixture.changedEvents.push(event),
    });
    await service.start();

    const created = await service.create({
      sessionId: "session-1",
      name: "  Daily check  ",
      trigger: { type: "cron", expression: "* * * * *", timeZone: "UTC" },
      turn: { provider: "codex", userMessage: "draft" },
    });

    assert.deepEqual(events, ["trigger", "turn"]);
    assert.equal(created.name, "Daily check");
    assert.equal(created.turn.userMessage, "validated");
    assert.equal(created.nextFireAt, "2026-08-18T00:11:00.000Z");
    assert.deepEqual(fixture.changedEvents, [
      {
        kind: "created",
        sessionId: "session-1",
        scheduleId: "created-schedule",
      },
    ]);
    await service.shutdown();
  });

  it("resumeはpause中のmissedをcatch upせずnowより後のnextを保存する", async () => {
    const fixture = createFixture();
    fixture.storage.addSchedule(
      schedule({ state: "paused", nextFireAt: null }),
    );
    const service = fixture.createService();
    await service.start();

    const resumed = await service.resume({
      sessionId: "session-1",
      scheduleId: "schedule-1",
      expectedRevision: 1,
    });

    assert.equal(resumed.nextFireAt, "2026-08-18T00:11:00.000Z");
    assert.equal(fixture.storage.claimedLogicalInstants.length, 0);
    await service.shutdown();
  });

  it("run now retryは時刻やrevisionが変わってもrequest IDから同じkeyを使う", async () => {
    const fixture = createFixture();
    fixture.storage.addSchedule(
      schedule({ nextFireAt: "2026-08-18T01:00:00.000Z" }),
    );
    const service = fixture.createService();
    await service.start();
    const first = await service.runNow(
      "session-1",
      "schedule-1",
      "request-stable",
    );

    fixture.now = new Date("2026-08-18T00:20:00.000Z");
    fixture.storage.schedules.set("schedule-1", {
      ...fixture.storage.schedules.get("schedule-1")!,
      revision: 2,
    });
    const replay = await service.runNow(
      "session-1",
      "schedule-1",
      "request-stable",
    );

    assert.equal(replay.enqueueIdempotencyKey, first.enqueueIdempotencyKey);
    await service.shutdown();
  });

  it("claim後crashは再起動後にimmutable snapshotと同じkeyでreplayする", async () => {
    const fixture = createFixture();
    fixture.storage.addSchedule(
      schedule({ nextFireAt: fixture.now.toISOString() }),
    );
    fixture.enqueue = async () => {
      throw new Error("process crashed after claim");
    };
    const first = fixture.createService();

    await first.start();
    assert.equal(fixture.storage.pending.size, 1);
    const claimed = [...fixture.storage.pending.values()][0]!;
    await first.shutdown();

    fixture.storage.schedules.set("schedule-1", {
      ...fixture.storage.schedules.get("schedule-1")!,
      revision: 2,
      sessionId: "changed-session",
    });
    fixture.enqueue = async (input) => {
      fixture.enqueueInputs.push(input);
      return { ok: true, executionId: "execution-1" };
    };
    const restarted = fixture.createService();
    await restarted.start();

    assert.equal(fixture.storage.pending.size, 0);
    assert.equal(fixture.enqueueInputs.at(-1)?.sessionId, claimed.sessionId);
    assert.equal(
      fixture.enqueueInputs.at(-1)?.idempotencyKey,
      claimed.enqueueIdempotencyKey,
    );
    assert.equal(
      fixture.enqueueInputs.at(-1)?.turn.userMessage,
      "snapshot revision 1",
    );
    await restarted.shutdown();
  });

  it("enqueue response lossは同じkeyを再送して一つのexecutionへ収束する", async () => {
    const fixture = createFixture({ pendingRetryDelayMs: 10 });
    fixture.storage.addSchedule(
      schedule({ nextFireAt: fixture.now.toISOString() }),
    );
    const executions = new Map<string, string>();
    let responses = 0;
    fixture.enqueue = async (input) => {
      fixture.enqueueInputs.push(input);
      const executionId =
        executions.get(input.idempotencyKey) ?? "execution-stable";
      executions.set(input.idempotencyKey, executionId);
      responses += 1;
      if (responses === 1) throw new Error("response lost");
      return { ok: true, executionId };
    };
    const service = fixture.createService();

    await service.start();
    assert.equal(fixture.storage.pending.size, 1);
    await fixture.timers.fireNext();
    await waitFor(() => fixture.storage.pending.size === 0);

    assert.equal(fixture.enqueueInputs.length, 2);
    assert.equal(
      fixture.enqueueInputs[0]?.idempotencyKey,
      fixture.enqueueInputs[1]?.idempotencyKey,
    );
    assert.deepEqual([...executions.values()], ["execution-stable"]);
    assert.equal(fixture.storage.enqueued[0]?.executionId, "execution-stable");
    await service.shutdown();
  });

  it("複数missed occurrenceは最新一件だけclaimし次回futureを保存する", async () => {
    const fixture = createFixture();
    fixture.storage.addSchedule(
      schedule({ nextFireAt: "2026-08-18T00:01:00.000Z" }),
    );
    fixture.resolveDue = () => ({
      logicalFireAt: "2026-08-18T00:09:00.000Z",
      nextFireAt: "2026-08-18T00:11:00.000Z",
    });
    const service = fixture.createService();

    await service.start();

    assert.deepEqual(fixture.storage.claimedLogicalInstants, [
      "2026-08-18T00:09:00.000Z",
    ]);
    assert.equal(
      fixture.storage.schedules.get("schedule-1")?.nextFireAt,
      "2026-08-18T00:11:00.000Z",
    );
    assert.equal(fixture.enqueueInputs.length, 1);
    await service.shutdown();
  });

  it("前回executionのterminalを待たず次のlogical fireをenqueueする", async () => {
    const fixture = createFixture();
    fixture.storage.addSchedule(
      schedule({ nextFireAt: fixture.now.toISOString() }),
    );
    const service = fixture.createService();

    await service.start();
    fixture.now = new Date("2026-08-18T00:01:00.000Z");
    fixture.storage.schedules.get("schedule-1")!.nextFireAt =
      fixture.now.toISOString();
    await service.schedulesChanged();

    assert.equal(fixture.enqueueInputs.length, 2);
    assert.notEqual(
      fixture.enqueueInputs[0]?.idempotencyKey,
      fixture.enqueueInputs[1]?.idempotencyKey,
    );
    await service.shutdown();
  });

  it("queue fullはfireをfailedにするがcron scheduleをpauseしない", async () => {
    const fixture = createFixture();
    fixture.storage.addSchedule(
      schedule({ nextFireAt: fixture.now.toISOString() }),
    );
    fixture.enqueue = async () => ({
      ok: false,
      errorCode: "QUEUE_FULL",
      reason: "queue capacity reached",
      pauseSchedule: false,
    });
    const service = fixture.createService();

    await service.start();

    assert.equal(fixture.storage.failed[0]?.errorCode, "QUEUE_FULL");
    assert.equal(fixture.storage.failed[0]?.pauseSchedule, false);
    assert.equal(fixture.storage.schedules.get("schedule-1")?.state, "active");
    await service.shutdown();
  });

  it("invalid saved tupleは副作用なしでfailedにしてcurrent scheduleをpauseする", async () => {
    const fixture = createFixture();
    fixture.storage.addSchedule(
      schedule({ nextFireAt: fixture.now.toISOString() }),
    );
    fixture.enqueue = async () => ({
      ok: false,
      errorCode: "TURN_INVALID",
      reason: "attachment permission was removed",
      pauseSchedule: true,
    });
    const service = fixture.createService();

    await service.start();

    assert.equal(fixture.enqueueInputs.length, 0);
    assert.equal(fixture.storage.failed[0]?.pauseSchedule, true);
    assert.equal(fixture.storage.schedules.get("schedule-1")?.state, "paused");
    await service.shutdown();
  });

  it("onceはenqueue受理時にexecution terminalを待たずcompletedになる", async () => {
    const fixture = createFixture();
    fixture.storage.addSchedule(
      schedule({
        trigger: {
          type: "once",
          localDateTime: "2026-08-18T00:10",
          timeZone: "UTC",
        },
        nextFireAt: fixture.now.toISOString(),
      }),
    );
    const service = fixture.createService();

    await service.start();

    assert.equal(fixture.storage.enqueued[0]?.completeOnce, true);
    assert.equal(
      fixture.storage.schedules.get("schedule-1")?.state,
      "completed",
    );
    assert.deepEqual(
      fixture.changedEvents.map((event) => event.kind),
      ["fired", "fired"],
    );
    await service.shutdown();
  });

  it("次回予定はenqueue遅延でdriftさせずresolve済みinstantを保存する", async () => {
    const fixture = createFixture();
    fixture.storage.addSchedule(
      schedule({ nextFireAt: fixture.now.toISOString() }),
    );
    fixture.resolveDue = () => ({
      logicalFireAt: "2026-08-18T00:00:00.000Z",
      nextFireAt: "2026-08-18T00:05:00.000Z",
    });
    fixture.enqueue = async (input) => {
      fixture.now = new Date("2026-08-18T00:03:47.000Z");
      fixture.enqueueInputs.push(input);
      return { ok: true, executionId: "execution-delayed" };
    };
    const service = fixture.createService();

    await service.start();

    assert.equal(
      fixture.storage.schedules.get("schedule-1")?.nextFireAt,
      "2026-08-18T00:05:00.000Z",
    );
    await service.shutdown();
  });

  it("schedule変更は既存timerを一つへre-armしshutdownは残りをclearする", async () => {
    const fixture = createFixture();
    fixture.storage.addSchedule(
      schedule({ nextFireAt: "2026-08-18T00:10:00.000Z" }),
    );
    const service = fixture.createService();

    await service.start();
    assert.equal(fixture.timers.activeCount(), 1);
    fixture.storage.schedules.set("schedule-1", {
      ...fixture.storage.schedules.get("schedule-1")!,
      nextFireAt: "2026-08-18T00:12:00.000Z",
    });
    await service.schedulesChanged();
    assert.equal(fixture.timers.activeCount(), 1);
    assert.equal(fixture.timers.active()[0]?.delayMs, 60_000);

    await service.shutdown();
    assert.equal(fixture.timers.activeCount(), 0);
  });

  it("shutdownはin-flight enqueue drain完了までstorage close境界を越えない", async () => {
    const fixture = createFixture();
    fixture.storage.addSchedule(
      schedule({ nextFireAt: fixture.now.toISOString() }),
    );
    let resolveEnqueue!: () => void;
    fixture.enqueue = (input) => {
      fixture.enqueueInputs.push(input);
      return new Promise((resolve) => {
        resolveEnqueue = () =>
          resolve({ ok: true, executionId: "execution-drained" });
      });
    };
    const service = fixture.createService();
    await service.start();
    await waitFor(() => fixture.enqueueInputs.length === 1);

    let shutdownCompleted = false;
    const shutdown = service.shutdown().then(() => {
      shutdownCompleted = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(shutdownCompleted, false);

    resolveEnqueue();
    await shutdown;
    assert.equal(shutdownCompleted, true);
    assert.equal(fixture.storage.enqueued.length, 1);
    assert.equal(fixture.timers.activeCount(), 0);
  });

  it("background persistence failureは報告して単一retry timerへ収束する", async () => {
    const fixture = createFixture({ pendingRetryDelayMs: 10 });
    fixture.storage.addSchedule(
      schedule({ nextFireAt: "2026-08-18T00:11:00.000Z" }),
    );
    const errors: unknown[] = [];
    const original = fixture.storage.listActiveSchedules.bind(fixture.storage);
    const service = new SessionScheduleService({
      storage: fixture.storage,
      createScheduleId: () => "created-schedule",
      validateTrigger: () => undefined,
      nextTriggerInstant: () => new Date(fixture.now.getTime() + 60_000),
      validateScheduleTurn: (_sessionId, turn) => turn,
      resolveDueOccurrence: defaultResolveDue,
      enqueueTurn: fixture.enqueue,
      now: () => fixture.now,
      setTimer: (callback, delayMs) => fixture.timers.set(callback, delayMs),
      clearTimer: (handle) => fixture.timers.clear(handle),
      pendingRetryDelayMs: 10,
      onBackgroundError: (error) => errors.push(error),
    });
    await service.start();
    fixture.storage.listActiveSchedules = () => {
      throw new Error("database temporarily unavailable");
    };

    await fixture.timers.fireNext();
    await waitFor(() => errors.length === 1);
    fixture.storage.listActiveSchedules = original;

    assert.equal(fixture.timers.activeCount(), 1);
    assert.equal(fixture.timers.active()[0]?.delayMs, 10);
    await service.shutdown();
  });
});

type EnqueueInput = Parameters<
  NonNullable<
    ConstructorParameters<typeof SessionScheduleService>[0]["enqueueTurn"]
  >
>[0];

function createFixture(options: { pendingRetryDelayMs?: number } = {}) {
  const storage = new FakeStorage();
  const timers = new FakeTimers();
  const fixture = {
    now: new Date("2026-08-18T00:10:00.000Z"),
    storage,
    timers,
    changedEvents: [] as NonNullable<
      ConstructorParameters<typeof SessionScheduleService>[0]["onChanged"]
    > extends (event: infer T) => void
      ? T[]
      : never,
    enqueueInputs: [] as EnqueueInput[],
    resolveDue: ((entry: SessionSchedule, now: Date) =>
      defaultResolveDue(entry, now)) as (
      entry: SessionSchedule,
      now: Date,
    ) => SessionScheduleDueResolution | null,
    enqueue: (async (input: EnqueueInput) => {
      fixture.enqueueInputs.push(input);
      return {
        ok: true as const,
        executionId: `execution-${fixture.enqueueInputs.length}`,
      };
    }) as ConstructorParameters<
      typeof SessionScheduleService
    >[0]["enqueueTurn"],
    createService() {
      return new SessionScheduleService({
        storage,
        createScheduleId: () => "created-schedule",
        validateTrigger: () => undefined,
        nextTriggerInstant: () => new Date(fixture.now.getTime() + 60_000),
        validateScheduleTurn: (_sessionId, turn) => turn,
        now: () => fixture.now,
        resolveDueOccurrence: (entry, now) => fixture.resolveDue(entry, now),
        enqueueTurn: (input) => fixture.enqueue(input),
        setTimer: (callback, delayMs) => timers.set(callback, delayMs),
        clearTimer: (handle) => timers.clear(handle),
        pendingRetryDelayMs: options.pendingRetryDelayMs,
        onChanged: (event) => fixture.changedEvents.push(event),
      });
    },
  };
  return fixture;
}

function schedule(overrides: Partial<SessionSchedule> = {}): SessionSchedule {
  return {
    id: "schedule-1",
    sessionId: "session-1",
    revision: 1,
    name: "Schedule",
    state: "active",
    trigger: { type: "cron", expression: "*/1 * * * *", timeZone: "UTC" },
    turn: { provider: "codex", userMessage: "turn" },
    nextFireAt: "2026-08-18T00:10:00.000Z",
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

function defaultResolveDue(
  entry: SessionSchedule,
  now: Date,
): SessionScheduleDueResolution | null {
  if (!entry.nextFireAt || Date.parse(entry.nextFireAt) > now.getTime())
    return null;
  return {
    logicalFireAt: entry.nextFireAt,
    nextFireAt:
      entry.trigger.type === "once"
        ? null
        : new Date(Date.parse(entry.nextFireAt) + 60_000).toISOString(),
  };
}

class FakeStorage implements SessionScheduleStorage {
  readonly schedules = new Map<string, SessionSchedule>();
  readonly pending = new Map<string, SessionScheduleFireClaim>();
  readonly claimedByIdempotency = new Map<string, SessionScheduleFireClaim>();
  readonly enqueued: Array<
    Parameters<SessionScheduleStorage["settleFireEnqueued"]>[0]
  > = [];
  readonly failed: Array<
    Parameters<SessionScheduleStorage["settleFireFailed"]>[0]
  > = [];
  readonly claimedLogicalInstants: string[] = [];

  addSchedule(value: SessionSchedule): void {
    this.schedules.set(value.id, { ...value, trigger: { ...value.trigger } });
  }

  create(
    input: Parameters<SessionScheduleStorage["create"]>[0],
  ): SessionSchedule {
    const created: SessionSchedule = { ...input, state: "active", revision: 1 };
    this.addSchedule(created);
    return { ...created };
  }

  get(id: string): SessionSchedule | null {
    const value = this.schedules.get(id);
    return value ? { ...value, trigger: { ...value.trigger } } : null;
  }

  list(sessionId?: string): SessionScheduleProjection[] {
    return [...this.schedules.values()]
      .filter(
        (value) => sessionId === undefined || value.sessionId === sessionId,
      )
      .map((value) => ({
        ...value,
        trigger: { ...value.trigger },
        latestFire: null,
      }));
  }

  update(
    input: Parameters<SessionScheduleStorage["update"]>[0],
  ): SessionSchedule {
    const current = this.schedules.get(input.id);
    if (!current || current.revision !== input.expectedRevision)
      throw new Error("revision conflict");
    const updated: SessionSchedule = {
      ...current,
      ...input,
      revision: current.revision + 1,
    };
    this.addSchedule(updated);
    return updated;
  }

  setScheduleState(
    input: Parameters<SessionScheduleStorage["setScheduleState"]>[0],
  ): SessionSchedule {
    const current = this.schedules.get(input.id);
    if (!current || current.revision !== input.expectedRevision)
      throw new Error("revision conflict");
    const updated = {
      ...current,
      revision: current.revision + 1,
      state: input.state,
      nextFireAt: input.nextFireAt,
      updatedAt: input.updatedAt,
    };
    this.addSchedule(updated);
    return updated;
  }

  deleteSchedule(
    input: Parameters<SessionScheduleStorage["deleteSchedule"]>[0],
  ): void {
    const current = this.schedules.get(input.id);
    if (!current || current.revision !== input.expectedRevision)
      throw new Error("revision conflict");
    this.schedules.delete(input.id);
  }

  listActiveSchedules(): SessionSchedule[] {
    return [...this.schedules.values()]
      .filter((entry) => entry.state === "active")
      .map((entry) => ({ ...entry, trigger: { ...entry.trigger } }));
  }

  listPendingFireClaims(_claimedAt: string): SessionScheduleFireClaim[] {
    return [...this.pending.values()].map((claim) => ({ ...claim }));
  }

  claimScheduledFire(
    input: Parameters<SessionScheduleStorage["claimScheduledFire"]>[0],
  ): SessionScheduleFireClaim | null {
    const current = this.schedules.get(input.scheduleId);
    if (
      !current ||
      current.state !== "active" ||
      current.revision !== input.expectedRevision ||
      current.nextFireAt !== input.expectedNextFireAt
    )
      return null;
    const claim = createClaim(
      current,
      input.logicalFireAt,
      "",
      input.fireId,
      input.idempotencyKey,
    );
    this.pending.set(claim.id, claim);
    this.claimedByIdempotency.set(claim.enqueueIdempotencyKey, claim);
    current.nextFireAt = input.nextFireAt;
    this.claimedLogicalInstants.push(input.logicalFireAt);
    return { ...claim };
  }

  claimRunNowFire(
    input: Parameters<SessionScheduleStorage["claimRunNowFire"]>[0],
  ): SessionScheduleFireClaim {
    const current = this.schedules.get(input.scheduleId);
    if (!current) throw new Error("Schedule not found.");
    const replay = this.claimedByIdempotency.get(input.idempotencyKey);
    if (replay) return { ...replay };
    const claim = createClaim(
      current,
      input.logicalFireAt,
      input.requestId,
      input.fireId,
      input.idempotencyKey,
    );
    this.pending.set(claim.id, claim);
    this.claimedByIdempotency.set(claim.enqueueIdempotencyKey, claim);
    return { ...claim };
  }

  settleFireEnqueued(
    input: Parameters<SessionScheduleStorage["settleFireEnqueued"]>[0],
  ): void {
    const claim = this.pending.get(input.fireId);
    if (!claim) throw new Error("Fire is not pending.");
    this.pending.delete(input.fireId);
    this.enqueued.push(input);
    const current = this.schedules.get(claim.scheduleId);
    if (input.completeOnce && current?.revision === claim.scheduleRevision)
      current.state = "completed";
  }

  settleFireFailed(
    input: Parameters<SessionScheduleStorage["settleFireFailed"]>[0],
  ): void {
    const claim = this.pending.get(input.fireId);
    if (!claim) throw new Error("Fire is not pending.");
    this.pending.delete(input.fireId);
    this.failed.push(input);
    const current = this.schedules.get(claim.scheduleId);
    if (input.pauseSchedule && current?.revision === claim.scheduleRevision)
      current.state = "paused";
  }
}

function createClaim(
  entry: SessionSchedule,
  logicalFireAt: string,
  runNowRequestId = "",
  fireId?: string,
  idempotencyKey?: string,
): SessionScheduleFireClaim {
  const identity = `${entry.id}:${entry.revision}:${logicalFireAt}:${runNowRequestId}`;
  return {
    id: fireId ?? `fire:${identity}`,
    scheduleId: entry.id,
    sessionId: entry.sessionId,
    scheduleRevision: entry.revision,
    kind: runNowRequestId ? "run_now" : "scheduled",
    triggerKind: entry.trigger.type,
    logicalFireAt,
    enqueueIdempotencyKey: idempotencyKey ?? `schedule:${identity}`,
    turnSnapshot: { userMessage: `snapshot revision ${entry.revision}` },
  };
}

class FakeTimers {
  private nextId = 1;
  private readonly handles = new Map<number, FakeTimerHandle>();

  set(callback: () => void, delayMs: number): FakeTimerHandle {
    const handle = new FakeTimerHandle(this.nextId, callback, delayMs);
    this.nextId += 1;
    this.handles.set(handle.id, handle);
    return handle;
  }

  clear(value: SessionScheduleTimerHandle): void {
    const handle = value as FakeTimerHandle;
    handle.cleared = true;
  }

  active(): FakeTimerHandle[] {
    return [...this.handles.values()].filter(
      (handle) => !handle.cleared && !handle.fired,
    );
  }

  activeCount(): number {
    return this.active().length;
  }

  async fireNext(): Promise<void> {
    const handle = this.active()[0];
    assert.ok(handle, "an active timer is required");
    handle.fired = true;
    handle.callback();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

class FakeTimerHandle implements SessionScheduleTimerHandle {
  cleared = false;
  fired = false;

  constructor(
    readonly id: number,
    readonly callback: () => void,
    readonly delayMs: number,
  ) {}

  unref(): void {}
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition was not met");
}

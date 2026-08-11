import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import {
  SessionExecutionOwnerMismatchError,
  SessionExecutionService,
  type SessionExecutionDispatchResult,
} from "../../src-electron/session-execution-service.js";
import {
  SessionExecutionBusyError,
  SessionExecutionIdempotencyConflictError,
  SessionExecutionStateConflictError,
  SessionExecutionStorageV6,
} from "../../src-electron/session-execution-storage-v6.js";

const CREATED_AT = "2026-08-10T00:00:00.000Z";

type DeferredDispatch = {
  promise: Promise<SessionExecutionDispatchResult>;
  resolve(result: SessionExecutionDispatchResult): void;
  reject(error: Error): void;
};

async function createFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-session-execution-service-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    const insert = db.prepare(`
      INSERT INTO sessions_v6 (
        id,
        title,
        state,
        provider_id,
        catalog_revision,
        model_id,
        approval_mode,
        created_at,
        updated_at,
        last_active_at
      ) VALUES (?, ?, 'active', 'codex', 1, 'gpt-5', 'on-request', ?, ?, ?)
    `);
    insert.run("session-1", "Session 1", CREATED_AT, CREATED_AT, CREATED_AT);
    insert.run("session-2", "Session 2", CREATED_AT, CREATED_AT, CREATED_AT);
  } finally {
    db.close();
  }

  const storage = new SessionExecutionStorageV6(dbPath);
  const activeSessions = new Set<string>();
  const dispatches = new Map<string, DeferredDispatch>();
  const dispatchEvents: Array<{ executionId: string; persistedState: string | undefined }> = [];
  const canceledExecutions: string[] = [];
  let executionIndex = 0;
  let timestampIndex = 0;
  let validationError: Error | null = null;
  const service = new SessionExecutionService({
    storage,
    validateTurn(_sessionId, request) {
      if (validationError) {
        throw validationError;
      }
      if (typeof request !== "object" || request === null || !("userMessage" in request)) {
        throw new Error("invalid request");
      }
    },
    dispatchTurn(sessionId, executionId) {
      activeSessions.add(sessionId);
      dispatchEvents.push({ executionId, persistedState: storage.get(executionId)?.state });
      const deferred = createDeferredDispatch();
      dispatches.set(executionId, deferred);
      return deferred.promise.finally(() => {
        activeSessions.delete(sessionId);
      });
    },
    cancelRunningTurn(_sessionId, executionId) {
      canceledExecutions.push(executionId);
    },
    isSessionRunInFlight(sessionId) {
      return activeSessions.has(sessionId);
    },
    createExecutionId() {
      executionIndex += 1;
      return `execution-${executionIndex}`;
    },
    currentTimestamp() {
      timestampIndex += 1;
      return `2026-08-10T00:00:${String(timestampIndex).padStart(2, "0")}.000Z`;
    },
    resolveIdempotencyExpiresAt() {
      return "2026-08-11T00:00:00.000Z";
    },
  });

  return {
    directory,
    storage,
    service,
    dispatches,
    dispatchEvents,
    canceledExecutions,
    setValidationError(error: Error | null) {
      validationError = error;
    },
  };
}

function createInput(index: number, sessionId = "session-1") {
  return {
    sessionId,
    request: { userMessage: `message-${index}` },
    idempotencyKey: `key-${index}`,
    requestFingerprint: `fingerprint-${index}`,
  };
}

describe("SessionExecutionService", () => {
  it("I-01: canonical replayは現在のSession validationが失敗しても保存済みexecutionへ収束する", async () => {
    const fixture = await createFixture();
    try {
      const first = await fixture.service.run(createInput(1));
      const firstTerminal = fixture.service.waitForTerminal("session-1", first.id);
      fixture.dispatches.get(first.id)?.resolve({ state: "completed", result: { ok: true } });
      await firstTerminal;

      fixture.setValidationError(new Error("session became read-only"));
      const replay = await fixture.service.run(createInput(1));
      assert.equal(replay.id, first.id);
      assert.equal(replay.state, "completed");

      await assert.rejects(
        fixture.service.run({ ...createInput(1), requestFingerprint: "different" }),
        (error) => error instanceof SessionExecutionIdempotencyConflictError,
      );

      fixture.setValidationError(null);
      const enqueued = await fixture.service.enqueue(createInput(2, "session-2"));
      await waitFor(() => fixture.dispatches.has(enqueued.id));
      const enqueuedTerminal = fixture.service.waitForTerminal("session-2", enqueued.id);
      fixture.dispatches.get(enqueued.id)?.resolve({ state: "completed", result: null });
      await enqueuedTerminal;
      fixture.setValidationError(new Error("provider became unavailable"));
      const enqueueReplay = await fixture.service.enqueue(createInput(2, "session-2"));
      assert.equal(enqueueReplay.id, enqueued.id);
      assert.equal(enqueueReplay.state, "completed");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("E-01: 同一Sessionのturn.run競合をSESSION_BUSYで拒否し、暗黙にqueueへ変換しない", async () => {
    const fixture = await createFixture();
    try {
      const first = await fixture.service.run(createInput(1));
      assert.equal(first.state, "running");

      await assert.rejects(
        fixture.service.run(createInput(2)),
        (error) => error instanceof SessionExecutionBusyError && error.code === "SESSION_BUSY",
      );
      assert.equal(fixture.storage.listSessionExecutions("session-1").length, 1);

      fixture.dispatches.get(first.id)?.resolve({ state: "completed", result: { ok: true } });
      const completed = await fixture.service.waitForTerminal("session-1", first.id);
      assert.equal(completed.state, "completed");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("I-01: activeなturn.runのretryもcanonical executionへ収束する", async () => {
    const fixture = await createFixture();
    try {
      const first = await fixture.service.run(createInput(1));
      const replay = await fixture.service.run(createInput(1));

      assert.equal(replay.id, first.id);
      assert.equal(fixture.storage.listSessionExecutions("session-1").length, 1);

      fixture.dispatches.get(first.id)?.resolve({ state: "completed", result: null });
      await fixture.service.waitForTerminal("session-1", first.id);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("validation failureはexecutionとidempotency effectを作らない", async () => {
    const fixture = await createFixture();
    try {
      await assert.rejects(
        fixture.service.run({
          ...createInput(1),
          request: {},
        }),
        /invalid request/,
      );
      assert.equal(fixture.storage.listSessionExecutions("session-1").length, 0);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("E-02: enqueue commit後にrunningへ永続化してからFIFO順でdispatchする", async () => {
    const fixture = await createFixture();
    try {
      const first = await fixture.service.enqueue(createInput(1));
      const second = await fixture.service.enqueue(createInput(2));

      assert.equal(first.state, "queued");
      assert.equal(second.state, "queued");
      await waitFor(() => fixture.dispatchEvents.length === 1);
      assert.deepEqual(fixture.dispatchEvents[0], {
        executionId: first.id,
        persistedState: "running",
      });
      assert.equal(fixture.storage.get(second.id)?.state, "queued");

      fixture.dispatches.get(first.id)?.resolve({ state: "completed", result: { order: 1 } });
      await fixture.service.waitForTerminal("session-1", first.id);
      await waitFor(() => fixture.dispatchEvents.length === 2);
      assert.deepEqual(fixture.dispatchEvents[1], {
        executionId: second.id,
        persistedState: "running",
      });

      fixture.dispatches.get(second.id)?.resolve({ state: "completed", result: { order: 2 } });
      await fixture.service.waitForTerminal("session-1", second.id);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("C-01: queued cancelは対象Sessionとのownershipを検証してterminalへ遷移する", async () => {
    const fixture = await createFixture();
    try {
      const running = await fixture.service.run(createInput(1));
      const queued = await fixture.service.enqueue(createInput(2));

      await assert.rejects(
        fixture.service.cancel({
          sessionId: "session-2",
          executionId: queued.id,
          idempotencyKey: "cancel-wrong-owner",
          requestFingerprint: "cancel-wrong-owner-fingerprint",
        }),
        (error) => error instanceof SessionExecutionOwnerMismatchError
          && error.code === "EXECUTION_OWNER_MISMATCH",
      );
      const canceled = await fixture.service.cancel({
        sessionId: "session-1",
        executionId: queued.id,
        idempotencyKey: "cancel-queued",
        requestFingerprint: "cancel-queued-fingerprint",
      });
      assert.equal(canceled.state, "canceled");
      assert.equal(canceled.completedAt === null, false);
      const replay = await fixture.service.cancel({
        sessionId: "session-1",
        executionId: queued.id,
        idempotencyKey: "cancel-queued",
        requestFingerprint: "cancel-queued-fingerprint",
      });
      assert.equal(replay.id, canceled.id);
      assert.equal(replay.state, "canceled");

      fixture.dispatches.get(running.id)?.resolve({ state: "completed", result: null });
      await fixture.service.waitForTerminal("session-1", running.id);
      assert.equal(fixture.dispatchEvents.length, 1);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("C-01: running cancelはexecutionを変えずruntimeのabort境界へ渡す", async () => {
    const fixture = await createFixture();
    try {
      const running = await fixture.service.run(createInput(1));
      const cancelResult = await fixture.service.cancel({
        sessionId: "session-1",
        executionId: running.id,
        idempotencyKey: "cancel-running",
        requestFingerprint: "cancel-running-fingerprint",
      });

      assert.equal(cancelResult.state, "running");
      assert.deepEqual(fixture.canceledExecutions, [running.id]);

      const replay = await fixture.service.cancel({
        sessionId: "session-1",
        executionId: running.id,
        idempotencyKey: "cancel-running",
        requestFingerprint: "cancel-running-fingerprint",
      });
      assert.equal(replay.id, running.id);
      assert.deepEqual(fixture.canceledExecutions, [running.id]);

      fixture.dispatches.get(running.id)?.resolve({
        state: "canceled",
        result: null,
        reason: "user_requested",
      });
      const canceled = await fixture.service.waitForTerminal("session-1", running.id);
      assert.equal(canceled.state, "canceled");
      assert.equal(canceled.reason, "user_requested");
      const terminalReplay = await fixture.service.cancel({
        sessionId: "session-1",
        executionId: running.id,
        idempotencyKey: "cancel-running",
        requestFingerprint: "cancel-running-fingerprint",
      });
      assert.equal(terminalReplay.state, "canceled");
      assert.deepEqual(fixture.canceledExecutions, [running.id]);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("CANCEL-STATE-10: terminal executionへの新規cancelはidempotency effect前に拒否する", async () => {
    const fixture = await createFixture();
    try {
      const running = await fixture.service.run(createInput(1));
      fixture.dispatches.get(running.id)?.resolve({ state: "completed", result: null });
      await fixture.service.waitForTerminal("session-1", running.id);

      await assert.rejects(
        fixture.service.cancel({
          sessionId: "session-1",
          executionId: running.id,
          idempotencyKey: "cancel-after-completion",
          requestFingerprint: "cancel-after-completion-fingerprint",
        }),
        (error) => error instanceof SessionExecutionStateConflictError
          && error.state === "completed",
      );
      assert.equal(
        fixture.storage.resolveIdempotency(
          "turn.cancel",
          "cancel-after-completion",
          "cancel-after-completion-fingerprint",
        ),
        null,
      );
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("ID-02: 異なるSessionの同一cancel key競合は一方のabort effect前に拒否する", async () => {
    const fixture = await createFixture();
    try {
      const first = await fixture.service.run(createInput(1, "session-1"));
      const second = await fixture.service.run(createInput(2, "session-2"));

      const results = await Promise.allSettled([
        fixture.service.cancel({
          sessionId: "session-1",
          executionId: first.id,
          idempotencyKey: "shared-cancel-key",
          requestFingerprint: "cancel-first",
        }),
        fixture.service.cancel({
          sessionId: "session-2",
          executionId: second.id,
          idempotencyKey: "shared-cancel-key",
          requestFingerprint: "cancel-second",
        }),
      ]);

      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter(
        (result) => result.status === "rejected"
          && result.reason instanceof SessionExecutionIdempotencyConflictError,
      ).length, 1);
      assert.equal(fixture.canceledExecutions.length, 1);

      fixture.dispatches.get(first.id)?.resolve({ state: "completed", result: null });
      fixture.dispatches.get(second.id)?.resolve({ state: "completed", result: null });
      await Promise.all([
        fixture.service.waitForTerminal("session-1", first.id),
        fixture.service.waitForTerminal("session-2", second.id),
      ]);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("LC-01: shutdown開始後はrunning完了時にqueued executionをadmitしない", async () => {
    const fixture = await createFixture();
    try {
      const running = await fixture.service.enqueue(createInput(1));
      await waitFor(() => fixture.dispatchEvents.length === 1);
      const queued = await fixture.service.enqueue(createInput(2));
      assert.equal(fixture.storage.get(queued.id)?.state, "queued");

      fixture.service.beginShutdown();
      fixture.dispatches.get(running.id)?.resolve({ state: "completed", result: null });
      await fixture.service.waitForTerminal("session-1", running.id);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      assert.equal(fixture.dispatchEvents.length, 1);
      assert.equal(fixture.storage.get(queued.id)?.state, "queued");
      await fixture.service.resumeQueue("session-1");
      assert.equal(fixture.dispatchEvents.length, 1);
      assert.equal(fixture.storage.get(queued.id)?.state, "queued");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-ERROR-06: dispatch exceptionはstable PROVIDER_FAILUREへ収束する", async () => {
    const fixture = await createFixture();
    try {
      const running = await fixture.service.run(createInput(1));
      fixture.dispatches.get(running.id)?.reject(new Error("provider failed"));

      const failed = await fixture.service.waitForTerminal("session-1", running.id);

      assert.equal(failed.state, "failed");
      assert.equal(failed.errorCode, "PROVIDER_FAILURE");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("P-01: public projectionはrequestとstorage sequenceを公開しない", async () => {
    const fixture = await createFixture();
    try {
      const execution = await fixture.service.run(createInput(1));
      assert.equal("request" in execution, false);
      assert.equal("sequence" in execution, false);

      fixture.dispatches.get(execution.id)?.resolve({ state: "completed", result: null });
      await fixture.service.waitForTerminal("session-1", execution.id);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("E-03: restart reconciliationはrunningを再dispatchせずinterruptedへ収束してFIFOを再開する", async () => {
    const fixture = await createFixture();
    try {
      fixture.storage.enqueue({
        id: "pre-restart-1",
        sessionId: "session-1",
        request: { userMessage: "before restart" },
        idempotencyKey: "pre-restart-key-1",
        requestFingerprint: "pre-restart-fingerprint-1",
        createdAt: "2026-08-10T00:00:01.000Z",
        expiresAt: "2026-08-11T00:00:00.000Z",
      });
      fixture.storage.enqueue({
        id: "pre-restart-2",
        sessionId: "session-1",
        request: { userMessage: "after restart" },
        idempotencyKey: "pre-restart-key-2",
        requestFingerprint: "pre-restart-fingerprint-2",
        createdAt: "2026-08-10T00:00:02.000Z",
        expiresAt: "2026-08-11T00:00:00.000Z",
      });
      fixture.storage.admitNextQueued("session-1", "2026-08-10T00:00:03.000Z");

      const interrupted = await fixture.service.reconcileAfterRestart();

      assert.deepEqual(interrupted.map((execution) => execution.id), ["pre-restart-1"]);
      assert.equal(interrupted[0]?.state, "interrupted");
      assert.equal(interrupted[0]?.reason, "runtime_restarted");
      await waitFor(() => fixture.dispatchEvents.length === 1);
      assert.equal(fixture.dispatchEvents[0]?.executionId, "pre-restart-2");
      assert.equal(fixture.storage.get("pre-restart-2")?.state, "running");

      fixture.dispatches.get("pre-restart-2")?.resolve({ state: "completed", result: null });
      await fixture.service.waitForTerminal("session-1", "pre-restart-2");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});

function createDeferredDispatch(): DeferredDispatch {
  let resolve!: (result: SessionExecutionDispatchResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<SessionExecutionDispatchResult>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition was not met");
}

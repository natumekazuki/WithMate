import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { SessionExecutionStorageV6 } from "../../src-electron/session-execution-storage-v6.js";
import {
  TERMINAL_FAILURE_NOTIFICATION_CONTRACT_VERSION,
} from "../../src-electron/session-execution-turn-request.js";
import {
  deriveDeliveryIdentity,
  SessionTerminalFailureNotificationService,
} from "../../src-electron/session-terminal-failure-notification-service.js";
import { SessionTerminalFailureNotificationStorageV6 } from "../../src-electron/session-terminal-failure-notification-storage-v6.js";
import { projectTerminalFailureNotification } from "../../src/session-terminal-failure-notification.js";

const SOURCE_CREATED_AT = "2026-08-18T00:00:00.000Z";
const SOURCE_FAILED_AT = "2026-08-18T00:01:00.000Z";

async function createFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-terminal-notification-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    const insert = db.prepare(`
      INSERT INTO sessions_v6 (
        id, title, state, provider_id, catalog_revision, model_id,
        approval_mode, created_at, updated_at, last_active_at
      ) VALUES (?, ?, 'active', 'codex', 1, 'gpt-5', 'on-request', ?, ?, ?)
    `);
    insert.run("source-session", "Source", SOURCE_CREATED_AT, SOURCE_CREATED_AT, SOURCE_CREATED_AT);
    insert.run("target-session", "Target", SOURCE_CREATED_AT, SOURCE_CREATED_AT, SOURCE_CREATED_AT);
  } finally {
    db.close();
  }
  const executionStorage = new SessionExecutionStorageV6(dbPath);
  const request = {
    initiator: {
      kind: "session" as const,
      sessionId: "actor-session",
      character: { characterId: "actor", name: "Actor", iconFilePath: "C:/actor.png" },
    },
    catalogRevision: 1,
    terminalFailureNotification: {
      contractVersion: TERMINAL_FAILURE_NOTIFICATION_CONTRACT_VERSION,
      targetSessionId: "target-session",
      sourceSession: {
        kind: "session" as const,
        sessionId: "source-session",
        character: {
          characterId: "source-character",
          name: "Source Character",
          iconFilePath: "C:/private/source-icon.png",
        },
      },
    },
    turn: {
      provider: "codex",
      userMessage: "credential-secret user request",
      model: "gpt-5",
      reasoningEffort: "high",
      approvalMode: "on-request",
      codexSandboxMode: "workspace-write",
      attachments: [],
    },
  };
  executionStorage.startImmediate({
    id: "source-execution",
    sessionId: "source-session",
    request,
    idempotencyKey: "source-key",
    requestFingerprint: "source-fingerprint",
    createdAt: SOURCE_CREATED_AT,
    expiresAt: "2026-08-19T00:00:00.000Z",
  });
  executionStorage.completeRunning({
    executionId: "source-execution",
    state: "failed",
    result: { assistantText: "raw-result-secret", stack: "raw-stack-secret" },
    errorCode: "PROVIDER_FAILURE",
    reason: "session_runtime_failed",
    completedAt: SOURCE_FAILED_AT,
    expiresAt: "2026-08-19T00:01:00.000Z",
  });
  return {
    directory,
    dbPath,
    executionStorage,
    notificationStorage: new SessionTerminalFailureNotificationStorageV6(dbPath),
  };
}

describe("Session terminal failure notification", () => {
  it("TN-BOUND-08: startup候補は通知設定あり・delivery未作成だけを指定batchへ制限する", async () => {
    const fixture = await createFixture();
    try {
      const configuredRequest = fixture.executionStorage.get("source-execution")?.request;
      assert.ok(configuredRequest);
      fixture.executionStorage.startImmediate({
        id: "configured-second",
        sessionId: "source-session",
        request: configuredRequest,
        idempotencyKey: "configured-second-key",
        requestFingerprint: "configured-second-fingerprint",
        createdAt: "2026-08-18T00:01:02.000Z",
        expiresAt: "2026-08-19T00:01:02.000Z",
      });
      fixture.executionStorage.completeRunning({
        executionId: "configured-second",
        state: "interrupted",
        result: null,
        errorCode: "RUNTIME_INTERRUPTED",
        reason: "runtime_restarted",
        completedAt: "2026-08-18T00:02:00.000Z",
        expiresAt: "2026-08-19T00:02:00.000Z",
      });
      fixture.executionStorage.startImmediate({
        id: "legacy-failed",
        sessionId: "source-session",
        request: { turn: { userMessage: "legacy" } },
        idempotencyKey: "legacy-key",
        requestFingerprint: "legacy-fingerprint",
        createdAt: "2026-08-18T00:02:01.000Z",
        expiresAt: "2026-08-19T00:02:01.000Z",
      });
      fixture.executionStorage.completeRunning({
        executionId: "legacy-failed",
        state: "failed",
        result: null,
        errorCode: "PROVIDER_FAILURE",
        reason: "session_runtime_failed",
        completedAt: "2026-08-18T00:03:00.000Z",
        expiresAt: "2026-08-19T00:03:00.000Z",
      });

      assert.deepEqual(
        fixture.executionStorage.listTerminalFailureNotificationCandidates(1).map((execution) => execution.id),
        ["source-execution"],
      );
      const identity = deriveDeliveryIdentity({
        sourceExecutionId: "source-execution",
        terminalState: "failed",
        targetSessionId: "target-session",
      });
      fixture.notificationStorage.createPending({
        ...identity,
        sourceExecutionId: "source-execution",
        sourceSessionId: "source-session",
        terminalState: "failed",
        targetSessionId: "target-session",
        contractVersion: TERMINAL_FAILURE_NOTIFICATION_CONTRACT_VERSION,
        createdAt: SOURCE_FAILED_AT,
        deadlineAt: "2026-08-19T00:01:00.000Z",
      });
      assert.deepEqual(
        fixture.executionStorage.listTerminalFailureNotificationCandidates(10).map((execution) => execution.id),
        ["configured-second"],
      );
    } finally {
      fixture.notificationStorage.close();
      fixture.executionStorage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("TN-TERM-03/TN-PROMPT-05: terminal commit後だけsafe promptを既存enqueue境界へ渡す", async () => {
    const fixture = await createFixture();
    const prompts: string[] = [];
    try {
      const service = new SessionTerminalFailureNotificationService({
        storage: fixture.notificationStorage,
        executionStorage: fixture.executionStorage,
        now: () => new Date("2026-08-18T00:01:01.000Z"),
        enqueueTurn: async (input) => {
          assert.equal(fixture.executionStorage.get("source-execution")?.state, "failed");
          assert.equal(input.targetSessionId, "target-session");
          assert.equal(input.initiator.sessionId, "source-session");
          assert.equal(input.initiator.character.name, "Source Character");
          prompts.push(input.prompt);
          return { ok: true, executionId: "notification-execution" };
        },
      });

      await service.start();
      await service.shutdown();

      assert.equal(prompts.length, 1);
      assert.match(prompts[0]!, /source-session/);
      assert.match(prompts[0]!, /source-execution/);
      assert.match(prompts[0]!, /PROVIDER_FAILURE/);
      assert.doesNotMatch(prompts[0]!, /credential-secret|raw-result-secret|raw-stack-secret|private\/source-icon/i);
      const delivery = fixture.notificationStorage.getBySourceExecutionId("source-execution");
      assert.equal(delivery?.state, "enqueued");
      assert.equal(delivery?.notificationExecutionId, "notification-execution");
      assert.equal(delivery?.attemptCount, 1);
    } finally {
      fixture.notificationStorage.close();
      fixture.executionStorage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("TN-TERM-03: interrupted sourceもstartup reconciliationから配送する", async () => {
    const fixture = await createFixture();
    try {
      const request = fixture.executionStorage.get("source-execution")?.request;
      assert.ok(request);
      fixture.executionStorage.startImmediate({
        id: "interrupted-source",
        sessionId: "source-session",
        request,
        idempotencyKey: "interrupted-key",
        requestFingerprint: "interrupted-fingerprint",
        createdAt: "2026-08-18T00:01:02.000Z",
        expiresAt: "2026-08-19T00:01:02.000Z",
      });
      fixture.executionStorage.completeRunning({
        executionId: "interrupted-source",
        state: "interrupted",
        result: null,
        errorCode: "RUNTIME_INTERRUPTED",
        reason: "runtime_restarted",
        completedAt: "2026-08-18T00:02:00.000Z",
        expiresAt: "2026-08-19T00:02:00.000Z",
      });
      const prompts: string[] = [];
      const service = new SessionTerminalFailureNotificationService({
        storage: fixture.notificationStorage,
        executionStorage: fixture.executionStorage,
        now: () => new Date("2026-08-18T00:02:01.000Z"),
        enqueueTurn: async ({ prompt }) => {
          prompts.push(prompt);
          return { ok: true, executionId: `notification-${prompts.length}` };
        },
      });
      await service.start();
      await service.shutdown();

      assert.equal(fixture.notificationStorage.getBySourceExecutionId("interrupted-source")?.state, "enqueued");
      assert.match(prompts.join("\n"), /Terminal state: interrupted/);
    } finally {
      fixture.notificationStorage.close();
      fixture.executionStorage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("TN-DELIVERY-04: response lossと再起動retryは同じkeyで同じnotification executionへ収束する", async () => {
    const fixture = await createFixture();
    const keys: string[] = [];
    try {
      const first = new SessionTerminalFailureNotificationService({
        storage: fixture.notificationStorage,
        executionStorage: fixture.executionStorage,
        now: () => new Date("2026-08-18T00:01:01.000Z"),
        enqueueTurn: async ({ idempotencyKey }) => {
          keys.push(idempotencyKey);
          throw new Error("response lost after enqueue");
        },
      });
      await first.start();
      await first.shutdown();
      const pending = fixture.notificationStorage.getBySourceExecutionId("source-execution");
      assert.equal(pending?.state, "pending");
      assert.equal(pending?.attemptCount, 1);
      assert.equal(pending?.nextAttemptAt, "2026-08-18T00:01:06.000Z");

      const second = new SessionTerminalFailureNotificationService({
        storage: fixture.notificationStorage,
        executionStorage: fixture.executionStorage,
        now: () => new Date("2026-08-18T00:01:06.000Z"),
        enqueueTurn: async ({ idempotencyKey }) => {
          keys.push(idempotencyKey);
          return { ok: true, executionId: "notification-execution" };
        },
      });
      await second.start();
      await second.shutdown();

      assert.equal(keys.length, 2);
      assert.equal(keys[0], keys[1]);
      assert.equal(fixture.notificationStorage.getBySourceExecutionId("source-execution")?.notificationExecutionId,
        "notification-execution");
    } finally {
      fixture.notificationStorage.close();
      fixture.executionStorage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("TN-DELIVERY-04: target不存在はpermanent failed、期限切れはretryしない", async () => {
    const fixture = await createFixture();
    try {
      const service = new SessionTerminalFailureNotificationService({
        storage: fixture.notificationStorage,
        executionStorage: fixture.executionStorage,
        now: () => new Date("2026-08-18T00:01:01.000Z"),
        enqueueTurn: async () => ({ ok: false, errorCode: "SESSION_NOT_FOUND", retryable: false }),
      });
      await service.start();
      await service.shutdown();
      const delivery = fixture.notificationStorage.getBySourceExecutionId("source-execution");
      assert.equal(delivery?.state, "failed");
      assert.equal(delivery?.errorCode, "SESSION_NOT_FOUND");
      assert.equal(delivery?.notificationExecutionId, null);
    } finally {
      fixture.notificationStorage.close();
      fixture.executionStorage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("TN-DELIVERY-04: QUEUE_FULLは5秒から指数backoffし最大5分でdurable retryする", async () => {
    const fixture = await createFixture();
    const attemptTimes = [
      "2026-08-18T00:01:01.000Z", "2026-08-18T00:01:06.000Z",
      "2026-08-18T00:01:16.000Z", "2026-08-18T00:01:36.000Z",
      "2026-08-18T00:02:16.000Z", "2026-08-18T00:03:36.000Z",
      "2026-08-18T00:06:16.000Z", "2026-08-18T00:11:16.000Z",
    ];
    const expectedNextTimes = [
      "2026-08-18T00:01:06.000Z", "2026-08-18T00:01:16.000Z",
      "2026-08-18T00:01:36.000Z", "2026-08-18T00:02:16.000Z",
      "2026-08-18T00:03:36.000Z", "2026-08-18T00:06:16.000Z",
      "2026-08-18T00:11:16.000Z", "2026-08-18T00:16:16.000Z",
    ];
    try {
      for (let index = 0; index < attemptTimes.length; index += 1) {
        const service = new SessionTerminalFailureNotificationService({
          storage: fixture.notificationStorage,
          executionStorage: fixture.executionStorage,
          now: () => new Date(attemptTimes[index]!),
          enqueueTurn: async () => ({ ok: false, errorCode: "QUEUE_FULL", retryable: true }),
        });
        await service.start();
        await service.shutdown();
        assert.equal(
          fixture.notificationStorage.getBySourceExecutionId("source-execution")?.nextAttemptAt,
          expectedNextTimes[index],
        );
      }
      assert.equal(fixture.notificationStorage.getBySourceExecutionId("source-execution")?.attemptCount, 8);
    } finally {
      fixture.notificationStorage.close();
      fixture.executionStorage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("TN-DELIVERY-04: claim後crashとsettle失敗をstartup reconciliationが同じenqueue keyへ収束させる", async () => {
    const fixture = await createFixture();
    const identity = deriveDeliveryIdentity({
      sourceExecutionId: "source-execution",
      terminalState: "failed",
      targetSessionId: "target-session",
    });
    const keys: string[] = [];
    try {
      fixture.notificationStorage.createPending({
        ...identity,
        sourceExecutionId: "source-execution",
        sourceSessionId: "source-session",
        terminalState: "failed",
        targetSessionId: "target-session",
        contractVersion: TERMINAL_FAILURE_NOTIFICATION_CONTRACT_VERSION,
        createdAt: SOURCE_FAILED_AT,
        deadlineAt: "2026-08-19T00:01:00.000Z",
      });
      const claimed = fixture.notificationStorage.claimNextDue({
        now: "2026-08-18T00:01:01.000Z",
        claimToken: "crashed-process-claim",
      });
      assert.equal(claimed?.claimToken, "crashed-process-claim");

      const originalSettle = fixture.notificationStorage.settleEnqueued.bind(fixture.notificationStorage);
      const originalRelease = fixture.notificationStorage.releaseForRetry.bind(fixture.notificationStorage);
      let failSettleOnce = true;
      let failReleaseOnce = true;
      fixture.notificationStorage.settleEnqueued = ((input) => {
        if (failSettleOnce) {
          failSettleOnce = false;
          throw new Error("settle storage unavailable");
        }
        return originalSettle(input);
      }) as typeof fixture.notificationStorage.settleEnqueued;
      fixture.notificationStorage.releaseForRetry = ((input) => {
        if (failReleaseOnce) {
          failReleaseOnce = false;
          throw new Error("retry storage unavailable");
        }
        return originalRelease(input);
      }) as typeof fixture.notificationStorage.releaseForRetry;

      const first = new SessionTerminalFailureNotificationService({
        storage: fixture.notificationStorage,
        executionStorage: fixture.executionStorage,
        now: () => new Date("2026-08-18T00:01:02.000Z"),
        enqueueTurn: async ({ idempotencyKey }) => {
          keys.push(idempotencyKey);
          return { ok: true, executionId: "notification-execution" };
        },
      });
      await first.start();
      await first.shutdown();
      assert.equal(fixture.notificationStorage.getBySourceExecutionId("source-execution")?.state, "pending");

      const second = new SessionTerminalFailureNotificationService({
        storage: fixture.notificationStorage,
        executionStorage: fixture.executionStorage,
        now: () => new Date("2026-08-18T00:01:12.000Z"),
        enqueueTurn: async ({ idempotencyKey }) => {
          keys.push(idempotencyKey);
          return { ok: true, executionId: "notification-execution" };
        },
      });
      await second.start();
      await second.shutdown();

      assert.deepEqual(keys, [identity.enqueueIdempotencyKey, identity.enqueueIdempotencyKey]);
      assert.equal(fixture.notificationStorage.getBySourceExecutionId("source-execution")?.state, "enqueued");
    } finally {
      fixture.notificationStorage.close();
      fixture.executionStorage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("TN-CLAIM-10: settleとclaim releaseの二重一時失敗を同一processで再試行する", async () => {
    const fixture = await createFixture();
    const originalSettle = fixture.notificationStorage.settleEnqueued.bind(fixture.notificationStorage);
    const originalRelease = fixture.notificationStorage.releaseForRetry.bind(fixture.notificationStorage);
    let now = new Date("2026-08-18T00:01:02.000Z");
    let timerCallback: (() => void) | null = null;
    let failSettleOnce = true;
    let failReleaseOnce = true;
    const keys: string[] = [];
    try {
      fixture.notificationStorage.settleEnqueued = ((input) => {
        if (failSettleOnce) {
          failSettleOnce = false;
          throw new Error("settle storage unavailable");
        }
        return originalSettle(input);
      }) as typeof fixture.notificationStorage.settleEnqueued;
      fixture.notificationStorage.releaseForRetry = ((input) => {
        if (failReleaseOnce) {
          failReleaseOnce = false;
          throw new Error("retry storage unavailable");
        }
        return originalRelease(input);
      }) as typeof fixture.notificationStorage.releaseForRetry;

      const service = new SessionTerminalFailureNotificationService({
        storage: fixture.notificationStorage,
        executionStorage: fixture.executionStorage,
        now: () => now,
        enqueueTurn: async ({ idempotencyKey }) => {
          keys.push(idempotencyKey);
          return { ok: true, executionId: "notification-execution" };
        },
        setTimer(callback) {
          timerCallback = callback;
          return {};
        },
        clearTimer() {},
      });

      await service.start();
      assert.equal(fixture.notificationStorage.getBySourceExecutionId("source-execution")?.claimToken !== null, true);
      assert.ok(timerCallback);

      now = new Date("2026-08-18T00:01:07.000Z");
      timerCallback?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await service.shutdown();

      assert.equal(fixture.notificationStorage.getBySourceExecutionId("source-execution")?.state, "enqueued");
      assert.equal(keys.length, 2);
      assert.equal(keys[0], keys[1]);
    } finally {
      fixture.notificationStorage.close();
      fixture.executionStorage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("TN-DELIVERY-04: terminal確定から24時間で期限切れとなりenqueueしない", async () => {
    const fixture = await createFixture();
    let enqueueCount = 0;
    try {
      const service = new SessionTerminalFailureNotificationService({
        storage: fixture.notificationStorage,
        executionStorage: fixture.executionStorage,
        now: () => new Date("2026-08-19T00:01:00.000Z"),
        enqueueTurn: async () => {
          enqueueCount += 1;
          return { ok: true, executionId: "unexpected" };
        },
      });
      await service.start();
      await service.shutdown();
      assert.equal(enqueueCount, 0);
      assert.equal(
        fixture.notificationStorage.getBySourceExecutionId("source-execution")?.errorCode,
        "DELIVERY_DEADLINE_EXPIRED",
      );
    } finally {
      fixture.notificationStorage.close();
      fixture.executionStorage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("TN-PROJ-06: configured completed/canceledはnot_triggered、既存executionはnullになる", () => {
    const base = {
      id: "execution",
      sessionId: "source-session",
      operation: "turn.run" as const,
      result: null,
      errorCode: "",
      reason: "",
      createdAt: SOURCE_CREATED_AT,
      admittedAt: SOURCE_CREATED_AT,
      completedAt: SOURCE_FAILED_AT,
      updatedAt: SOURCE_FAILED_AT,
    };
    for (const state of ["completed", "canceled"] as const) {
      assert.equal(projectTerminalFailureNotification({
        execution: { ...base, state },
        targetSessionId: "target-session",
        delivery: null,
      })?.state, "not_triggered");
    }
    assert.equal(projectTerminalFailureNotification({
      execution: { ...base, state: "failed" },
      targetSessionId: null,
      delivery: null,
    }), null);
  });

  it("TN-SNAPSHOT-02: notification executionが失敗しても通知設定を推測せず再帰配送しない", async () => {
    const fixture = await createFixture();
    try {
      fixture.executionStorage.startImmediate({
        id: "notification-execution",
        sessionId: "target-session",
        request: {
          initiator: {
            kind: "session",
            sessionId: "source-session",
            character: { characterId: "source-character", name: "Source Character", iconFilePath: "" },
          },
          catalogRevision: 1,
          turn: {
            provider: "codex",
            userMessage: "safe notification prompt",
            model: "gpt-5",
            reasoningEffort: "high",
            approvalMode: "on-request",
            codexSandboxMode: "workspace-write",
            attachments: [],
          },
        },
        idempotencyKey: "notification-key",
        requestFingerprint: "notification-fingerprint",
        createdAt: "2026-08-18T00:01:02.000Z",
        expiresAt: "2026-08-19T00:01:02.000Z",
      });
      fixture.executionStorage.completeRunning({
        executionId: "notification-execution",
        state: "failed",
        result: null,
        errorCode: "PROVIDER_FAILURE",
        reason: "session_runtime_failed",
        completedAt: "2026-08-18T00:02:00.000Z",
        expiresAt: "2026-08-19T00:02:00.000Z",
      });
      const service = new SessionTerminalFailureNotificationService({
        storage: fixture.notificationStorage,
        executionStorage: fixture.executionStorage,
        now: () => new Date("2026-08-18T00:02:01.000Z"),
        enqueueTurn: async () => ({ ok: true, executionId: "notification-execution" }),
      });
      await service.start();
      await service.shutdown();

      assert.equal(fixture.notificationStorage.getBySourceExecutionId("source-execution")?.state, "enqueued");
      assert.equal(fixture.notificationStorage.getBySourceExecutionId("notification-execution"), null);
    } finally {
      fixture.notificationStorage.close();
      fixture.executionStorage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("TN-DELIVERY-04: shutdownはretry timerを解除しlate wakeを実行しない", async () => {
    const fixture = await createFixture();
    let enqueueCount = 0;
    let clearCount = 0;
    let timerCallback: (() => void) | null = null;
    const timerHandle = {};
    try {
      const service = new SessionTerminalFailureNotificationService({
        storage: fixture.notificationStorage,
        executionStorage: fixture.executionStorage,
        now: () => new Date("2026-08-18T00:01:01.000Z"),
        enqueueTurn: async () => {
          enqueueCount += 1;
          return { ok: false, errorCode: "QUEUE_FULL", retryable: true };
        },
        setTimer(callback) {
          timerCallback = callback;
          return timerHandle;
        },
        clearTimer(handle) {
          assert.equal(handle, timerHandle);
          clearCount += 1;
        },
      });
      await service.start();
      assert.equal(enqueueCount, 1);
      assert.ok(timerCallback);
      await service.shutdown();
      assert.equal(clearCount, 1);
      timerCallback?.();
      service.wake();
      await Promise.resolve();
      assert.equal(enqueueCount, 1);
    } finally {
      fixture.notificationStorage.close();
      fixture.executionStorage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("TN-DELIVERY-04: reconciliation storageの一時失敗はsourceを正本に同一processで再試行する", async () => {
    const fixture = await createFixture();
    const originalCreate = fixture.notificationStorage.createPending.bind(fixture.notificationStorage);
    let failCreateOnce = true;
    let now = new Date("2026-08-18T00:01:01.000Z");
    let timerCallback: (() => void) | null = null;
    const backgroundErrors: unknown[] = [];
    let enqueueResolved: (() => void) | null = null;
    const enqueued = new Promise<void>((resolve) => { enqueueResolved = resolve; });
    try {
      fixture.notificationStorage.createPending = ((input) => {
        if (failCreateOnce) {
          failCreateOnce = false;
          throw new Error("storage temporarily unavailable");
        }
        return originalCreate(input);
      }) as typeof fixture.notificationStorage.createPending;
      const service = new SessionTerminalFailureNotificationService({
        storage: fixture.notificationStorage,
        executionStorage: fixture.executionStorage,
        now: () => now,
        enqueueTurn: async () => {
          enqueueResolved?.();
          return { ok: true, executionId: "notification-execution" };
        },
        setTimer(callback) {
          timerCallback = callback;
          return {};
        },
        clearTimer() {},
        onBackgroundError(error) {
          backgroundErrors.push(error);
        },
      });

      await service.start();
      assert.equal(fixture.notificationStorage.getBySourceExecutionId("source-execution"), null);
      assert.ok(timerCallback);
      now = new Date("2026-08-18T00:01:06.000Z");
      timerCallback?.();
      await Promise.race([
        enqueued,
        new Promise<void>((_resolve, reject) => setTimeout(
          () => reject(new AggregateError(backgroundErrors, "notification retry did not enqueue")),
          1_000,
        )),
      ]);
      await service.shutdown();
      assert.equal(fixture.notificationStorage.getBySourceExecutionId("source-execution")?.state, "enqueued");
    } finally {
      fixture.notificationStorage.close();
      fixture.executionStorage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("TN-DELIVERY-04: terminal wakeの一時失敗はexecution IDを保持して再試行する", async () => {
    const fixture = await createFixture();
    const originalCreate = fixture.notificationStorage.createPending.bind(fixture.notificationStorage);
    let timerCallback: (() => void) | null = null;
    let timerArmedResolved: (() => void) | null = null;
    const timerArmed = new Promise<void>((resolve) => { timerArmedResolved = resolve; });
    let backgroundErrorResolved: (() => void) | null = null;
    const backgroundError = new Promise<void>((resolve) => { backgroundErrorResolved = resolve; });
    let wokenEnqueueResolved: (() => void) | null = null;
    const wokenEnqueued = new Promise<void>((resolve) => { wokenEnqueueResolved = resolve; });
    let enqueueCount = 0;
    try {
      const service = new SessionTerminalFailureNotificationService({
        storage: fixture.notificationStorage,
        executionStorage: fixture.executionStorage,
        now: () => new Date("2026-08-18T00:04:00.000Z"),
        enqueueTurn: async () => {
          enqueueCount += 1;
          if (enqueueCount === 2) wokenEnqueueResolved?.();
          return { ok: true, executionId: `notification-${enqueueCount}` };
        },
        setTimer(callback) {
          timerCallback = callback;
          timerArmedResolved?.();
          return {};
        },
        clearTimer() {},
        onBackgroundError() {
          backgroundErrorResolved?.();
        },
      });
      await service.start();

      const request = fixture.executionStorage.get("source-execution")?.request;
      assert.ok(request);
      fixture.executionStorage.startImmediate({
        id: "woken-source",
        sessionId: "source-session",
        request,
        idempotencyKey: "woken-source-key",
        requestFingerprint: "woken-source-fingerprint",
        createdAt: "2026-08-18T00:02:01.000Z",
        expiresAt: "2026-08-19T00:02:01.000Z",
      });
      fixture.executionStorage.completeRunning({
        executionId: "woken-source",
        state: "failed",
        result: null,
        errorCode: "PROVIDER_FAILURE",
        reason: "session_runtime_failed",
        completedAt: "2026-08-18T00:03:00.000Z",
        expiresAt: "2026-08-19T00:03:00.000Z",
      });

      let failCreateOnce = true;
      fixture.notificationStorage.createPending = ((input) => {
        if (input.sourceExecutionId === "woken-source" && failCreateOnce) {
          failCreateOnce = false;
          throw new Error("storage temporarily unavailable");
        }
        return originalCreate(input);
      }) as typeof fixture.notificationStorage.createPending;

      service.wake("woken-source");
      await backgroundError;
      await timerArmed;
      assert.equal(fixture.notificationStorage.getBySourceExecutionId("woken-source"), null);
      assert.ok(timerCallback);
      timerCallback?.();
      await Promise.race([
        wokenEnqueued,
        new Promise<void>((_resolve, reject) => setTimeout(
          () => reject(new Error("terminal wake retry did not enqueue")),
          1_000,
        )),
      ]);
      await service.shutdown();
      assert.equal(fixture.notificationStorage.getBySourceExecutionId("woken-source")?.state, "enqueued");
    } finally {
      fixture.notificationStorage.close();
      fixture.executionStorage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});

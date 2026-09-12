import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SessionLifecycleOperationRevisionConflictError, SessionLifecycleStorage } from "../../src-electron/session-lifecycle-storage.js";

async function withStorage(run: (storage: SessionLifecycleStorage, dbPath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-session-lifecycle-storage-"));
  const dbPath = path.join(directory, "withmate-v6.db");
  const storage = new SessionLifecycleStorage(dbPath);
  try {
    await run(storage, dbPath);
  } finally {
    try { storage.close(); } catch { /* already closed by reopen test */ }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await rm(directory, { recursive: true, force: true });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 19) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
}

// @test-value v2
// kind = "invariant"
// claim = "Session lifecycle operationのCAS失敗はprojectionとrecovery eventを変更しない"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/00-shared-authority-and-history.md#Direct validation" }
// fault = "stale revisionを受理して途中stepを二重保存する"
// observable = "operation revisionとpending event count"
// observation_boundary = "public-boundary"
// scope = "session-lifecycle-storage"
// lifecycle = "permanent"
// @end-test-value
test("stale lifecycle revisionはprojectionを変更せず、失敗payloadもrollbackする", async () => {
  await withStorage(async (storage) => {
    const operation = storage.prepare({
      operation: "session.archive",
      principalKind: "system",
      principalId: "test",
      idempotencyKey: "archive-1",
      requestFingerprint: "fingerprint-1",
      manifest: { sessionId: "session-1" },
    });
    const before = storage.replay(operation.operationId, "fingerprint-1");
    assert.throws(
      () => storage.recordStep({ operationId: operation.operationId, expectedRevision: 9, step: "db_committed", effect: "committed" }),
      (error) => error instanceof SessionLifecycleOperationRevisionConflictError
        && error.code === "SESSION_LIFECYCLE_OPERATION_REVISION_CONFLICT",
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.throws(() => storage.recordStep({
      operationId: operation.operationId,
      expectedRevision: 1,
      step: "filesystem",
      effect: "unknown",
      payload: circular,
    }));
    const replay = storage.replay(operation.operationId, "fingerprint-1");
    assert.deepEqual(replay, before);
    assert.equal(replay.operationId, operation.operationId);
    assert.equal(replay.requestFingerprint, "fingerprint-1");
    assert.deepEqual(storage.listEvents(operation.operationId).map((event) => event.revision), [1]);
  });
});

// @test-value v2
// kind = "invariant"
// claim = "再起動後も未完了 lifecycle operationは同じrevisionとeffectで回復対象になる"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/00-shared-authority-and-history.md#Mutation envelope" }
// fault = "process restart後にprepared operationをTTL cleanupまたは再採番で失う"
// observable = "reopen後のpending operation identityとrevision"
// observation_boundary = "public-boundary"
// scope = "session-lifecycle-storage"
// lifecycle = "permanent"
// @end-test-value
test("reopen後もpending operationを同じidentityで再取得できる", async () => {
  await withStorage(async (storage, dbPath) => {
    const operation = storage.prepare({
      operation: "session.move",
      principalKind: "system",
      principalId: "test",
      idempotencyKey: "move-1",
      requestFingerprint: "fingerprint-2",
      manifest: { sessionId: "session-1", destinationRootSessionId: "root-2" },
    });
    const before = storage.replay(operation.operationId, "fingerprint-2");
    storage.close();
    const reopened = new SessionLifecycleStorage(dbPath);
    try {
      const pending = reopened.listPending();
      assert.equal(pending.length, 1);
      assert.deepEqual(pending[0], before);
      assert.equal(pending[0].operationId, operation.operationId);
      assert.equal(reopened.replay(operation.operationId, "fingerprint-2").requestFingerprint, "fingerprint-2");
      reopened.verifyRecoveryRecords();
    } finally {
      reopened.close();
    }
  });
});

// @test-value v2
// kind = "invariant"
// claim = "破損したcurrent recovery projectionはstartup検証でfail closedになる"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/00-shared-authority-and-history.md#Event contract" }
// fault = "operation rowのeffectsをevent historyと異なる値へ書き換える"
// observable = "verifyRecoveryRecordsの検証エラー"
// observation_boundary = "public-boundary"
// scope = "session-lifecycle-storage"
// lifecycle = "permanent"
// @end-test-value
test("recovery projectionとevent historyの不一致を検出する", async () => {
  await withStorage(async (storage, dbPath) => {
    const operation = storage.prepare({
      operation: "session.restore",
      principalKind: "system",
      principalId: "test",
      idempotencyKey: "restore-1",
      requestFingerprint: "fingerprint-3",
      manifest: { sessionId: "session-1" },
    });
    storage.close();
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("UPDATE session_lifecycle_operations_v6 SET effects_json = ? WHERE operation_id = ?")
        .run(JSON.stringify({ filesystem: "committed" }), operation.operationId);
    } finally {
      db.close();
    }
    const sharedDb = new DatabaseSync(dbPath);
    try {
      assert.throws(() => new SessionLifecycleStorage(sharedDb), /effect does not match event history/);
    } finally {
      sharedDb.close();
    }
  });
});

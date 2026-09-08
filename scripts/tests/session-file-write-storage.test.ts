import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { SESSION_AUTHORITY_MAPPING_REVISION, type MutationAuthorityProof } from "../../src/session-authority.js";
import { buildNewSession } from "../../src/session-state.js";
import {
  SessionFileWriteIdempotencyConflictError,
  SessionStorageV6,
} from "../../src-electron/session-storage-v6.js";

function trustedFileWriteProof(sessionId: string): MutationAuthorityProof {
  return {
    principal: { kind: "system", service: "session-file-write-storage-test" },
    operation: "session.files.write_text",
    mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION,
    action: "session.files.write_text",
    resolvedScope: {
      resourceKind: "session_files",
      resourceId: sessionId,
      rootSessionId: sessionId,
      ownerKind: "session",
      ownerId: sessionId,
      relation: "self",
    },
    effectClass: "external_side_effect",
    grantId: null,
    grantRevision: null,
    evaluatedAt: "2026-08-12T00:00:00.000Z",
  };
}

const prepareFileWriteWithAuthority = SessionStorageV6.prototype.prepareSessionFileWrite;
SessionStorageV6.prototype.prepareSessionFileWrite = function (input) {
  return prepareFileWriteWithAuthority.call(this, {
    ...input,
    proof: input.proof ?? trustedFileWriteProof(input.sessionId),
  });
};
const recordPreparedFileWriteWithAuthority = SessionStorageV6.prototype.recordPreparedSessionFileWrite;
SessionStorageV6.prototype.recordPreparedSessionFileWrite = function (input) {
  return recordPreparedFileWriteWithAuthority.call(this, {
    ...input,
    proof: input.proof ?? trustedFileWriteProof("session-a"),
  });
};
const completeFileWriteWithAuthority = SessionStorageV6.prototype.completeSessionFileWrite;
SessionStorageV6.prototype.completeSessionFileWrite = function (input) {
  return completeFileWriteWithAuthority.call(this, {
    ...input,
    proof: input.proof ?? trustedFileWriteProof("session-a"),
  });
};
const rejectFileWriteWithAuthority = SessionStorageV6.prototype.rejectSessionFileWrite;
SessionStorageV6.prototype.rejectSessionFileWrite = function (input) {
  return rejectFileWriteWithAuthority.call(this, {
    ...input,
    proof: input.proof ?? trustedFileWriteProof("session-a"),
  });
};

describe("Session file write idempotency storage", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "file writeの再送はpendingの証跡と操作IDまたはterminal結果を保持し、期限後の新規受付は別操作IDになり、不一致のfingerprintやprepared proofは拒否される"
  // oracle = { type = "contract", ref = "docs/adr/030-root-resource-budget.md" }
  // fault = "再送で操作IDや結果が変わる、期限後の新規操作が古いIDを再利用する、または不一致の入力や証跡で既存操作が更新される"
  // observable = "実SQLite storageのprepare・complete・reject返却値、操作IDの同一性と相違、競合時の例外"
  // observation_boundary = "component-behavior"
  // scope = "session-file-write-idempotency"
  // lifecycle = "permanent"
  // @end-test-value
  it("SF-WRITE-01: pendingとappliedとrejectedを再生し、異なるfingerprintを拒否する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-file-write-storage-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    const storage = new SessionStorageV6(dbPath);
    try {
      const db = new DatabaseSync(dbPath);
      db.prepare(`
        INSERT INTO characters (id, name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run("character-a", "Character A", "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
      db.close();
      storage.insertSession(buildNewSession({
        id: "session-a",
        provider: "codex",
        catalogRevision: 1,
        taskTitle: "Session A",
        workspaceLabel: "SessionFolder",
        workspacePath: path.join(tempDirectory, "session-files", "session-a"),
        branch: "",
        characterId: "character-a",
        character: "Character A",
        approvalMode: DEFAULT_APPROVAL_MODE,
        codexSandboxMode: "workspace-write",
        model: "gpt-test",
        reasoningEffort: "high",
      }));

      const prepared = storage.prepareSessionFileWrite({
        idempotencyKey: "write-1",
        requestFingerprint: "fingerprint-1",
        sessionId: "session-a",
        relativePath: "notes/brief.md",
        tempName: ".withmate-write-temp-1",
        createdAt: "2026-08-12T00:00:00.000Z",
        expiresAt: "2026-08-13T00:00:00.000Z",
      });
      assert.deepEqual(prepared, {
        kind: "pending",
        operationId: prepared.operationId,
        sessionId: "session-a",
        relativePath: "notes/brief.md",
        tempName: ".withmate-write-temp-1",
        prepared: null,
        resumed: false,
      });
      assert.ok(prepared.operationId.length > 0);
      assert.deepEqual(storage.prepareSessionFileWrite({
        idempotencyKey: "write-1",
        requestFingerprint: "fingerprint-1",
        sessionId: "session-a",
        relativePath: "ignored-by-replay.md",
        tempName: "ignored-by-replay.tmp",
        createdAt: "2026-08-12T00:01:00.000Z",
        expiresAt: "2026-08-13T00:01:00.000Z",
      }), {
        ...prepared,
        resumed: true,
      });

      const preparedProof = {
        sha256: "a".repeat(64),
        byteLength: 5,
        device: "11",
        inode: "22",
        targetPrecondition: { kind: "absent" as const },
      };
      storage.recordPreparedSessionFileWrite({
        idempotencyKey: "write-1",
        requestFingerprint: "fingerprint-1",
        prepared: preparedProof,
      });
      assert.deepEqual(storage.prepareSessionFileWrite({
        idempotencyKey: "write-1",
        requestFingerprint: "fingerprint-1",
        sessionId: "session-a",
        relativePath: "ignored-by-replay.md",
        tempName: "ignored-by-replay.tmp",
        createdAt: "2026-08-12T00:01:00.000Z",
        expiresAt: "2026-08-13T00:01:00.000Z",
      }), {
        ...prepared,
        prepared: preparedProof,
        resumed: true,
      });
      assert.throws(
        () => storage.recordPreparedSessionFileWrite({
          idempotencyKey: "write-1",
          requestFingerprint: "fingerprint-1",
          prepared: { ...preparedProof, inode: "different" },
        }),
        /proof changed/,
      );

      const result = { file: { sessionId: "session-a", relativePath: "notes/brief.md", byteLength: 5 } };
      assert.throws(
        () => storage.completeSessionFileWrite({
          idempotencyKey: "write-1",
          requestFingerprint: "fingerprint-1",
          prepared: { ...preparedProof, device: "different" },
          result,
          completedAt: "2026-08-12T00:02:00.000Z",
          expiresAt: "2026-08-13T00:02:00.000Z",
        }),
        /does not match the prepared proof/,
      );
      assert.deepEqual(storage.completeSessionFileWrite({
        idempotencyKey: "write-1",
        requestFingerprint: "fingerprint-1",
        prepared: preparedProof,
        result,
        completedAt: "2026-08-12T00:02:00.000Z",
        expiresAt: "2026-08-13T00:02:00.000Z",
      }), result);
      assert.deepEqual(storage.prepareSessionFileWrite({
        idempotencyKey: "write-1",
        requestFingerprint: "fingerprint-1",
        sessionId: "session-a",
        relativePath: "notes/brief.md",
        tempName: ".withmate-write-temp-1",
        createdAt: "2026-08-12T00:02:00.000Z",
        expiresAt: "2026-08-13T00:02:00.000Z",
      }), {
        kind: "replay",
        operationId: prepared.operationId,
        sessionId: "session-a",
        relativePath: "notes/brief.md",
        tempName: ".withmate-write-temp-1",
        prepared: preparedProof,
        result,
      });
      assert.equal(storage.cleanupAppliedSessionFileWriteIdempotency("2026-08-13T00:13:01.000Z"), 1);
      const freshOperation = storage.prepareSessionFileWrite({
        idempotencyKey: "write-1",
        requestFingerprint: "fingerprint-1",
        sessionId: "session-a",
        relativePath: "notes/brief.md",
        tempName: ".withmate-write-temp-fresh",
        createdAt: "2026-08-13T00:14:00.000Z",
        expiresAt: "2026-08-14T00:01:00.000Z",
      });
      assert.equal(freshOperation.kind, "pending");
      assert.ok(freshOperation.operationId.length > 0);
      assert.notEqual(freshOperation.operationId, prepared.operationId);
      assert.throws(
        () => storage.prepareSessionFileWrite({
          idempotencyKey: "write-1",
          requestFingerprint: "different",
          sessionId: "session-a",
          relativePath: "notes/other.md",
          tempName: ".withmate-write-temp-2",
          createdAt: "2026-08-12T00:03:00.000Z",
          expiresAt: "2026-08-13T00:03:00.000Z",
        }),
        SessionFileWriteIdempotencyConflictError,
      );

      const rejectedPrepared = storage.prepareSessionFileWrite({
        idempotencyKey: "write-rejected",
        requestFingerprint: "fingerprint-rejected",
        sessionId: "session-a",
        relativePath: "existing.md",
        tempName: ".withmate-write-rejected",
        createdAt: "2026-08-12T00:03:00.000Z",
        expiresAt: "2026-08-13T00:03:00.000Z",
      });
      const canonicalError = {
        code: "FILE_ALREADY_EXISTS",
        message: "The Session file already exists and replace was not enabled.",
        retryable: false,
        details: { relativePath: "existing.md" },
        effect: "not_applied",
      };
      assert.deepEqual(storage.rejectSessionFileWrite({
        idempotencyKey: "write-rejected",
        requestFingerprint: "fingerprint-rejected",
        error: canonicalError,
        completedAt: "2026-08-12T00:04:00.000Z",
        expiresAt: "2026-08-13T00:04:00.000Z",
      }), canonicalError);
      const rejectedReplay = storage.prepareSessionFileWrite({
        idempotencyKey: "write-rejected",
        requestFingerprint: "fingerprint-rejected",
        sessionId: "session-a",
        relativePath: "ignored.md",
        tempName: "ignored.tmp",
        createdAt: "2026-08-12T00:05:00.000Z",
        expiresAt: "2026-08-13T00:05:00.000Z",
      });
      assert.deepEqual(rejectedReplay, {
        kind: "rejected",
        operationId: rejectedPrepared.operationId,
        sessionId: "session-a",
        relativePath: "existing.md",
        tempName: ".withmate-write-rejected",
        prepared: null,
        error: canonicalError,
      });
    } finally {
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("SF-WRITE-02: cleanupはterminal resultだけを期限切れにし、pendingはretry可能に保つ", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-file-write-cleanup-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    const storage = new SessionStorageV6(dbPath);
    try {
      const db = new DatabaseSync(dbPath);
      db.prepare(`
        INSERT INTO characters (id, name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run("character-a", "Character A", "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
      db.close();
      storage.insertSession(buildNewSession({
        id: "session-a",
        provider: "codex",
        catalogRevision: 1,
        taskTitle: "Session A",
        workspaceLabel: "SessionFolder",
        workspacePath: tempDirectory,
        branch: "",
        characterId: "character-a",
        character: "Character A",
        approvalMode: DEFAULT_APPROVAL_MODE,
        codexSandboxMode: "workspace-write",
        model: "gpt-test",
        reasoningEffort: "high",
      }));
      for (const key of ["pending", "applied", "rejected"] as const) {
        storage.prepareSessionFileWrite({
          idempotencyKey: key,
          requestFingerprint: key,
          sessionId: "session-a",
          relativePath: `${key}.md`,
          tempName: `.${key}.tmp`,
          createdAt: "2026-08-10T00:00:00.000Z",
          expiresAt: "2026-08-11T00:00:00.000Z",
        });
      }
      const appliedProof = {
        sha256: "b".repeat(64),
        byteLength: 1,
        device: "1",
        inode: "2",
        targetPrecondition: { kind: "absent" as const },
      };
      storage.recordPreparedSessionFileWrite({
        idempotencyKey: "applied",
        requestFingerprint: "applied",
        prepared: appliedProof,
      });
      storage.completeSessionFileWrite({
        idempotencyKey: "applied",
        requestFingerprint: "applied",
        prepared: appliedProof,
        result: { ok: true },
        completedAt: "2026-08-12T00:00:00.000Z",
        expiresAt: "2026-08-13T00:00:00.000Z",
      });
      storage.rejectSessionFileWrite({
        idempotencyKey: "rejected",
        requestFingerprint: "rejected",
        error: { code: "FILE_ALREADY_EXISTS" },
        completedAt: "2026-08-12T00:00:00.000Z",
        expiresAt: "2026-08-13T00:00:00.000Z",
      });

      assert.equal(storage.cleanupAppliedSessionFileWriteIdempotency("2026-08-12T00:00:00.000Z"), 0);
      assert.equal(storage.cleanupAppliedSessionFileWriteIdempotency("2026-08-13T00:00:00.000Z"), 2);
      assert.equal(storage.prepareSessionFileWrite({
        idempotencyKey: "pending",
        requestFingerprint: "pending",
        sessionId: "session-a",
        relativePath: "pending.md",
        tempName: ".pending.tmp",
        createdAt: "2026-08-12T00:00:00.000Z",
        expiresAt: "2026-08-13T00:00:00.000Z",
      }).kind, "pending");
    } finally {
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "同じrequest fingerprintを持つ別idempotency keyのwrite prepareは、別operationとしてprojection・resource event・共通headerへ一対一で永続化される"
  // oracle = { type = "contract", ref = "HISTORY-04 / MUTATION-05" }
  // failure_mode = "request fingerprintだけでoperation identityを作り、同内容の別writeが履歴UNIQUE制約で失敗するか同一operationへ合流する"
  // scope = "SessionStorageV6 file-write admission transaction"
  // lifecycle = "permanent"
  // distinction = "同一key replayではなく、payloadが同一でも独立した二つのidempotency operationを観測する"
  // @end-test-value
  it("同内容の別idempotency operationを独立した履歴として保存する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-file-write-history-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    const storage = new SessionStorageV6(dbPath);
    try {
      const setupDb = new DatabaseSync(dbPath);
      setupDb.prepare(`
        INSERT INTO characters (id, name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run("character-a", "Character A", "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
      setupDb.close();
      storage.insertSession(buildNewSession({
        id: "session-a",
        provider: "codex",
        catalogRevision: 1,
        taskTitle: "Session A",
        workspaceLabel: "SessionFolder",
        workspacePath: tempDirectory,
        branch: "",
        characterId: "character-a",
        character: "Character A",
        approvalMode: DEFAULT_APPROVAL_MODE,
        codexSandboxMode: "workspace-write",
        model: "gpt-test",
        reasoningEffort: "high",
      }));

      for (const key of ["same-content-a", "same-content-b"]) {
        storage.prepareSessionFileWrite({
          idempotencyKey: key,
          requestFingerprint: "same-request-fingerprint",
          sessionId: "session-a",
          relativePath: "same.md",
          tempName: `.${key}.tmp`,
          createdAt: "2026-08-12T00:00:00.000Z",
          expiresAt: "2026-08-13T00:00:00.000Z",
        });
      }

      const db = new DatabaseSync(dbPath);
      try {
        const projections = db.prepare(`
          SELECT operation_id
          FROM session_file_write_idempotency_v6
          WHERE idempotency_key IN ('same-content-a', 'same-content-b')
          ORDER BY idempotency_key
        `).all() as Array<{ operation_id: string }>;
        assert.equal(projections.length, 2);
        assert.notEqual(projections[0]?.operation_id, projections[1]?.operation_id);
        for (const { operation_id: operationId } of projections) {
          assert.deepEqual({ ...db.prepare(`
            SELECT event.event_kind, header.principal_kind, header.effect
            FROM session_file_write_events_v6 AS event
            INNER JOIN resource_event_headers_v6 AS header ON header.event_id = event.event_id
            WHERE event.operation_id = ?
          `).get(operationId) as Record<string, unknown> }, {
            event_kind: "prepared",
            principal_kind: "system",
            effect: "none",
          });
        }
      } finally {
        db.close();
      }
    } finally {
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});

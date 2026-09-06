import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { SESSION_AUTHORITY_MAPPING_REVISION, type MutationAuthorityProof } from "../../src/session-authority.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import {
  CREATE_V6_SESSION_TRANSCRIPT_EXPORT_IDEMPOTENCY_TABLE_SQL,
  ensureV6Schema,
} from "../../src-electron/database-schema-v6.js";
import {
  SessionTranscriptIdempotencyConflictError,
  SessionTranscriptStorageV6,
} from "../../src-electron/session-transcript-storage-v6.js";
import { insertStandaloneRoleBindingsForSessions } from "./session-role-binding-fixture.js";

const NOW = "2026-08-13T00:00:00.000Z";
const EXPIRES = "2026-08-14T00:00:00.000Z";

function trustedTranscriptProof(sessionId: string): MutationAuthorityProof {
  return {
    principal: { kind: "system", service: "session-transcript-storage-test" },
    operation: "transcript.export",
    mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION,
    action: "transcript.export",
    resolvedScope: {
      resourceKind: "transcript",
      resourceId: sessionId,
      rootSessionId: sessionId,
      ownerKind: "session",
      ownerId: sessionId,
      relation: "self",
    },
    effectClass: "external_side_effect",
    grantId: null,
    grantRevision: null,
    evaluatedAt: NOW,
  };
}

const prepareExportWithAuthority = SessionTranscriptStorageV6.prototype.prepareExport;
SessionTranscriptStorageV6.prototype.prepareExport = function (input) {
  return prepareExportWithAuthority.call(this, {
    ...input,
    proof: input.proof ?? trustedTranscriptProof(input.sessionId),
  });
};
const recordPreparedExportWithAuthority = SessionTranscriptStorageV6.prototype.recordPreparedOutput;
SessionTranscriptStorageV6.prototype.recordPreparedOutput = function (input) {
  return recordPreparedExportWithAuthority.call(this, {
    ...input,
    proof: input.proof ?? trustedTranscriptProof("session-1"),
  });
};
const completeExportWithAuthority = SessionTranscriptStorageV6.prototype.completeExport;
SessionTranscriptStorageV6.prototype.completeExport = function (input) {
  return completeExportWithAuthority.call(this, {
    ...input,
    proof: input.proof ?? trustedTranscriptProof("session-1"),
  });
};
const rejectExportWithAuthority = SessionTranscriptStorageV6.prototype.rejectExport;
SessionTranscriptStorageV6.prototype.rejectExport = function (input) {
  return rejectExportWithAuthority.call(this, {
    ...input,
    proof: input.proof ?? trustedTranscriptProof("session-1"),
  });
};

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-transcript-storage-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      INSERT INTO sessions_v6 (
        id, title, state, session_kind, provider_id, catalog_revision, model_id,
        approval_mode, created_at, updated_at, last_active_at
      ) VALUES ('session-1', 'Session 1', 'active', 'default', 'codex', 1, 'gpt-5',
        'on-request', ?, ?, ?)
    `).run(NOW, NOW, NOW);
    insertStandaloneRoleBindingsForSessions(db);
    db.prepare(`
      INSERT INTO session_turns_v6 (
        session_id, phase, started_at, completed_at, updated_at
      ) VALUES ('session-1', 'completed', ?, ?, ?)
    `).run(NOW, NOW, NOW);
    db.prepare(`
      INSERT INTO session_executions_v6 (
        id, session_id, operation, state, request_json,
        created_at, admitted_at, completed_at, updated_at
      ) VALUES ('execution-1', 'session-1', 'turn.run', 'completed', '{}', ?, ?, ?, ?)
    `).run(NOW, NOW, NOW, NOW);
  } finally {
    db.close();
  }
  return { directory, dbPath, storage: new SessionTranscriptStorageV6(dbPath) };
}

describe("SessionTranscriptStorageV6", () => {
  it("EXT-TRANSCRIPT-13: public turn contextをturn/session/execution tupleへ固定してlegacy推測を避ける", async () => {
    const f = await fixture();
    try {
      f.storage.upsertPublicTurnContext({
        turnId: 1,
        sessionId: "session-1",
        executionId: "execution-1",
        effectiveOptions: {
          provider: "codex",
          model: "gpt-5",
          reasoningEffort: "high",
          approvalMode: "on-request",
          sandboxMode: "workspace-write",
          customAgentName: null,
        },
        attachments: [{ kind: "file", relativePath: "brief.md" }],
        createdAt: NOW,
        updatedAt: NOW,
      });
      const projection = f.storage.readBaseProjection("session-1");
      assert.equal(projection?.legacyTurns.length, 0);
      assert.deepEqual(projection?.publicTurns[0], {
        sequence: 1,
        projectionCompleteness: "complete",
        executionId: "execution-1",
        state: "completed",
        effectiveOptions: {
          provider: "codex",
          model: "gpt-5",
          reasoningEffort: "high",
          approvalMode: "on-request",
          sandboxMode: "workspace-write",
          customAgentName: null,
        },
        attachments: [{ kind: "file", relativePath: "brief.md" }],
        progress: null,
        toolEvents: [],
        startedAt: NOW,
        completedAt: NOW,
      });
      assert.throws(
        () => f.storage.upsertPublicTurnContext({
          turnId: 1,
          sessionId: "session-1",
          executionId: "execution-other",
          effectiveOptions: {
            provider: "codex",
            model: "gpt-5",
            reasoningEffort: "high",
            approvalMode: "on-request",
            sandboxMode: "workspace-write",
            customAgentName: null,
          },
          attachments: [],
          createdAt: NOW,
          updatedAt: NOW,
        }),
        /owner tuple/,
      );
    } finally {
      f.storage.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("EXT-TRANSCRIPT-13: Copilot effective turnはcustom agentを保持してCodex sandboxを投影しない", async () => {
    const f = await fixture();
    try {
      f.storage.upsertPublicTurnContext({
        turnId: 1,
        sessionId: "session-1",
        executionId: "execution-1",
        effectiveOptions: {
          provider: "copilot",
          model: "claude-sonnet-4.5",
          reasoningEffort: "medium",
          approvalMode: "on-request",
          sandboxMode: null,
          customAgentName: "reviewer",
        },
        attachments: [],
        createdAt: NOW,
        updatedAt: NOW,
      });

      assert.deepEqual(f.storage.readBaseProjection("session-1")?.publicTurns[0]?.effectiveOptions, {
        provider: "copilot",
        model: "claude-sonnet-4.5",
        reasoningEffort: "medium",
        approvalMode: "on-request",
        sandboxMode: null,
        customAgentName: "reviewer",
      });
    } finally {
      f.storage.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "transcript exportはprepared proofとterminal resultをidempotency ledgerとresource eventへ一致して保存し、startupで改変ledgerを拒否する"
  // oracle = { type = "contract", ref = "AUTONOMY-HISTORY-04/AUTONOMY-MUTATION-05" }
  // failure_mode = "出力identityの異なる完了を受理するか、eventと異なるresult_jsonをretry結果として返せる"
  // scope = "SessionTranscriptStorageV6 export idempotency replay"
  // lifecycle = "permanent"
  // distinction = "prepared outputの一致、正常retry、fingerprint conflictに加え、terminal eventを保ったままledger resultだけを改変してstartup拒否を観測する"
  // @end-test-value
  it("EXT-EXPORT-14: pending output hashを固定しapplied/rejected replayとconflictを表す", async () => {
    const f = await fixture();
    try {
      const prepared = f.storage.prepareExport({
        idempotencyKey: "export-1",
        requestFingerprint: "fingerprint-1",
        sessionId: "session-1",
        relativePath: "transcript.json",
        tempName: ".transcript.tmp",
        createdAt: NOW,
        expiresAt: EXPIRES,
      });
      assert.equal(prepared.kind, "pending");
      f.storage.recordPreparedOutput({
        idempotencyKey: "export-1",
        requestFingerprint: "fingerprint-1",
        outputSha256: "a".repeat(64),
        byteLength: 42,
        outputDevice: "11",
        outputInode: "22",
        targetPrecondition: { kind: "absent" },
      });
      const resumed = f.storage.prepareExport({
        idempotencyKey: "export-1",
        requestFingerprint: "fingerprint-1",
        sessionId: "session-1",
        relativePath: "ignored.json",
        tempName: ".ignored.tmp",
        createdAt: NOW,
        expiresAt: EXPIRES,
      });
      assert.deepEqual(resumed, {
        kind: "pending",
        sessionId: "session-1",
        relativePath: "transcript.json",
        tempName: ".transcript.tmp",
        outputSha256: "a".repeat(64),
        byteLength: 42,
        outputDevice: "11",
        outputInode: "22",
        targetPrecondition: { kind: "absent" },
        resumed: true,
      });
      const result = { destination: "session_folder", file: { relativePath: "transcript.json" } };
      assert.deepEqual(f.storage.completeExport({
        idempotencyKey: "export-1",
        requestFingerprint: "fingerprint-1",
        outputSha256: "a".repeat(64),
        byteLength: 42,
        outputDevice: "11",
        outputInode: "22",
        targetPrecondition: { kind: "absent" },
        result,
        completedAt: NOW,
        expiresAt: EXPIRES,
      }), result);
      assert.deepEqual(f.storage.prepareExport({
        idempotencyKey: "export-1",
        requestFingerprint: "fingerprint-1",
        sessionId: "session-1",
        relativePath: "transcript.json",
        tempName: ".transcript.tmp",
        createdAt: NOW,
        expiresAt: EXPIRES,
      }), {
        kind: "replay",
        sessionId: "session-1",
        relativePath: "transcript.json",
        tempName: ".transcript.tmp",
        outputSha256: "a".repeat(64),
        byteLength: 42,
        outputDevice: "11",
        outputInode: "22",
        targetPrecondition: { kind: "absent" },
        result,
      });
      assert.throws(
        () => f.storage.prepareExport({
          idempotencyKey: "export-1",
          requestFingerprint: "different",
          sessionId: "session-1",
          relativePath: "different.json",
          tempName: ".different.tmp",
          createdAt: NOW,
          expiresAt: EXPIRES,
        }),
        SessionTranscriptIdempotencyConflictError,
      );
      const replayDb = new DatabaseSync(f.dbPath);
      try {
        replayDb.prepare(`
          UPDATE session_transcript_export_idempotency_v6
          SET result_json = json_object('destination', 'tampered')
          WHERE idempotency_key = 'export-1'
        `).run();
        assert.throws(
          () => ensureV6Schema(replayDb),
          /idempotency replay does not match its resource history/,
        );
      } finally {
        replayDb.close();
      }
    } finally {
      f.storage.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "削除可能なterminal root Sessionをtombstone化してもtranscript export idempotency recordをretention中保持する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#Session 削除" }
  // failure_mode = "Session削除のcascadeでtranscript export ledgerが失われ、同じidempotency keyの再送判定ができなくなる"
  // scope = "SessionTranscriptStorageV6 Session tombstone retention"
  // lifecycle = "permanent"
  // distinction = "populated schema repair後に正式なexport保存経路でledgerを作り、Session projectionのtombstone後も同じrowが残ることをFK境界で観測する"
  // @end-test-value
  it("EXT-EXPORT-14: populated V6へadditive再適用しSession tombstone後もexport recordを保持する", async () => {
    const f = await fixture();
    f.storage.close();
    try {
      const db = new DatabaseSync(f.dbPath);
      try {
        db.exec("PRAGMA foreign_keys = ON;");
        db.exec("DROP TABLE session_transcript_export_idempotency_v6;");
        ensureV6Schema(db);
        ensureV6Schema(db);
        const schema = db.prepare(`
          SELECT sql FROM sqlite_schema
          WHERE type = 'table' AND name = 'session_transcript_export_idempotency_v6'
        `).get() as { sql: string };
        assert.equal(schema.sql.includes("state IN ('pending', 'applied', 'rejected')"), true);
        assert.equal(CREATE_V6_SESSION_TRANSCRIPT_EXPORT_IDEMPOTENCY_TABLE_SQL.includes("output_sha256"), true);
      } finally {
        db.close();
      }
      const transcriptStorage = new SessionTranscriptStorageV6(f.dbPath);
      try {
        transcriptStorage.prepareExport({
          idempotencyKey: "pending",
          requestFingerprint: "fp",
          sessionId: "session-1",
          relativePath: "a.json",
          tempName: ".a.tmp",
          createdAt: NOW,
          expiresAt: EXPIRES,
          proof: trustedTranscriptProof("session-1"),
        });
      } finally {
        transcriptStorage.close();
      }
      const tombstoneDb = new DatabaseSync(f.dbPath);
      try {
        tombstoneDb.prepare("UPDATE sessions_v6 SET deleted_at = ? WHERE id = 'session-1'").run(NOW);
      } finally {
        tombstoneDb.close();
      }
      const resultDb = new DatabaseSync(f.dbPath);
      try {
        const count = resultDb.prepare(`
          SELECT COUNT(*) AS count FROM session_transcript_export_idempotency_v6
        `).get() as { count: number };
        assert.equal(count.count, 1);
        assert.equal(
          (resultDb.prepare("SELECT COUNT(*) AS count FROM sessions_v6 WHERE id = 'session-1' AND deleted_at IS NOT NULL")
            .get() as { count: number }).count,
          1,
        );
      } finally {
        resultDb.close();
      }
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  });
});

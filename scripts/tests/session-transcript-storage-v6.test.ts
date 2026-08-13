import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import {
  CREATE_V6_SESSION_TRANSCRIPT_EXPORT_IDEMPOTENCY_TABLE_SQL,
  ensureV6Schema,
} from "../../src-electron/database-schema-v6.js";
import {
  SessionTranscriptIdempotencyConflictError,
  SessionTranscriptStorageV6,
} from "../../src-electron/session-transcript-storage-v6.js";

const NOW = "2026-08-13T00:00:00.000Z";
const EXPIRES = "2026-08-14T00:00:00.000Z";

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
        resumed: true,
      });
      const result = { destination: "session_folder", file: { relativePath: "transcript.json" } };
      assert.deepEqual(f.storage.completeExport({
        idempotencyKey: "export-1",
        requestFingerprint: "fingerprint-1",
        outputSha256: "a".repeat(64),
        byteLength: 42,
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
      }), { kind: "replay", result });
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
    } finally {
      f.storage.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("EXT-EXPORT-14: populated V6へadditive再適用しSession削除でexport recordをcascadeする", async () => {
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
        db.prepare(`
          INSERT INTO session_transcript_export_idempotency_v6 (
            operation, idempotency_key, request_fingerprint, session_id,
            relative_path, temp_name, state, created_at, expires_at
          ) VALUES ('transcript.export', 'pending', 'fp', 'session-1', 'a.json', '.a.tmp', 'pending', ?, ?)
        `).run(NOW, EXPIRES);
        db.prepare("DELETE FROM sessions_v6 WHERE id = 'session-1'").run();
        const count = db.prepare(`
          SELECT COUNT(*) AS count FROM session_transcript_export_idempotency_v6
        `).get() as { count: number };
        assert.equal(count.count, 0);
      } finally {
        db.close();
      }
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  });
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { AuditLogStorageV6 } from "../../src-electron/audit-log-storage-v6.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";
import { buildNewSession } from "../../src/session-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";

async function removeDirectoryWithRetry(targetPath: string, attempts = 5): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const isBusyError = typeof error === "object" && error !== null && "code" in error && error.code === "EBUSY";
      if (!isBusyError || index === attempts - 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (index + 1)));
    }
  }
}

function insertCharacter(db: DatabaseSync, id: string): void {
  db.prepare(`
    INSERT INTO characters (id, name, created_at, updated_at)
    VALUES (?, ?, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
  `).run(id, id);
}

function insertSession(db: DatabaseSync, id: string, characterId: string | null, sessionKind = "default"): void {
  db.prepare(`
    INSERT INTO sessions_v6 (
      id, title, state, session_kind, provider_id, catalog_revision, model_id,
      reasoning_effort, approval_mode, character_id, character_snapshot_json,
      created_at, updated_at, last_active_at
    ) VALUES (?, ?, 'active', ?, 'codex', 1, 'gpt-5.4', 'medium', 'untrusted', ?, ?, ?, ?, ?)
  `).run(
    id,
    id,
    sessionKind,
    characterId,
    characterId ? "{}" : null,
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z",
  );
  if (sessionKind === "default") {
    db.prepare(`
      INSERT INTO session_role_bindings_v6 (
        session_id,
        session_role,
        role_contract_revision,
        root_session_id,
        parent_session_id,
        delegation_depth
      ) VALUES (?, 'standalone', 1, ?, NULL, 0)
    `).run(id, id);
  }
}

function insertTurn(
  db: DatabaseSync,
  owner: { sessionId?: string; auxiliarySessionId?: string },
  phase: "running" | "completed" | "failed" | "canceled",
  startedAt: string,
  completedAt: string | null,
  assistantMessageSeq: number | null,
): void {
  db.prepare(`
    INSERT INTO session_turns_v6 (
      session_id, auxiliary_session_id, phase, assistant_message_seq,
      started_at, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    owner.sessionId ?? null,
    owner.auxiliarySessionId ?? null,
    phase,
    assistantMessageSeq,
    startedAt,
    completedAt,
    completedAt ?? startedAt,
  );
}

describe("AuditLogStorageV6 conversation timing", () => {
  it("terminal Session commitだけで次turn・再起動後のConversation Timingへ完了を公開する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-conversation-terminal-commit-"));
    const completedAt = "2026-08-16T00:10:00.000Z";
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
      const db = new DatabaseSync(dbPath);
      try {
        insertCharacter(db, "char-a");
      } finally {
        db.close();
      }

      const sessionStorage = new SessionStorageV6(dbPath);
      const session = sessionStorage.insertSession(buildNewSession({
        id: "current",
        taskTitle: "Timing commit",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        characterRuntimeSnapshot: {
          characterId: "char-a",
          name: "A",
          description: "",
          iconFilePath: "",
          theme: { main: "#6f8cff", sub: "#6fb8c7" },
          definitionMarkdown: "# A",
          definitionSha256: "char-a-sha256",
          definitionByteSize: 3,
          snapshotAt: "2026-08-16T00:00:00.000Z",
        },
        approvalMode: DEFAULT_APPROVAL_MODE,
      }));
      const turnDb = new DatabaseSync(dbPath);
      let auditLogId = 0;
      try {
        const result = turnDb.prepare(`
          INSERT INTO session_turns_v6 (
            session_id, phase, provider_id, user_message_seq, started_at, updated_at
          ) VALUES (?, 'running', 'codex', 0, ?, ?)
        `).run(session.id, "2026-08-16T00:00:00.000Z", "2026-08-16T00:00:00.000Z");
        auditLogId = Number(result.lastInsertRowid);
      } finally {
        turnDb.close();
      }

      const terminalSession = {
        ...session,
        status: "idle" as const,
        runState: "idle" as const,
        messages: [
          { role: "user" as const, text: "hello" },
          { role: "assistant" as const, text: "done" },
        ],
      };
      assert.throws(() => sessionStorage.upsertTerminalSession(terminalSession, {
        auditLogId: auditLogId + 1,
        sessionId: session.id,
        phase: "completed",
        assistantMessageSeq: 1,
        threadId: "thread-1",
        errorMessage: "",
        completedAt,
      }), /terminal commit target mismatch/);
      assert.equal(sessionStorage.getSession(session.id)?.messages.length, 0);
      const rollbackDb = new DatabaseSync(dbPath);
      try {
        const row = rollbackDb.prepare("SELECT phase FROM session_turns_v6 WHERE id = ?").get(auditLogId) as
          | { phase: string }
          | undefined;
        assert.equal(row?.phase, "running");
      } finally {
        rollbackDb.close();
      }

      const originalGetSession = sessionStorage.getSession.bind(sessionStorage);
      sessionStorage.getSession = () => {
        throw new Error("read-back failed after commit");
      };
      const committedSession = sessionStorage.upsertTerminalSession(terminalSession, {
        auditLogId,
        sessionId: session.id,
        phase: "completed",
        assistantMessageSeq: 1,
        threadId: "thread-1",
        errorMessage: "",
        completedAt,
      });
      sessionStorage.getSession = originalGetSession;
      assert.equal(committedSession.messages.at(-1)?.text, "done");
      assert.throws(() => sessionStorage.upsertTerminalSession({
        ...terminalSession,
        runState: "error",
        messages: [
          ...terminalSession.messages.slice(0, -1),
          { role: "assistant", text: "failed" },
        ],
      }, {
        auditLogId,
        sessionId: session.id,
        phase: "failed",
        assistantMessageSeq: 1,
        threadId: "thread-1",
        errorMessage: "projection failed",
        completedAt: "2026-08-16T00:10:01.000Z",
      }), /terminal commit target mismatch/);
      assert.equal(sessionStorage.getSession(session.id)?.messages.at(-1)?.text, "done");
      sessionStorage.close();

      const restartedAuditStorage = new AuditLogStorageV6(dbPath);
      try {
        const snapshot = restartedAuditStorage.getConversationTimingSnapshot(
          session.id,
          "2026-08-16T00:10:01.000Z",
        );
        assert.equal(snapshot.currentSessionLastCompletedAt, completedAt);
        assert.deepEqual(snapshot.sameCharacterCompletedTurns, [{
          startedAt: "2026-08-16T00:00:00.000Z",
          completedAt,
        }]);
      } finally {
        restartedAuditStorage.close();
      }
    } finally {
      await removeDirectoryWithRetry(userDataPath);
    }
  });

  it("通常Sessionの正常完了turnだけをcurrent・別Session・共同作業へ投影する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-conversation-timing-"));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
      const db = new DatabaseSync(dbPath);
      try {
        insertCharacter(db, "char-a");
        insertCharacter(db, "char-b");
        insertCharacter(db, "char-empty");
        insertSession(db, "current", "char-a");
        insertSession(db, "other", "char-a");
        insertSession(db, "authoring", "char-a", "character-authoring");
        insertSession(db, "different", "char-b");
        insertSession(db, "no-owner", null);
        insertSession(db, "empty-owner", "char-empty");
        db.prepare(`
          INSERT INTO auxiliary_sessions (id, parent_session_id, status, created_at, updated_at, payload_json)
          VALUES ('aux', 'current', 'active', ?, ?, '{}')
        `).run("2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");

        insertTurn(db, { sessionId: "current" }, "completed", "2026-08-04T09:50:00.000Z", "2026-08-04T10:00:00.000Z", 1);
        insertTurn(db, { sessionId: "other" }, "completed", "2026-08-04T10:50:00.000Z", "2026-08-04T11:00:00.000Z", 1);
        insertTurn(db, { sessionId: "current" }, "failed", "2026-08-04T11:30:00.000Z", "2026-08-04T11:40:00.000Z", 2);
        insertTurn(db, { sessionId: "other" }, "completed", "2026-08-04T11:40:00.000Z", "2026-08-04T11:50:00.000Z", null);
        insertTurn(db, { sessionId: "authoring" }, "completed", "2026-08-04T11:50:00.000Z", "2026-08-04T12:00:00.000Z", 1);
        insertTurn(db, { sessionId: "different" }, "completed", "2026-08-04T12:00:00.000Z", "2026-08-04T12:10:00.000Z", 1);
        insertTurn(db, { auxiliarySessionId: "aux" }, "completed", "2026-08-04T12:10:00.000Z", "2026-08-04T12:20:00.000Z", 1);
      } finally {
        db.close();
      }

      const storage = new AuditLogStorageV6(dbPath);
      try {
        const observedAt = "2026-08-04T11:30:00.000Z";
        assert.deepEqual(storage.getConversationTimingSnapshot("current", observedAt), {
          currentSessionLastCompletedAt: "2026-08-04T10:00:00.000Z",
          sameCharacterOtherSessionLastCompletedAt: "2026-08-04T11:00:00.000Z",
          sameCharacterCompletedTurns: [
            { startedAt: "2026-08-04T09:50:00.000Z", completedAt: "2026-08-04T10:00:00.000Z" },
            { startedAt: "2026-08-04T10:50:00.000Z", completedAt: "2026-08-04T11:00:00.000Z" },
          ],
        });
        assert.equal(storage.getConversationTimingSnapshot("no-owner", observedAt).sameCharacterCompletedTurns, null);
        assert.deepEqual(storage.getConversationTimingSnapshot("empty-owner", observedAt).sameCharacterCompletedTurns, []);

        const concurrentDb = new DatabaseSync(dbPath);
        try {
          insertTurn(concurrentDb, { sessionId: "current" }, "completed", "2026-08-04T11:29:59.000Z", "2026-08-04T11:30:00.050Z", 3);
          insertTurn(concurrentDb, { sessionId: "current" }, "completed", "2026-08-04T11:30:00.100Z", "2026-08-04T11:30:00.900Z", 4);
          insertTurn(concurrentDb, { sessionId: "other" }, "completed", "2026-08-04T11:29:59.000Z", "2026-08-04T11:30:00.060Z", 3);
          insertTurn(concurrentDb, { sessionId: "other" }, "completed", "2026-08-04T11:30:00.100Z", "2026-08-04T11:30:00.800Z", 4);
        } finally {
          concurrentDb.close();
        }
        const asOfSnapshot = storage.getConversationTimingSnapshot("current", "2026-08-04T11:30:00.100Z");
        assert.equal(asOfSnapshot.currentSessionLastCompletedAt, "2026-08-04T11:30:00.050Z");
        assert.equal(asOfSnapshot.sameCharacterOtherSessionLastCompletedAt, "2026-08-04T11:30:00.060Z");
      } finally {
        storage.close();
      }
    } finally {
      await removeDirectoryWithRetry(userDataPath);
    }
  });
});

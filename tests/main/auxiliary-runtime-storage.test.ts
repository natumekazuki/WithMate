import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/storage/app-database-v6-bootstrap.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import { SessionTurnStorageV6 } from "../../src-electron/session/session-turn-storage-v6.js";

// @test-value v2
// kind = "contract"
// claim = "Auxiliaryの開始・追加入力・終端は親とincarnationと件数とturn ownerを照合し、既存履歴とdraftを保持して終端messageとturnを原子的に確定する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#Persistence" }
// fault = "古いownerや件数で追加する、別turnを確定する、終端失敗でmessageだけ保存する、既存Bookmark/artifact/draftを書き換える"
// observable = "metadata ACK件数、保存messageとartifactとdraft、失敗後の件数、turn phase"
// observation_boundary = "public-boundary"
// scope = "AuxiliarySessionStorage runtime commands"
// lifecycle = "permanent"
// impact = "入力・会話履歴の喪失と別Auxiliary turnの誤確定を防ぐ"
// distinction = "型やschemaではCAS拒否と複数table transactionのrollback、履歴保持を確認できない"
// @end-test-value
test("Auxiliary runtime commandは履歴を保持しowner CASとterminal transactionを維持する", async () => {
  const directory = await mkdtemp(join(tmpdir(), "withmate-aux-runtime-"));
  try {
    const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
    const storage = new AuxiliarySessionStorage(dbPath);
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`INSERT INTO sessions_v6 (id, title, state, provider_id, catalog_revision, model_id,
        reasoning_effort, approval_mode, character_snapshot_json, created_at, updated_at, last_active_at)
        VALUES ('main', '', 'active', 'codex', 1, '', 'medium', 'untrusted', '{}', 'created', 'before', 'before');
        INSERT INTO auxiliary_sessions (id, parent_session_id, status, created_at, updated_at)
        VALUES ('aux', 'main', 'active', 'created', 'before');
        INSERT INTO auxiliary_session_messages (auxiliary_session_id, seq, role, body, artifact_body, created_at)
        VALUES ('aux', 0, 'assistant', '{"role":"assistant","text":"old","isBookmarked":true}', '{"private":"unchanged"}', 'before');
        INSERT INTO auxiliary_session_drafts (auxiliary_session_id, parent_session_id, incarnation, durable_revision, draft_text, updated_at)
        VALUES ('aux', 'main', 'draft-owner', 5, 'new draft', 'before');`);
      const turns = new SessionTurnStorageV6(dbPath);
      try {
        const owner = { auxiliarySessionId: "aux", parentSessionId: "main", createdAt: "created", expectedMessageCount: 1, updatedAt: "after" };
        assert.deepEqual(storage.getAuxiliarySessionMetadata("aux")?.messages, []);
        assert.equal(storage.getAuxiliarySessionMetadata("aux")?.messageCount, 1);
        db.prepare("UPDATE auxiliary_sessions SET character_snapshot_invalid = 1 WHERE id = 'aux'").run();
        assert.equal(storage.getAuxiliarySessionMetadata("aux")?.characterRuntimeSnapshotInvalid, true);
        assert.equal(storage.appendAuxiliaryRunningTurnStart({ ...owner, userMessage: { role: "user", text: "send" } }), null);
        db.prepare("UPDATE auxiliary_sessions SET character_snapshot_invalid = 0 WHERE id = 'aux'").run();
        assert.equal(storage.appendAuxiliaryRunningTurnStart({ ...owner, createdAt: "stale", userMessage: { role: "user", text: "send" } }), null);
        assert.equal(storage.appendAuxiliaryRunningTurnStart({ ...owner, expectedMessageCount: 0, userMessage: { role: "user", text: "send" } }), null);
        const started = storage.appendAuxiliaryRunningTurnStart({ ...owner, userMessage: { role: "user", text: "send" } });
        assert.equal(started?.messageCount, 2);
        assert.deepEqual(started?.messages, []);
        const turn = turns.createSessionTurn({ sessionId: "aux", phase: "running", createdAt: "after",
          provider: "codex", model: "", reasoningEffort: "medium", approvalMode: "untrusted", threadId: "", errorMessage: "", userMessageSeq: 1 });
        assert.equal(storage.appendAuxiliarySteer({ ...owner, expectedMessageCount: 2, turnId: turn.id + 1,
          userMessage: { role: "user", text: "steer" } }), null);
        assert.equal(storage.appendAuxiliarySteer({ ...owner, expectedMessageCount: 2, turnId: turn.id,
          userMessage: { role: "user", text: "steer" } })?.messageCount, 3);
        assert.equal(storage.checkpointAuxiliaryRuntimeMetadata({ ...owner, expectedMessageCount: 3,
          provider: "codex", threadId: "changed", expectedThreadId: "stale", expectedRunState: "running", runState: "running" }), null);
        const terminal = { ...owner, expectedMessageCount: 3, assistantMessage: { role: "assistant" as const, text: "done" },
          runState: "idle" as const, threadId: "thread", preview: "done",
          terminalCommit: { turnId: turn.id, sessionId: "aux", phase: "completed" as const, assistantMessageSeq: 3,
            threadId: "thread", errorMessage: "", completedAt: "terminal" } };
        assert.throws(() => storage.appendAuxiliaryTerminal({ ...terminal,
          terminalCommit: { ...terminal.terminalCommit, turnId: turn.id + 1 } }), /target mismatch/);
        assert.equal(storage.getAuxiliarySessionMetadata("aux")?.messageCount, 3);
        assert.equal(turns.getLatestSessionTurn("aux")?.phase, "running");
        assert.equal(storage.appendAuxiliaryTerminal(terminal)?.messageCount, 4);
        assert.equal(turns.getLatestSessionTurn("aux")?.phase, "completed");
        assert.equal(storage.appendAuxiliaryTerminal(terminal), null);
        assert.equal(storage.getAuxiliarySession("aux")?.messages[0]?.isBookmarked, true);
        assert.equal(db.prepare("SELECT artifact_body FROM auxiliary_session_messages WHERE auxiliary_session_id = 'aux' AND seq = 0").get()?.artifact_body,
          '{"private":"unchanged"}');
        assert.equal(storage.getAuxiliaryDraft("aux")?.text, "new draft");
        assert.equal(storage.getAuxiliaryDraft("aux")?.durableRevision, 5);
        db.prepare("DELETE FROM auxiliary_sessions WHERE id = 'aux'").run();
        assert.equal(storage.appendAuxiliaryRunningTurnStart({ ...owner, expectedMessageCount: 0, userMessage: { role: "user", text: "late" } }), null);
        assert.equal(storage.getAuxiliarySessionMetadata("aux"), null);
      } finally { turns.close(); }
    } finally { db.close(); storage.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliaryのfailed/canceled終端は継続用の保存threadと実行turnの異なるthreadを各正本へ保存し取得済assistantとともにACKを返す"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#Error Handling" }
// fault = "Session threadとturn threadの差を拒否してassistantと終端phaseを保存しない、または片方のthreadをもう片方へ上書きする"
// observable = "terminal ACKのthreadId/messageCount/runState、保存assistant、最小turnのphase/threadId/assistantMessageSeq"
// observation_boundary = "public-boundary"
// scope = "AuxiliarySessionStorage failed/canceled terminal transaction"
// lifecycle = "permanent"
// impact = "失敗・取消結果の保存喪失と継続threadの破壊により会話がrunningに残ることを防ぐ"
// distinction = "generic runtime fixtureは実Auxiliary SQLite terminal commandを通らず、型/schemaは正当な異threadの受理を保証できない"
// @end-test-value
test("Auxiliaryの失敗と取消はSession継続threadとturn実行threadを別々に保存する", async () => {
  const directory = await mkdtemp(join(tmpdir(), "withmate-aux-terminal-thread-"));
  try {
    const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
    const storage = new AuxiliarySessionStorage(dbPath);
    const turns = new SessionTurnStorageV6(dbPath);
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`INSERT INTO sessions_v6 (id, title, state, provider_id, catalog_revision, model_id,
        reasoning_effort, approval_mode, character_snapshot_json, created_at, updated_at, last_active_at)
        VALUES ('main', '', 'active', 'codex', 1, '', 'medium', 'untrusted', '{}', 'created', 'before', 'before');`);
      for (const phase of ["failed", "canceled"] as const) {
        const id = `aux-${phase}`;
        db.prepare(`INSERT INTO auxiliary_sessions (id, parent_session_id, status, run_state, thread_id, created_at, updated_at)
          VALUES (?, 'main', 'active', 'running', 'thread-stale', 'created', 'before')`).run(id);
        const turn = turns.createSessionTurn({ sessionId: id, phase: "running", createdAt: "before",
          provider: "codex", model: "", reasoningEffort: "medium", approvalMode: "untrusted", threadId: "thread-live", errorMessage: "" });
        const ack = storage.appendAuxiliaryTerminal({ auxiliarySessionId: id, parentSessionId: "main", createdAt: "created",
          expectedMessageCount: 0, updatedAt: "terminal", assistantMessage: { role: "assistant", text: `partial-${phase}` },
          runState: "error", threadId: "thread-stale", preview: "",
          terminalCommit: { turnId: turn.id, sessionId: id, phase, assistantMessageSeq: 0, threadId: "thread-live",
            errorMessage: phase, completedAt: "terminal" } });
        assert.ok(ack);
        assert.equal(ack.threadId, "thread-stale");
        assert.equal(ack.messageCount, 1);
        assert.equal(ack.runState, "error");
        assert.deepEqual(ack.messages, []);
        const saved = storage.getAuxiliarySession(id);
        assert.equal(saved?.threadId, "thread-stale");
        assert.equal(saved?.messages[0]?.role, "assistant");
        assert.equal(saved?.messages[0]?.text, `partial-${phase}`);
        const savedTurn = turns.getLatestSessionTurn(id);
        assert.equal(savedTurn?.phase, phase);
        assert.equal(savedTurn?.threadId, "thread-live");
        assert.equal(savedTurn?.assistantMessageSeq, 0);
      }
    } finally { db.close(); turns.close(); storage.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

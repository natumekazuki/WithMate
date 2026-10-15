import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import type { ElicitationRecord } from "../../src-shared/session/runtime-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";

async function withStore(run: (storage: SessionStorageV6, db: DatabaseSync, incarnationId: string) => void) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-storage-"));
  const dbPath = path.join(directory, "test.db");
  const storage = new SessionStorageV6(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    const session = storage.insertSession({ ...buildNewSession({
      id: "session", taskTitle: "Runtime", workspaceLabel: "workspace", workspacePath: "C:/workspace",
      branch: "main", characterId: "char-a", character: "A", characterIconPath: "",
      characterThemeColors: { main: "#123456", sub: "#abcdef" }, approvalMode: DEFAULT_APPROVAL_MODE,
    }), messages: [{ role: "user", text: "start", isBookmarked: true }], status: "running", runState: "running" });
    db.prepare(`INSERT INTO session_turns_v6 (session_id, phase, provider_id, model_id,
      reasoning_effort, approval_mode, sandbox_mode, thread_id, error_summary, started_at, updated_at)
      VALUES ('session', 'running', 'codex', '', 'medium', 'never', '', '', '', 'now', 'now')`).run();
    run(storage, db, session.incarnationId!);
  } finally {
    db.close(); storage.close(); await rm(directory, { recursive: true, force: true });
  }
}

// @test-value v2
// kind = "contract"
// claim = "turn終端の質問記録はSQLiteの通常履歴と表示pageに残り、再読込で操作可能なpendingへ戻らない"
// oracle = { type = "contract", ref = "docs/design/database-schema.md#storage-overview" }
// fault = "message保存またはpage投影で質問記録を落とすか、保存pendingを操作可能として復元する"
// observable = "実DB terminal append後のfull readと表示pageの質問文・選択肢・status"
// observation_boundary = "public-boundary"
// scope = "SessionStorageV6 question record persistence"
// lifecycle = "permanent"
// impact = "会話再表示時に質問の存在が失われるか、古いフォームへ再送できるように見える"
// distinction = "runtimeとReact単体testではSQLiteの正規化・軽量page経路を通らない"
// @end-test-value
it("質問記録はterminal保存と表示pageを通して保持される", async () => {
  await withStore((storage, _db, incarnationId) => {
    const records: ElicitationRecord[] = [
      { requestId: "answered", message: "Question", fields: [{ title: "Scope", options: ["Small", "Full"] }], status: "answered" },
      { requestId: "ended", message: "More", fields: [{ title: "Reason" }], status: "pending" },
    ];
    storage.appendSessionTerminal({
      sessionId: "session", incarnationId, expectedMessageCount: 1,
      assistantMessage: { role: "assistant", text: "done", elicitationRecords: records },
      metadata: { status: "idle", runState: "idle", threadId: "thread", updatedAt: "terminal" },
      terminalCommit: { turnId: 1, sessionId: "session", phase: "completed", assistantMessageSeq: 1,
        threadId: "thread", errorMessage: "", completedAt: "terminal" },
    });
    const expected = [records[0], { ...records[1], status: "expired" }];
    assert.deepEqual(storage.getSession("session")?.messages.at(-1)?.elicitationRecords, expected);
    assert.deepEqual(storage.getSessionView("session")?.messages.at(-1)?.elicitationRecords, expected);
  });
});

// @test-value v2
// kind = "invariant"
// claim = "metadata件数とtarget identityはfull readが保持するmessageのnormalized indexと一致し保存seqを返す"
// oracle = { type = "contract", ref = "src-electron/session/session-storage-v6.ts decodeMessage" }
// fault = "tool/system除外行をindexに数えるかraw seqをnormalized indexと誤認する"
// observable = "metadata.messageCountと指定indexのrole/text/historyIndex"
// observation_boundary = "component-behavior"
// scope = "Main Session storage query"
// lifecycle = "permanent"
// impact = "Characterのassistant保存確認が別messageを評価する"
// distinction = "既存page testはraw seqを扱いnormalized full readとの対応を検証しない、小規模実DB testで継続確認する"
// @end-test-value
it("metadataとidentityはnormalized indexを保存seqへ対応付ける", async () => {
  await withStore((storage, db, incarnationId) => {
    const insert = db.prepare("INSERT INTO session_messages_v6 (session_id, seq, role, body, created_at) VALUES ('session', ?, ?, ?, 'now')");
    insert.run(2, "tool", "not JSON");
    insert.run(4, "assistant", "plain legacy assistant");
    insert.run(7, "system", JSON.stringify({ role: "user", text: "normalized user" }));
    assert.equal(storage.getSessionMetadata("session")?.messageCount, storage.getSession("session")?.messages.length);
    assert.deepEqual(storage.getSessionMessageIdentity({ sessionId: "session", incarnationId, messageIndex: 1 }),
      { role: "assistant", text: "plain legacy assistant", historyIndex: 4 });
    assert.deepEqual(storage.getSessionMessageIdentity({ sessionId: "session", incarnationId, messageIndex: 2 }),
      { role: "user", text: "normalized user", historyIndex: 7 });
    assert.equal(storage.getSessionMessageIdentity({ sessionId: "session", incarnationId: "stale", messageIndex: 0 }), null);
    assert.equal(storage.getSessionMessageIdentity({ sessionId: "session", incarnationId, messageIndex: 3 }), null);
  });
});

// @test-value v2
// kind = "invariant"
// claim = "steerとterminalはowner/count/turnを照合し既存本文BookmarkとPinを維持してmessageとterminal turnをatomicに確定する"
// oracle = { type = "contract", ref = "docs/design/electron-session-store.md 書込みとowner" }
// fault = "古いcountを受理する、非所有履歴を上書きする、terminal turn失敗時messageだけをcommitする"
// observable = "append ACK件数、保存message本文Bookmark、Pin、turn phase、失敗前後のmetadataとmessage"
// observation_boundary = "component-behavior"
// scope = "Main Session atomic append"
// lifecycle = "permanent"
// impact = "確定messageの欠落、重複や整理操作の喪失を防ぐ"
// distinction = "full Session保存testでは対象限定appendとatomic turn失敗を通らず、この実DB testの負担は小さい"
// @end-test-value
it("steerとterminalは非所有データを保ち失敗をatomicに戻す", async () => {
  await withStore((storage, db, incarnationId) => {
    storage.setSessionPinned("session", true);
    const pinOwner = { sessionId: "session", incarnationId };
    storage.pinSessionFile(pinOwner, { rootKind: "workspace", rootPath: "C:/workspace", relativePath: "file.txt", kind: "file", rootLabel: "workspace" });
    const pins = storage.listSessionFilePins(pinOwner);
    const owner = { sessionId: "session", incarnationId, expectedMessageCount: 1 };
    const steer = { ...owner, turnId: 1, userMessage: { role: "user" as const, text: "steer" }, updatedAt: "later" };
    assert.equal(storage.appendSessionSteer(steer).messageCount, 2);
    assert.throws(() => storage.appendSessionSteer(steer));
    assert.throws(() => storage.appendSessionSteer({ ...steer, incarnationId: "stale", expectedMessageCount: 2 }));
    const terminal = { ...owner, expectedMessageCount: 2, assistantMessage: { role: "assistant" as const, text: "done" },
      metadata: { status: "idle" as const, runState: "idle", threadId: "thread", updatedAt: "terminal" },
      terminalCommit: { turnId: 1, sessionId: "session", phase: "completed" as const, assistantMessageSeq: 2,
        threadId: "thread", errorMessage: "", completedAt: "terminal" } };
    const before = storage.getSession("session");
    db.exec("CREATE TRIGGER fail_terminal BEFORE UPDATE OF phase ON session_turns_v6 BEGIN SELECT RAISE(ABORT, 'terminal failure'); END");
    assert.throws(() => storage.appendSessionTerminal(terminal), /terminal failure/);
    assert.deepEqual(storage.getSession("session"), before);
    db.exec("DROP TRIGGER fail_terminal");
    const result = storage.appendSessionTerminal(terminal);
    assert.equal(result.messageCount, 3);
    assert.equal(result.summary.isPinned, true);
    assert.deepEqual(storage.listSessionFilePins(pinOwner), pins);
    assert.equal(storage.getSession("session")?.messages[0].isBookmarked, true);
    assert.deepEqual(storage.getSession("session")?.messages.map((message) => message.text), ["start", "steer", "done"]);
    assert.equal((db.prepare("SELECT phase FROM session_turns_v6 WHERE id = 1").get() as { phase: string }).phase, "completed");
    assert.throws(() => storage.appendSessionTerminal({ ...terminal, expectedMessageCount: 3, terminalCommit: { ...terminal.terminalCommit, assistantMessageSeq: 3 } }));
  });
});

// @test-value v2
// kind = "invariant"
// claim = "run metadata checkpointは期待owner/state/thread一致時だけ非所有metadataとmessageを保持して更新する"
// oracle = { type = "contract", ref = "docs/design/electron-session-store.md 書込みとowner" }
// fault = "owner/status/runState/threadのいずれかのCAS条件を省略する、非所有metadataを初期化する、read-only ownerを更新する"
// observable = "各条件を単独で不一致にしたcheckpointのnull ACKと保存Session不変、成功時の限定metadata更新とTitle・Pinを含む非所有Session全体の保持"
// observation_boundary = "component-behavior"
// scope = "Main Session run checkpoint"
// lifecycle = "permanent"
// impact = "retryやsetup失敗処理が別実行の状態を壊す"
// distinction = "provider metadata CASはrunStateを扱わずこの条件を検証しない、実DB一件の低コストtestで維持する"
// @end-test-value
it("run checkpointはCASとread-onlyを保護する", async () => {
  await withStore((storage, db, incarnationId) => {
    storage.setSessionTitle("session", incarnationId, "User renamed title");
    storage.setSessionPinned("session", true);
    const before = storage.getSession("session")!;
    const input = { sessionId: "session", incarnationId, expected: { status: "running" as const, runState: "running", threadId: "" },
      next: { status: "idle" as const, runState: "error", threadId: "next", updatedAt: "checkpoint" } };
    for (const mismatch of [
      { ...input, incarnationId: "stale" },
      { ...input, expected: { ...input.expected, status: "idle" as const } },
      { ...input, expected: { ...input.expected, runState: "error" } },
      { ...input, expected: { ...input.expected, threadId: "stale-thread" } },
    ]) {
      assert.equal(storage.checkpointSessionRunMetadata(mismatch), null);
      assert.deepEqual(storage.getSession("session"), before);
    }
    const checkpoint = storage.checkpointSessionRunMetadata(input)!;
    assert.equal(checkpoint.summary.runState, "error");
    assert.equal(checkpoint.summary.taskTitle, "User renamed title");
    assert.equal(checkpoint.summary.isPinned, true);
    const after = storage.getSession("session");
    assert.deepEqual(after, { ...before, ...input.next });
    assert.equal(storage.checkpointSessionRunMetadata(input), null);
    assert.deepEqual(storage.getSession("session"), after);
    db.prepare("UPDATE sessions_v6 SET runtime_policy_json = json_set(runtime_policy_json, '$.accessMode', 'legacy_readonly') WHERE id = 'session'").run();
    const readonlyInput = { ...input, expected: { status: "idle" as const, runState: "error", threadId: "next" } };
    const readonlyBefore = storage.getSession("session");
    assert.equal(storage.checkpointSessionRunMetadata(readonlyInput), null);
    assert.deepEqual(storage.getSession("session"), readonlyBefore);
    assert.throws(() => storage.appendSessionSteer({ sessionId: "session", incarnationId, expectedMessageCount: 1,
      turnId: 1, userMessage: { role: "user", text: "forbidden" }, updatedAt: "later" }), /read-only/);
  });
});

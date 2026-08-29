import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import type { CharacterRuntimeSnapshot } from "../../src/character/character-catalog.js";
import { buildNewSession, type Message, type MessageArtifact } from "../../src/session-state.js";
import { SessionRunningTurnStartConflictError } from "../../src-electron/session-storage-errors.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";

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

function createSessionInput(id: string, messages: Message[]) {
  return {
    ...buildNewSession({
      id,
      taskTitle: "Running turn start",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "char-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
    }),
    updatedAt: "2026-08-30T00:00:00.000Z",
    messages,
  };
}

function createArtifact(): MessageArtifact {
  return {
    title: "Run result",
    activitySummary: ["edited file"],
    operationTimeline: [{ type: "tool", summary: "apply patch", details: "large operation details" }],
    changedFiles: [{
      kind: "edit",
      path: "src/example.ts",
      summary: "updated example",
      diffRows: [{ kind: "add", rightNumber: 1, rightText: "const value = true;" }],
    }],
    runChecks: [{ label: "npm test", value: "pass" }],
  };
}

function createCharacterRuntimeSnapshot(name: string): CharacterRuntimeSnapshot {
  return {
    characterId: "char-a",
    name,
    description: name + " description",
    iconFilePath: "C:/characters/char-a/" + name.toLowerCase() + ".png",
    theme: { main: "#123456", sub: "#abcdef" },
    definitionMarkdown: "# " + name,
    definitionSha256: name.toLowerCase() + "-sha",
    definitionByteSize: name.length + 2,
    snapshotAt: "2026-08-30T00:00:00.000Z",
  };
}

// @test-value v1
// kind = "invariant"
// claim = "running turn開始は既存messageとartifact detailと非所有metadataを維持し、user messageとrunning metadataだけを追加する"
// oracle = { type = "contract", ref = "running-turn-start-persistence#1,#4,#5,#8" }
// failure_mode = "古いSession snapshotの全体保存によりpin、既存message、artifact detailが上書きまたは欠落する"
// scope = "SessionStorageV6.appendRunningTurnStart"
// lifecycle = "permanent"
// distinction = "generic upsertのartifact保持ではなく、専用incremental operationの所有範囲とretry競合を同じDB境界で観測する"
// @end-test-value
it("running turn開始は既存内容と非所有metadataを保持し、retryを重複appendにしない", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-running-start-v6-"));
  const dbPath = path.join(tempDirectory, "withmate-v6.db");
  const storage = new SessionStorageV6(dbPath);

  try {
    const artifact = createArtifact();
    const initial = storage.insertSession(createSessionInput("running-start-preserve", [
      { role: "user", text: "existing user" },
      { role: "assistant", text: "existing assistant", artifact },
    ]));
    storage.setSessionPinned(initial.id, true);
    const concurrentDb = new DatabaseSync(dbPath);
    try {
      concurrentDb.prepare("UPDATE sessions_v6 SET title = ?, is_pinned = 1 WHERE id = ?")
        .run("Concurrent title", initial.id);
    } finally {
      concurrentDb.close();
    }

    const storedResult = storage.appendRunningTurnStart({
      sessionId: initial.id,
      expectedMessageCount: 2,
      userMessage: { role: "user", text: "new prompt" },
      updatedAt: "2026-08-30T00:01:00.000Z",
    });

    const storedSummary = storedResult.summary;
    assert.equal(storedSummary.taskTitle, "Concurrent title");
    assert.equal(storedSummary.isPinned, true);
    assert.equal(storedSummary.status, "running");
    assert.equal(storedSummary.runState, "running");
    assert.equal(storedSummary.updatedAt, "2026-08-30T00:01:00.000Z");
    const hydrated = storage.getSession(initial.id);
    assert.deepEqual(hydrated?.messages.map((message) => message.text), [
      "existing user",
      "existing assistant",
      "new prompt",
    ]);
    const storedArtifact = storage.getSessionMessageArtifact(initial.id, 1);
    assert.equal(storedArtifact?.operationTimeline?.[0]?.details, "large operation details");
    assert.equal(storedArtifact?.changedFiles[0]?.diffRows[0]?.rightText, "const value = true;");
    assert.deepEqual(storedArtifact?.runChecks, artifact.runChecks);
    assert.equal(hydrated?.workspacePath, "C:/workspace");

    assert.throws(
      () => storage.appendRunningTurnStart({
        sessionId: initial.id,
        expectedMessageCount: 2,
        userMessage: { role: "user", text: "new prompt" },
        updatedAt: "2026-08-30T00:02:00.000Z",
      }),
      SessionRunningTurnStartConflictError,
    );
    assert.equal(storage.getSession(initial.id)?.messages.length, 3);
  } finally {
    storage.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

// @test-value v1
// kind = "regression"
// claim = "character-authoringのrunning turn開始は最新runtime snapshotと表示metadataをuser messageと同じtransactionへ保存し、中間失敗時は全て戻す"
// oracle = { type = "contract", ref = "docs/design/character-storage.md#Runtime-Snapshot" }
// failure_mode = "providerだけ最新snapshotを使ってDBには旧情報が残るか、message失敗時にsnapshotとrunning metadataだけがcommitされる"
// scope = "SessionStorageV6.appendRunningTurnStart"
// lifecycle = "permanent"
// distinction = "通常Sessionのimmutable snapshotではなく、turnごとに再生成するcharacter-authoring例外をDB read-backで観測する"
// @end-test-value
it("character-authoringのrunning turn開始は最新snapshotと表示metadataをatomicに保存して失敗時は戻す", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-running-authoring-"));
  const dbPath = path.join(tempDirectory, "withmate-v6.db");
  const storage = new SessionStorageV6(dbPath);

  try {
    const oldSnapshot = createCharacterRuntimeSnapshot("Old");
    const freshSnapshot = {
      ...createCharacterRuntimeSnapshot("Fresh"),
      iconFilePath: "C:/characters/char-a/fresh.png",
      theme: { main: "#334455", sub: "#ddeeff" },
      snapshotAt: "2026-08-30T00:01:00.000Z",
    };
    const characterDb = new DatabaseSync(dbPath);
    try {
      characterDb.prepare(`
        INSERT INTO characters (id, name, description, icon_file_path, theme_main, theme_sub, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        oldSnapshot.characterId,
        oldSnapshot.name,
        oldSnapshot.description,
        oldSnapshot.iconFilePath,
        oldSnapshot.theme.main,
        oldSnapshot.theme.sub,
        "2026-08-30T00:00:00.000Z",
        "2026-08-30T00:00:00.000Z",
      );
    } finally {
      characterDb.close();
    }
    const initial = storage.insertSession({
      ...createSessionInput("running-authoring", [{ role: "assistant", text: "existing" }]),
      sessionKind: "character-authoring",
      character: oldSnapshot.name,
      characterIconPath: oldSnapshot.iconFilePath,
      characterThemeColors: oldSnapshot.theme,
      characterRuntimeSnapshot: oldSnapshot,
    });

    const failureDb = new DatabaseSync(dbPath);
    try {
      failureDb.exec(`
        CREATE TRIGGER fail_authoring_message
        BEFORE INSERT ON session_messages_v6
        WHEN NEW.session_id = 'running-authoring' AND NEW.seq = 1
        BEGIN SELECT RAISE(ABORT, 'authoring message failed'); END;
      `);
    } finally {
      failureDb.close();
    }
    assert.throws(() => storage.appendRunningTurnStart({
      sessionId: initial.id,
      expectedMessageCount: 1,
      userMessage: { role: "user", text: "new prompt" },
      updatedAt: "2026-08-30T00:01:00.000Z",
      characterRuntimeSnapshot: freshSnapshot,
    }), /authoring message failed/);
    const rolledBack = storage.getSession(initial.id);
    assert.deepEqual(rolledBack?.characterRuntimeSnapshot, oldSnapshot);
    assert.equal(rolledBack?.character, "Old");
    assert.deepEqual(rolledBack?.messages.map((message) => message.text), ["existing"]);
    assert.equal(rolledBack?.status, "idle");
    assert.equal(rolledBack?.runState, "idle");
    const cleanupDb = new DatabaseSync(dbPath);
    try {
      cleanupDb.exec("DROP TRIGGER fail_authoring_message;");
    } finally {
      cleanupDb.close();
    }

    const storedResult = storage.appendRunningTurnStart({
      sessionId: initial.id,
      expectedMessageCount: 1,
      userMessage: { role: "user", text: "new prompt" },
      updatedAt: "2026-08-30T00:01:00.000Z",
      characterRuntimeSnapshot: freshSnapshot,
    });

    assert.equal(storedResult.summary.character, "Fresh");
    assert.equal(storedResult.summary.characterIconPath, freshSnapshot.iconFilePath);
    assert.deepEqual(storedResult.summary.characterThemeColors, freshSnapshot.theme);
    assert.deepEqual(storedResult.characterRuntimeSnapshot, freshSnapshot);
    const hydrated = storage.getSession(initial.id);
    assert.deepEqual(hydrated?.characterRuntimeSnapshot, freshSnapshot);
    assert.equal(hydrated?.character, "Fresh");
    assert.equal(hydrated?.characterIconPath, freshSnapshot.iconFilePath);
    assert.deepEqual(hydrated?.characterThemeColors, freshSnapshot.theme);
    assert.deepEqual(hydrated?.messages.map((message) => message.text), ["existing", "new prompt"]);
    assert.equal(hydrated?.status, "running");
    assert.equal(hydrated?.runState, "running");
  } finally {
    storage.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

// @test-value v1
// kind = "invariant"
// claim = "running metadata更新またはuser message追加が失敗するとtransaction全体がrollbackされる"
// oracle = { type = "contract", ref = "running-turn-start-persistence#1,#2" }
// failure_mode = "transaction中間の失敗でrunning metadataまたはuser messageの片方だけが永続化される"
// scope = "SessionStorageV6.appendRunningTurnStart"
// lifecycle = "permanent"
// distinction = "metadata failureとmessage append failureの両方でcommit前のDB postconditionを観測する"
// @end-test-value
it("running turn開始はmetadataまたはmessage書き込み失敗時に全体をrollbackする", async () => {
  for (const failureTarget of ["metadata", "message"] as const) {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-running-" + failureTarget + "-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    const storage = new SessionStorageV6(dbPath);

    try {
      const sessionId = "running-start-" + failureTarget;
      const initial = storage.insertSession(createSessionInput(sessionId, [{ role: "assistant", text: "existing" }]));
      const failureDb = new DatabaseSync(dbPath);
      try {
        const triggerSql = failureTarget === "metadata"
          ? [
              "CREATE TRIGGER fail_running_metadata",
              "BEFORE UPDATE ON sessions_v6",
              "WHEN NEW.id = '" + sessionId + "' AND NEW.state = 'active'",
              "BEGIN SELECT RAISE(ABORT, 'metadata failed'); END;",
            ].join("\n")
          : [
              "CREATE TRIGGER fail_running_message",
              "BEFORE INSERT ON session_messages_v6",
              "WHEN NEW.session_id = '" + sessionId + "' AND NEW.seq = 1",
              "BEGIN SELECT RAISE(ABORT, 'message failed'); END;",
            ].join("\n");
        failureDb.exec(triggerSql);
      } finally {
        failureDb.close();
      }

      assert.throws(() => storage.appendRunningTurnStart({
        sessionId: initial.id,
        expectedMessageCount: 1,
        userMessage: { role: "user", text: "must rollback" },
        updatedAt: "2026-08-30T00:01:00.000Z",
      }), new RegExp(failureTarget + " failed"));

      const afterFailure = storage.getSession(initial.id);
      assert.equal(afterFailure?.status, initial.status);
      assert.equal(afterFailure?.runState, initial.runState);
      assert.equal(afterFailure?.updatedAt, initial.updatedAt);
      assert.deepEqual(afterFailure?.messages, initial.messages);
    } finally {
      storage.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  }
});

// @test-value v1
// kind = "regression"
// claim = "running turn開始のmessage write量は既存履歴件数にかかわらずINSERT 1件、DELETE 0件である"
// oracle = { type = "contract", ref = "running-turn-start-persistence#3,#8" }
// failure_mode = "長いSessionほど既存messageの削除と再挿入が増え、prompt送信前の同期保存時間が履歴量に比例する"
// scope = "SessionStorageV6.appendRunningTurnStart"
// lifecycle = "permanent"
// distinction = "時間の固定閾値ではなくDB triggerでshort/long fixtureの実write件数を比較する"
// @end-test-value
it("running turn開始のmessage write件数はshortとlongの履歴量に比例しない", async () => {
  const observations: Array<{
    historyMessageCount: number;
    insertedMessages: number;
    deletedMessages: number;
    updatedSessions: number;
    durationMs: number;
  }> = [];

  for (const historyMessageCount of [4, 284]) {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-running-count-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    const storage = new SessionStorageV6(dbPath);

    try {
      const messages: Message[] = Array.from({ length: historyMessageCount }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        text: "message-" + index,
      }));
      const session = storage.insertSession(createSessionInput("running-count", messages));
      const metricsDb = new DatabaseSync(dbPath);
      try {
        metricsDb.exec([
          "CREATE TABLE running_start_write_metrics (inserted_messages INTEGER NOT NULL, deleted_messages INTEGER NOT NULL, updated_sessions INTEGER NOT NULL);",
          "INSERT INTO running_start_write_metrics VALUES (0, 0, 0);",
          "CREATE TRIGGER count_running_message_insert AFTER INSERT ON session_messages_v6 BEGIN UPDATE running_start_write_metrics SET inserted_messages = inserted_messages + 1; END;",
          "CREATE TRIGGER count_running_message_delete AFTER DELETE ON session_messages_v6 BEGIN UPDATE running_start_write_metrics SET deleted_messages = deleted_messages + 1; END;",
          "CREATE TRIGGER count_running_session_update AFTER UPDATE ON sessions_v6 BEGIN UPDATE running_start_write_metrics SET updated_sessions = updated_sessions + 1; END;",
        ].join("\n"));

        const startedAt = performance.now();
        storage.appendRunningTurnStart({
          sessionId: session.id,
          expectedMessageCount: historyMessageCount,
          userMessage: { role: "user", text: "new prompt" },
          updatedAt: "2026-08-30T00:01:00.000Z",
        });
        const durationMs = performance.now() - startedAt;
        const counts = metricsDb.prepare("SELECT * FROM running_start_write_metrics").get() as {
          inserted_messages: number;
          deleted_messages: number;
          updated_sessions: number;
        };
        observations.push({
          historyMessageCount,
          insertedMessages: counts.inserted_messages,
          deletedMessages: counts.deleted_messages,
          updatedSessions: counts.updated_sessions,
          durationMs,
        });
      } finally {
        metricsDb.close();
      }
    } finally {
      storage.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  }

  assert.deepEqual(observations.map(({ durationMs: _durationMs, ...work }) => work), [
    { historyMessageCount: 4, insertedMessages: 1, deletedMessages: 0, updatedSessions: 1 },
    { historyMessageCount: 284, insertedMessages: 1, deletedMessages: 0, updatedSessions: 1 },
  ]);
  console.info("running turn start fixture comparison", observations);
});

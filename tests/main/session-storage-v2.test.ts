import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { CREATE_V2_SCHEMA_SQL } from "../../src-electron/storage/database-schema-v2.js";
import { SessionStorageV2 } from "../../src-electron/session/session-storage-v2.js";

/** 旧世代ヘッダーのうち、互換読み込みのケースごとに差し替える値。 */
type V2SessionHeaderInput = {
  id?: string;
  taskTitle?: string;
  provider?: string;
  approvalMode?: string;
  codexSandboxMode?: string;
  model?: string;
  reasoningEffort?: string;
  customAgentName?: string;
  allowedAdditionalDirectoriesJson?: string;
  messageCount?: number;
  lastActiveAt?: number;
};

/** ディスク上へ V2 の初期スキーマを作り、読み書きの検証後に試験用データを片付ける。 */
async function withTempV2Database<T>(
  fn: (dbPath: string) => T | Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "withmate-session-v2-read-"));
  const dbPath = path.join(dir, "withmate-v2.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    for (const statement of CREATE_V2_SCHEMA_SQL) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }

  try {
    return await fn(dbPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** ストレージを通さず旧形式の会話ヘッダーを挿入し、後続の履歴に使う ID を返す。 */
function insertSessionHeader(
  db: DatabaseSync,
  input: V2SessionHeaderInput = {},
): string {
  const id = input.id ?? "session-1";
  db.prepare(
    `
    INSERT INTO sessions (
      id,
      task_title,
      status,
      updated_at,
      provider,
      catalog_revision,
      workspace_label,
      workspace_path,
      branch,
      session_kind,
      character_id,
      character_name,
      character_icon_path,
      character_theme_main,
      character_theme_sub,
      run_state,
      approval_mode,
      codex_sandbox_mode,
      model,
      reasoning_effort,
      custom_agent_name,
      allowed_additional_directories_json,
      thread_id,
      message_count,
      last_active_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    input.taskTitle ?? "Runtime task",
    "idle",
    "2026-04-27T00:00:00.000Z",
    input.provider ?? "codex",
    1,
    "workspace-a",
    "workspace-a",
    "main",
    "default",
    "char-a",
    "A",
    "",
    "#6f8cff",
    "#6fb8c7",
    "idle",
    input.approvalMode ?? "never",
    input.codexSandboxMode ?? "workspace-write",
    input.model ?? "gpt-5.4-mini",
    input.reasoningEffort ?? "medium",
    input.customAgentName ?? "",
    input.allowedAdditionalDirectoriesJson ??
      JSON.stringify(["shared/reference"]),
    "thread-1",
    input.messageCount ?? 0,
    input.lastActiveAt ?? 1,
  );
  return id;
}

/** 指定順序と表示属性で旧履歴の行を挿入し、添付情報をひも付ける行 ID を返す。 */
function insertMessage(
  db: DatabaseSync,
  input: {
    sessionId: string;
    seq: number;
    role: "user" | "assistant";
    text: string;
    accent?: number;
    isBookmarked?: number;
    artifactAvailable?: number;
  },
): number {
  const result = db
    .prepare(
      `
    INSERT INTO session_messages (
      session_id,
      seq,
      role,
      text,
      accent,
      is_bookmarked,
      artifact_available,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      input.sessionId,
      input.seq,
      input.role,
      input.text,
      input.accent ?? 0,
      input.isBookmarked ?? 0,
      input.artifactAvailable ?? 0,
      "2026-04-27T00:00:00.000Z",
    );
  return Number(result.lastInsertRowid);
}

/** メッセージ行に V2 の JSON アーティファクトを付ける。 */
function insertArtifact(
  db: DatabaseSync,
  messageId: number,
  artifact: object,
): void {
  db.prepare(
    "INSERT INTO session_message_artifacts (message_id, artifact_json) VALUES (?, ?)",
  ).run(messageId, JSON.stringify(artifact));
}

/** 残存行数など、直接 SQL で調べた件数を数値で返す。 */
function readCount(
  db: DatabaseSync,
  sql: string,
  ...params: SQLInputValue[]
): number {
  const row = db.prepare(sql).get(...params) as { count: number };
  return Number(row.count);
}

/** 現行の会話状態を作り、作業領域を区別できる ID で保存試験に渡す。 */
function createSession(
  taskTitle: string,
  workspaceLabel: string,
  characterId: string,
  character: string,
) {
  const session = buildNewSession({
    taskTitle,
    workspaceLabel,
    workspacePath: `/${workspaceLabel}`,
    branch: "main",
    characterId,
    character,
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    approvalMode: DEFAULT_APPROVAL_MODE,
  });

  return {
    ...session,
    id: `${session.id}-${workspaceLabel}`,
  };
}

/** V2 が公開する会話の復元と、関連行を含む書き換え・削除を実 DB で検証する。 */
describe("SessionStorageV2", () => {
  /** 本文を挿入せず、ヘッダーだけでタイトル、作業領域、追加ディレクトリを取得する。 */
  it("listSessionSummaries は V2 sessions header から summary を復元する", async () => {
    await withTempV2Database((dbPath) => {
      const db = new DatabaseSync(dbPath);
      try {
        insertSessionHeader(db, {
          id: "session-summary",
          taskTitle: "Task title",
          allowedAdditionalDirectoriesJson: JSON.stringify([
            "shared/reference",
          ]),
        });
      } finally {
        db.close();
      }

      const storage = new SessionStorageV2(dbPath);
      try {
        const summaries = storage.listSessionSummaries();
        assert.equal(summaries.length, 1);
        assert.equal(summaries[0].id, "session-summary");
        assert.equal(summaries[0].taskTitle, "Task title");
        assert.deepEqual(summaries[0].allowedAdditionalDirectories, [
          "shared/reference",
        ]);
        assert.equal(summaries[0].workspacePath, "workspace-a");
      } finally {
        storage.close();
      }
    });
  });

  /** 旧表記を同じ provider とみなし、その候補の中から最終利用が最新の会話だけを選ぶ。 */
  it("getLatestSessionSummaryForProvider は legacy provider 表記を正規化して最新一件だけを返す", async () => {
    await withTempV2Database((dbPath) => {
      const db = new DatabaseSync(dbPath);
      try {
        insertSessionHeader(db, {
          id: "codex-old",
          provider: "codex",
          model: "gpt-old",
          lastActiveAt: 100,
        });
        insertSessionHeader(db, {
          id: "copilot-newest",
          provider: "copilot",
          model: "copilot-model",
          lastActiveAt: 300,
        });
        insertSessionHeader(db, {
          id: "codex-before",
          provider: "\tcodex\t",
          model: "gpt-before",
          lastActiveAt: 200,
        });
        insertSessionHeader(db, {
          id: "codex-latest",
          provider: "\nCodex\u00a0",
          model: "gpt-latest",
          reasoningEffort: "xhigh",
          approvalMode: "never",
          codexSandboxMode: "danger-full-access",
          customAgentName: "reviewer",
          lastActiveAt: 200,
        });
      } finally {
        db.close();
      }

      const storage = new SessionStorageV2(dbPath);
      try {
        const latest = storage.getLatestSessionSummaryForProvider("codex");
        assert.equal(latest?.id, "codex-latest");
        assert.equal(latest?.provider, "codex");
        assert.equal(latest?.model, "gpt-latest");
        assert.equal(latest?.reasoningEffort, "xhigh");
        assert.equal(latest?.approvalMode, "never");
        assert.equal(latest?.codexSandboxMode, "danger-full-access");
        assert.equal(latest?.customAgentName, "reviewer");
        assert.equal(
          storage.getLatestSessionSummaryForProvider("missing"),
          null,
        );
      } finally {
        storage.close();
      }
    });
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "V2 session message はseq/artifactの復元とbookmark stateを同時に保持する"
  // oracle = { type = "contract", ref = "docs/features/message-bookmark-filter.md: 永続化" }
  // fault = "V2 rowのis_bookmarkedを読み落とし、再構成したMessageからbookmark stateが消える"
  // observable = "SessionStorageV2.getSessionが返すmessageのisBookmarked"
  // observation_boundary = "public-boundary"
  // scope = "session-storage-v2 message bookmark read"
  // lifecycle = "permanent"
  // impact = "旧形式sessionを開いた時にbookmark filterの対象が欠落する"
  // distinction = "schema列確認とは別に、artifact joinとseq orderを通した実read projectionを確認する"
  // @end-test-value
  /** 挿入順でなく保存順を使い、履歴に関連するアーティファクトと空のストリームを復元する。 */
  it("getSession は messages を seq 順で復元し artifact と stream: [] を返す", async () => {
    await withTempV2Database((dbPath) => {
      const db = new DatabaseSync(dbPath);
      try {
        const sessionId = insertSessionHeader(db, {
          id: "session-with-messages",
          messageCount: 2,
        });
        insertMessage(db, {
          sessionId,
          seq: 2,
          role: "assistant",
          text: "second",
        });
        const userMessageId = insertMessage(db, {
          sessionId,
          seq: 0,
          role: "user",
          text: "first",
          accent: 1,
          isBookmarked: 1,
          artifactAvailable: 1,
        });
        insertArtifact(db, userMessageId, {
          title: "Result artifact",
          activitySummary: ["done"],
          changedFiles: [],
          runChecks: [],
        });
      } finally {
        db.close();
      }

      const storage = new SessionStorageV2(dbPath);
      try {
        const session = storage.getSession("session-with-messages");
        assert.ok(session);
        assert.deepEqual(session.stream, []);
        assert.deepEqual(
          session.messages.map((message) => message.text),
          ["first", "second"],
        );
        assert.equal(session.messages[0].role, "user");
        assert.equal(session.messages[0].accent, true);
        assert.equal(session.messages[0].isBookmarked, true);
        assert.deepEqual(session.messages[0].artifact, {
          title: "Result artifact",
          activitySummary: ["done"],
          changedFiles: [],
          runChecks: [],
        });
        assert.equal(session.messages[1].role, "assistant");
        assert.equal(session.messages[1].artifact, undefined);
      } finally {
        storage.close();
      }
    });
  });

  /** 登録されていない ID に対して空の会話を合成しない。 */
  it("getSession は存在しない id で null を返す", async () => {
    await withTempV2Database((dbPath) => {
      const storage = new SessionStorageV2(dbPath);
      try {
        assert.equal(storage.getSession("missing-session-id"), null);
      } finally {
        storage.close();
      }
    });
  });

  /** 破損した行を一覧へ混ぜず、個別読み込みでは破損を黙って既定値へ直さない。 */
  it("壊れた allowed_additional_directories_json は summary で skip し detail で throw する", async () => {
    await withTempV2Database((dbPath) => {
      const db = new DatabaseSync(dbPath);
      try {
        insertSessionHeader(db, {
          id: "session-valid",
          taskTitle: "Good session",
          allowedAdditionalDirectoriesJson: JSON.stringify(["shared/valid"]),
        });
        insertSessionHeader(db, {
          id: "session-bad-directories",
          taskTitle: "Bad session",
          allowedAdditionalDirectoriesJson: "{invalid",
        });
      } finally {
        db.close();
      }

      const storage = new SessionStorageV2(dbPath);
      try {
        assert.deepEqual(
          storage.listSessionSummaries().map((session) => session.id),
          ["session-valid"],
        );
        const pageIds = storage
          .listSessionSummaryPage({ scope: "recent", limit: 10 })
          .entries.map((session) => session.id);
        assert.deepEqual(
          new Set(pageIds),
          new Set(["session-valid", "session-bad-directories"]),
        );
        const openPage = storage.listSessionSummaryPage({
          scope: "open",
          sessionIds: [
            "session-valid",
            "session-bad-directories",
            "missing",
            "session-valid",
          ],
          searchText: "",
        });
        assert.deepEqual(openPage.entries.map((session) => session.id).sort(), [
          "session-bad-directories",
          "session-valid",
        ]);
        assert.equal(openPage.entries.length, 2);
        assert.equal(openPage.hasMore, false);
        assert.equal(openPage.nextCursor, null);
        assert.equal("provider" in openPage.entries[0]!, false);
        assert.throws(() => {
          storage.getSession("session-bad-directories");
        });
      } finally {
        storage.close();
      }
    });
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "V2 session upsert はMessageのbookmark stateを保存し、getSessionで再読込できる"
  // oracle = { type = "contract", ref = "docs/features/message-bookmark-filter.md: 永続化" }
  // fault = "upsertSessionのmessage insertがbookmark stateを保存しない"
  // observable = "upsertSession後のSessionStorageV2.getSessionが返すmessageのisBookmarked"
  // observation_boundary = "public-boundary"
  // scope = "session-storage-v2 message bookmark write"
  // lifecycle = "permanent"
  // impact = "本文からbookmarkを追加しても再表示時に解除される"
  // distinction = "手作業のSQL readとは別に、通常のupsert write pathを通して保存契約を確認する"
  // @end-test-value
  /** 会話を保存後に開き直し、ヘッダーだけでなく本文と関連するアーティファクトを復元する。 */
  it("upsertSession は getSession で messages と artifact を復元できる", async () => {
    await withTempV2Database((dbPath) => {
      const storage = new SessionStorageV2(dbPath);
      try {
        const session = createSession(
          "Upsert session",
          "workspace-upsert",
          "char-up",
          "U",
        );

        storage.upsertSession({
          ...session,
          messages: [
            {
              role: "user",
              text: "まずはメッセージ",
              accent: true,
              isBookmarked: true,
              artifact: {
                title: "Upsert artifact",
                activitySummary: ["done"],
                changedFiles: [
                  {
                    kind: "edit",
                    path: "src/app.ts",
                    summary: "updated",
                    diffRows: [],
                  },
                ],
                runChecks: [
                  {
                    label: "test",
                    value: "pass",
                  },
                ],
              },
            },
            {
              role: "assistant",
              text: "了解、実行します。",
            },
          ],
        });

        const loaded = storage.getSession(session.id);
        assert.ok(loaded);
        assert.deepEqual(
          loaded.messages.map((message) => message.text),
          ["まずはメッセージ", "了解、実行します。"],
        );
        assert.equal(loaded.messages[0].role, "user");
        assert.equal(loaded.messages[0].accent, true);
        assert.equal(loaded.messages[0].isBookmarked, true);
        assert.deepEqual(loaded.messages[0].artifact, {
          title: "Upsert artifact",
          activitySummary: ["done"],
          changedFiles: [
            {
              kind: "edit",
              path: "src/app.ts",
              summary: "updated",
              diffRows: [],
            },
          ],
          runChecks: [
            {
              label: "test",
              value: "pass",
            },
          ],
        });
        assert.equal(loaded.messages[1].role, "assistant");
        assert.equal(loaded.messages[1].artifact, undefined);
        assert.deepEqual(loaded.stream, []);
      } finally {
        storage.close();
      }
    });
  });

  /** 一覧の丸ごと置換で、旧会話とその履歴・アーティファクトが残らないことを確かめる。 */
  it("replaceSessions は既存 session/message/artifact を置換する", async () => {
    await withTempV2Database((dbPath) => {
      const storage = new SessionStorageV2(dbPath);
      try {
        const keepSession = createSession(
          "Keep session",
          "workspace-keep",
          "char-k",
          "K",
        );
        const targetSession = createSession(
          "Target session",
          "workspace-target",
          "char-t",
          "T",
        );

        storage.upsertSession({
          ...targetSession,
          messages: [
            {
              role: "user",
              text: "old target message",
              accent: true,
              artifact: {
                title: "Old artifact",
                activitySummary: ["old"],
                changedFiles: [
                  {
                    kind: "edit",
                    path: "old.ts",
                    summary: "old",
                    diffRows: [],
                  },
                ],
                runChecks: [
                  {
                    label: "old-check",
                    value: "pass",
                  },
                ],
              },
            },
          ],
        });
        storage.upsertSession({
          ...keepSession,
          messages: [
            {
              role: "assistant",
              text: "old keep message",
            },
          ],
        });

        storage.replaceSessions([
          {
            ...targetSession,
            taskTitle: "Target replaced",
            messages: [
              {
                role: "assistant",
                text: "new target message",
                artifact: {
                  title: "New artifact",
                  activitySummary: ["new"],
                  changedFiles: [
                    {
                      kind: "add",
                      path: "new.ts",
                      summary: "new",
                      diffRows: [],
                    },
                  ],
                  runChecks: [
                    {
                      label: "new-check",
                      value: "pass",
                    },
                  ],
                },
              },
            ],
          },
        ]);

        assert.deepEqual(
          storage.listSessions().map((session) => ({
            id: session.id,
            taskTitle: session.taskTitle,
          })),
          [{ id: targetSession.id, taskTitle: "Target replaced" }],
        );

        const loaded = storage.getSession(targetSession.id);
        assert.ok(loaded);
        assert.deepEqual(
          loaded.messages.map((message) => message.text),
          ["new target message"],
        );
        assert.deepEqual(loaded.messages[0].artifact, {
          title: "New artifact",
          activitySummary: ["new"],
          changedFiles: [
            {
              kind: "add",
              path: "new.ts",
              summary: "new",
              diffRows: [],
            },
          ],
          runChecks: [
            {
              label: "new-check",
              value: "pass",
            },
          ],
        });
        assert.equal(storage.getSession(keepSession.id), null);

        const db = new DatabaseSync(dbPath);
        try {
          assert.equal(
            readCount(
              db,
              "SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ?",
              keepSession.id,
            ),
            0,
          );
          assert.equal(
            readCount(
              db,
              "SELECT COUNT(*) AS count FROM session_message_artifacts AS a JOIN session_messages AS m ON m.id = a.message_id WHERE m.session_id = ?",
              keepSession.id,
            ),
            0,
          );
        } finally {
          db.close();
        }
      } finally {
        storage.close();
      }
    });
  });

  /** 対象会話とその子行を消し、他の会話の保存内容は残す。 */
  it("deleteSession は child rows を残さず session を削除する", async () => {
    await withTempV2Database((dbPath) => {
      const storage = new SessionStorageV2(dbPath);
      try {
        const targetSession = createSession(
          "Delete target",
          "workspace-delete",
          "char-d",
          "D",
        );
        const keepSession = createSession(
          "Keep session",
          "workspace-keep-2",
          "char-k2",
          "K",
        );

        storage.upsertSession({
          ...targetSession,
          messages: [
            {
              role: "user",
              text: "delete target message",
              accent: true,
              artifact: {
                title: "Delete artifact",
                activitySummary: ["delete"],
                changedFiles: [
                  {
                    kind: "delete",
                    path: "delete.ts",
                    summary: "delete",
                    diffRows: [],
                  },
                ],
                runChecks: [
                  {
                    label: "delete-check",
                    value: "pass",
                  },
                ],
              },
            },
          ],
        });
        storage.upsertSession({
          ...keepSession,
          messages: [
            {
              role: "assistant",
              text: "keep session message",
            },
          ],
        });

        storage.deleteSession(targetSession.id);

        assert.equal(storage.getSession(targetSession.id), null);
        assert.ok(storage.getSession(keepSession.id));

        const db = new DatabaseSync(dbPath);
        try {
          assert.equal(
            readCount(
              db,
              "SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ?",
              targetSession.id,
            ),
            0,
          );
          assert.equal(
            readCount(
              db,
              "SELECT COUNT(*) AS count FROM session_message_artifacts AS a JOIN session_messages AS m ON m.id = a.message_id WHERE m.session_id = ?",
              targetSession.id,
            ),
            0,
          );
          assert.equal(
            readCount(db, "SELECT COUNT(*) AS count FROM session_messages"),
            1,
          );
          assert.equal(
            readCount(
              db,
              "SELECT COUNT(*) AS count FROM session_message_artifacts",
            ),
            0,
          );
        } finally {
          db.close();
        }
      } finally {
        storage.close();
      }
    });
  });

  /** 全会話の消去後に、参照先を失った履歴や付随情報が DB に残らないことを確かめる。 */
  it("clearSessions は child rows を残さず session を全削除する", async () => {
    await withTempV2Database((dbPath) => {
      const storage = new SessionStorageV2(dbPath);
      try {
        const firstSession = createSession(
          "Clear first",
          "workspace-clear-1",
          "char-c1",
          "C",
        );
        const secondSession = createSession(
          "Clear second",
          "workspace-clear-2",
          "char-c2",
          "C",
        );

        storage.upsertSession({
          ...firstSession,
          messages: [
            {
              role: "user",
              text: "first message",
              accent: true,
              artifact: {
                title: "Clear artifact",
                activitySummary: ["clear"],
                changedFiles: [
                  {
                    kind: "edit",
                    path: "clear.ts",
                    summary: "clear",
                    diffRows: [],
                  },
                ],
                runChecks: [
                  {
                    label: "clear-check",
                    value: "pass",
                  },
                ],
              },
            },
          ],
        });
        storage.upsertSession({
          ...secondSession,
          messages: [
            {
              role: "assistant",
              text: "second message",
            },
          ],
        });

        storage.clearSessions();

        assert.deepEqual(storage.listSessions(), []);

        const db = new DatabaseSync(dbPath);
        try {
          assert.equal(
            readCount(db, "SELECT COUNT(*) AS count FROM sessions"),
            0,
          );
          assert.equal(
            readCount(db, "SELECT COUNT(*) AS count FROM session_messages"),
            0,
          );
          assert.equal(
            readCount(
              db,
              "SELECT COUNT(*) AS count FROM session_message_artifacts",
            ),
            0,
          );
        } finally {
          db.close();
        }
      } finally {
        storage.close();
      }
    });
  });
});

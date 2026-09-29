import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import type { CharacterRuntimeSnapshot } from "../../src-shared/character/character-catalog.js";
import { UNKNOWN_CHARACTER_OWNER_ID } from "../../src-shared/character/character-owner.js";
import { buildNewSession, getSessionIncarnationId, type MessageArtifact } from "../../src-shared/session/session-state.js";
import { resolveCharacterAuthoringRuntimeSessionForTurn } from "../../src-electron/character/character-authoring-service.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";

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

function createArtifact(): MessageArtifact {
  return {
    title: "Run result",
    activitySummary: ["edited file"],
    operationTimeline: [
      {
        type: "tool",
        summary: "apply patch",
        details: "large operation details",
      },
    ],
    changedFiles: [
      {
        kind: "edit",
        path: "src/example.ts",
        summary: "updated example",
        diffRows: [
          {
            kind: "add",
            rightNumber: 1,
            rightText: "const value = true;",
          },
        ],
      },
    ],
    runChecks: [{ label: "npm test", value: "pass" }],
  };
}

function createCharacterRuntimeSnapshot(
  characterId: string,
  name: string,
): CharacterRuntimeSnapshot {
  return {
    characterId,
    name,
    description: "",
    iconFilePath: "",
    theme: { main: "#6f8cff", sub: "#6fb8c7" },
    definitionMarkdown: `# Character\n${name}`,
    definitionSha256: `${characterId}-sha256`,
    definitionByteSize: name.length,
    snapshotAt: "2026-08-01T00:00:00.000Z",
  };
}

function insertCharacterRows(dbPath: string, characterIds: readonly string[]): void {
  const db = new DatabaseSync(dbPath);
  try {
    const insert = db.prepare(`
      INSERT INTO characters (id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const characterId of characterIds) {
      insert.run(
        characterId,
        characterId,
        "2026-08-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
      );
    }
  } finally {
    db.close();
  }
}

function insertAuxiliarySessionRows(dbPath: string, rows: Array<{ id: string; parentSessionId: string }>): void {
  const db = new DatabaseSync(dbPath);
  try {
    const statement = db.prepare(`
      INSERT INTO auxiliary_sessions (
        id,
        parent_session_id,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, 'active', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
    `);
    for (const row of rows) {
      statement.run(row.id, row.parentSessionId);
    }
  } finally {
    db.close();
  }
}

function listAuxiliarySessionParentIds(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare(`
      SELECT parent_session_id AS parentSessionId
      FROM auxiliary_sessions
      ORDER BY parent_session_id ASC
    `).all() as Array<{ parentSessionId: string }>;
    return rows.map((row) => row.parentSessionId);
  } finally {
    db.close();
  }
}

function insertSessionTurnRows(
  dbPath: string,
  rows: Array<{
    sessionId?: string | null;
    auxiliarySessionId?: string | null;
    summary: string;
  }>,
): void {
  const db = new DatabaseSync(dbPath);
  try {
    const statement = db.prepare(`
      INSERT INTO session_turns_v6 (
        session_id,
        auxiliary_session_id,
        provider_id,
        phase,
        summary,
        started_at,
        updated_at
      ) VALUES (?, ?, 'codex', 'completed', ?, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
    `);
    for (const row of rows) {
      statement.run(
        row.sessionId ?? null,
        row.auxiliarySessionId ?? null,
        row.summary,
      );
    }
  } finally {
    db.close();
  }
}

function listSessionTurnSummaries(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare(`
      SELECT summary
      FROM session_turns_v6
      ORDER BY summary ASC
    `).all() as Array<{ summary: string }>;
    return rows.map((row) => row.summary);
  } finally {
    db.close();
  }
}

describe("SessionStorageV6", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "Session summary のID指定読取は会話テーブルを参照せず、対象行の表示・実行metadataだけを返す"
  // oracle = { type = "contract", ref = "docs/design/electron-session-store.md#読取と通知" }
  // fault = "summary読取がgetSessionを経由してmessage履歴まで走査する"
  // observable = "会話テーブルが利用不能でも取得できる対象summaryと、存在しないIDのnull"
  // observation_boundary = "public-boundary"
  // scope = "session-storage-v6"
  // lifecycle = "permanent"
  // impact = "長い会話の復元前にSessionのshellとfile/contextを表示できない"
  // distinction = "型検査と既存の全Session読取testではDB会話テーブルへのアクセスを検出できない"
  // @end-test-value
  it("ID指定のsummary読取はmessage tableに依存しない", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-summary-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const session = storage.insertSession({
        ...buildNewSession({
          taskTitle: "Summary only",
          workspaceLabel: "workspace",
          workspacePath: "C:/workspace",
          branch: "main",
          characterId: "char-a",
          character: "A",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        messages: [{ role: "user", text: "long conversation" }],
      });

      const db = new DatabaseSync(dbPath);
      try {
        db.exec("ALTER TABLE session_messages_v6 RENAME TO inaccessible_session_messages_v6");
      } finally {
        db.close();
      }

      const summary = storage.getSessionSummary(session.id);
      assert.equal(summary?.id, session.id);
      assert.equal(summary?.taskTitle, "Summary only");
      assert.equal(summary?.workspacePath, "C:/workspace");
      assert.equal(summary ? "messages" in summary : true, false);
      assert.equal(storage.getSessionSummary("missing-session"), null);
      assert.throws(() => storage?.getSession(session.id), /session_messages_v6/);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Main SessionのReviewerは新規作成でUserになり、V6 runtime policyでroundtripし未知値はUserへ正規化される"
  // oracle = { type = "contract", ref = "CODEX-AUTO-REVIEW-AR-2" }
  // fault = "Auto-review選択が再起動で消える、新規値がUser以外になる、または未知値がAuto-reviewへ昇格する"
  // observable = "保存後・再読込後のcodexReviewer値"
  // observation_boundary = "public-boundary"
  // scope = "session-storage-v6"
  // lifecycle = "permanent"
  // @end-test-value
  it("ReviewerをV6 runtime policyでroundtripし新規・未知値をUserとして読む", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-speed-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const fastSession = storage.insertSession(buildNewSession({
        id: "fast-session",
        taskTitle: "Fast session",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
        codexSpeed: "fast",
        codexReviewer: "auto-review",
      }));
      const legacySession = storage.insertSession(buildNewSession({
        id: "legacy-session",
        taskTitle: "Legacy session",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      }));
      assert.equal(storage.getSession(legacySession.id)?.codexReviewer, "user");
      storage.close();
      storage = null;

      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE sessions_v6 SET runtime_policy_json = json_set(runtime_policy_json, '$.codexReviewer', 'unexpected') WHERE id = ?").run(legacySession.id);
      db.close();

      storage = new SessionStorageV6(dbPath);
      assert.equal(storage.getSession(fastSession.id)?.codexSpeed, "fast");
      assert.equal(storage.getSession(legacySession.id)?.codexSpeed, "standard");
      assert.equal(storage.getSession(fastSession.id)?.codexReviewer, "auto-review");
      assert.equal(storage.getSession(legacySession.id)?.codexReviewer, "user");
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "V6 Sessionのpin操作はupdatedAtと本文を変えず、古いSessionの保存や再読込後もpinを保持し、解除できる"
  // oracle = { type = "contract", ref = "SessionStorageV6.setSessionPinned / upsertSession のpin独立更新契約" }
  // fault = "pin操作で本文や更新日時を変える、古いSession保存でpinを巻き戻す、または再読込時にpinを失う"
  // observable = "setSessionPinnedの返却summaryとgetSessionが返すisPinned・messages、存在しないIDの例外"
  // observation_boundary = "public-boundary"
  // scope = "session-storage-v6-pin"
  // lifecycle = "permanent"
  // impact = "Homeのpin選択が保存で失われるか、pin操作だけで会話の更新順や本文が変わる"
  // distinction = "型検査やsummary pageのquery確認では検出できない、pin専用更新と通常保存・再接続の組合せを実DBで確認する"
  // @end-test-value
  it("pin stateだけを更新し、updatedAtと本文を維持して再読込できる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const session = storage.insertSession({
        ...buildNewSession({
          id: "pin-session",
          taskTitle: "Pin session",
          workspaceLabel: "workspace",
          workspacePath: "C:/workspace",
          branch: "main",
          characterId: "char-a",
          character: "A",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        updatedAt: "2026-08-09T04:38:00.000Z",
        messages: [{ role: "user", text: "keep me" }],
      });

      const pinned = storage.setSessionPinned(session.id, true);
      assert.equal(pinned.isPinned, true);
      assert.equal(pinned.updatedAt, session.updatedAt);
      assert.equal(storage.getSession(session.id)?.messages[0]?.text, "keep me");
      storage.upsertSession({ ...session, taskTitle: "Updated title", isPinned: false });
      assert.equal(storage.getSession(session.id)?.isPinned, true);

      storage.close();
      storage = new SessionStorageV6(dbPath);
      assert.equal(storage.getSession(session.id)?.isPinned, true);
      assert.equal(storage.setSessionPinned(session.id, false).isPinned, false);
      assert.throws(() => storage?.setSessionPinned("missing", true), /session could not be found/);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "V6 Main Session message は bookmark state を JSON projection と再起動後の読込で保持する"
  // oracle = { type = "contract", ref = "docs/features/message-bookmark-filter.md: 永続化" }
  // fault = "V6 message JSON projectionからbookmark stateを落とし、再起動後に解除する"
  // observable = "SessionStorageV6のgetSessionが返すmessagesのisBookmarked"
  // observation_boundary = "public-boundary"
  // scope = "session-storage-v6-message-bookmark"
  // lifecycle = "permanent"
  // impact = "通常Sessionの本文状態とMessages filterが再起動後に食い違う"
  // distinction = "既存のruntime policy確認とは別に、message JSONの保存と再読込を直接確認する"
  // @end-test-value
  it("message bookmark は V6 の再読込後も保持する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-message-bookmark-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const session = storage.insertSession({
        ...buildNewSession({
          id: "bookmark-session-v6",
          taskTitle: "Bookmark session",
          workspaceLabel: "workspace",
          workspacePath: "C:/workspace",
          branch: "main",
          characterId: "char-a",
          character: "A",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        messages: [
          { role: "user", text: "bookmark me", isBookmarked: true },
          { role: "assistant", text: "ordinary message" },
        ],
      });

      assert.equal(storage.getSession(session.id)?.messages[0]?.isBookmarked, true);
      storage.close();
      storage = new SessionStorageV6(dbPath);
      assert.equal(storage.getSession(session.id)?.messages[0]?.isBookmarked, true);
      assert.equal(storage.getSession(session.id)?.messages[1]?.isBookmarked, undefined);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Session title・bookmark・実行オプションの個別更新は既存message履歴と別incarnationの保存状態を壊さない"
  // oracle = { type = "contract", ref = "docs/design/database-schema.md: Sessionとmessageの個別保存境界" }
  // fault = "個別更新をSession全体の再保存へ戻し、本文または別incarnationへ影響させる"
  // observable = "V6実DBの対象Session再読込、message本文、旧incarnation更新拒否"
  // observation_boundary = "public-boundary"
  // scope = "session-storage-v6-narrow-updates"
  // lifecycle = "permanent"
  // impact = "選択変更やbookmark操作で会話履歴が消える、または削除再作成後の別Sessionへ更新が流入する"
  // distinction = "通常の全Session upsertではなく、個別metadata・message行更新とincarnation境界を実DBで確認する"
  // @end-test-value
  it("個別metadata更新は履歴とincarnation境界を保持する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-narrow-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    const storage = new SessionStorageV6(dbPath);
    try {
      const session = storage.insertSession({
        ...buildNewSession({
          id: "narrow-session", taskTitle: "Before", workspaceLabel: "workspace",
          workspacePath: "C:/workspace", branch: "main", characterId: "char-a", character: "A",
          characterIconPath: "", characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        messages: [{ role: "user", text: "keep" }, { role: "assistant", text: "response" }],
      });
      const owner = getSessionIncarnationId(session);
      storage.setSessionTitle(session.id, owner, "After");
      storage.setSessionMessageBookmark(session.id, owner, 1, true);
      storage.setSessionExecutionOptions(session.id, owner, {
        catalogRevision: session.catalogRevision, model: "gpt-new", reasoningEffort: "medium",
        approvalMode: session.approvalMode, codexSandboxMode: session.codexSandboxMode,
        codexSpeed: session.codexSpeed, codexReviewer: session.codexReviewer,
        customAgentName: "Custom",
      });
      const stored = storage.getSession(session.id)!;
      assert.equal(stored.taskTitle, "After");
      assert.equal(stored.model, "gpt-new");
      assert.equal(stored.customAgentName, "Custom");
      assert.deepEqual(stored.messages.map((message) => message.text), ["keep", "response"]);
      assert.equal(stored.messages[1]?.isBookmarked, true);
      storage.updateSession({
        ...session,
        messages: [...session.messages, { role: "assistant", text: "later" }],
      });
      assert.equal(storage.getSession(session.id)?.messages[1]?.isBookmarked, true);
      storage.deleteSession(session.id);
      storage.insertSession({ ...session, taskTitle: "Recreated" });
      assert.throws(() => storage.setSessionTitle(session.id, owner, "Wrong"), /could not be found/i);
      assert.throws(() => storage.setSessionMessageBookmark(session.id, owner, 0, true), /could not be found/i);
      assert.throws(() => storage.setSessionExecutionOptions(session.id, owner, {
        catalogRevision: session.catalogRevision, model: session.model, reasoningEffort: session.reasoningEffort,
        approvalMode: session.approvalMode, codexSandboxMode: session.codexSandboxMode,
        codexSpeed: session.codexSpeed, codexReviewer: session.codexReviewer, customAgentName: "",
      }), /could not be found/i);
      assert.equal(storage.getSession(session.id)?.taskTitle, "Recreated");
    } finally {
      storage.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "V6 summary pageはkeyset境界、検索条件、pinned/open projection、Character usageをboundedに処理する"
  // oracle = { type = "contract", ref = "src-electron/session/session-storage-v6.ts#listSessionSummaryPage" }
  // fault = "cursorとqueryの不一致やopen ID件数制約を受け入れる、projectionへ詳細を混ぜる、またはusageを誤る"
  // observable = "summary page entries/hasMore/nextCursor、validation error、open projection keys、Character usage"
  // observation_boundary = "public-boundary"
  // scope = "session-storage-v6-summary-page"
  // lifecycle = "permanent"
  // impact = "HomeのSession一覧が別queryの結果やprovider内部情報を表示する"
  // distinction = "keyset、literal search、scope別projection、invalid cursor/limitを実DBで横断確認する"
  // @end-test-value
  it("summary page は keyset境界、検索、pinned/open projection、Character usageをboundedに扱う", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const baseInput = {
        workspaceLabel: "Workspace Label",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      };
      const insert = (
        id: string,
        taskTitle: string,
        updatedAt: string,
        characterId = "char-a",
        sessionKind: "default" | "character-authoring" = "default",
      ) => storage?.insertSession({
        ...buildNewSession({ ...baseInput, id, taskTitle, characterId, sessionKind }),
        updatedAt,
      });

      insert("same-a", "100% literal", "2026-08-10T00:00:00.000Z");
      insert("same-b", "underscore_value", "2026-08-10T00:00:00.000Z");
      insert("older", "Older", "2026-08-09T00:00:00.000Z", "char-b");
      insert("new-character", "Character history", "2026-08-11T00:00:00.000Z", "char-b");
      insert("old-character", "Old character history", "2026-08-08T00:00:00.000Z", "char-a");
      insert("authoring", "Authoring history", "2026-08-12T00:00:00.000Z", "char-a", "character-authoring");
      storage?.setSessionPinned("older", true);

      const firstPage = storage?.listSessionSummaryPage({ scope: "recent", limit: 2 });
      assert.deepEqual(firstPage?.entries.map((entry) => entry.id), ["authoring", "new-character"]);
      assert.equal(firstPage?.hasMore, true);
      assert.ok(firstPage?.nextCursor);
      const secondPage = storage?.listSessionSummaryPage({ scope: "recent", limit: 2, cursor: firstPage?.nextCursor });
      assert.deepEqual(secondPage?.entries.map((entry) => entry.id), ["same-b", "same-a"]);
      assert.deepEqual(
        new Set([...(firstPage?.entries ?? []), ...(secondPage?.entries ?? [])].map((entry) => entry.id)).size,
        4,
      );

      const literalPercent = storage?.listSessionSummaryPage({ scope: "recent", searchText: "%", limit: 10 });
      assert.deepEqual(literalPercent?.entries.map((entry) => entry.id), ["same-a"]);
      const literalUnderscore = storage?.listSessionSummaryPage({ scope: "recent", searchText: "_", limit: 10 });
      assert.deepEqual(literalUnderscore?.entries.map((entry) => entry.id), ["same-b"]);
      assert.throws(
        () => storage?.listSessionSummaryPage({ scope: "recent", cursor: firstPage?.nextCursor, searchText: "changed" }),
        /does not match the current query/,
      );

      const pinnedPage = storage?.listSessionSummaryPage({ scope: "pinned" });
      assert.deepEqual(pinnedPage?.entries.map((entry) => entry.id), ["older"]);
      const openPage = storage?.listSessionSummaryPage({
        scope: "open",
        sessionIds: ["older", "same-a", "missing", "older"],
        searchText: "",
      });
      assert.deepEqual(openPage?.entries.map((entry) => entry.id).sort(), ["older", "same-a"]);
      assert.equal(openPage?.entries.length, 2);
      assert.equal(openPage?.hasMore, false);
      assert.equal(openPage?.nextCursor, null);
      assert.deepEqual(Object.keys(openPage?.entries[0] ?? {}).sort(), [
        "accessMode",
        "character",
        "characterIconPath",
        "characterId",
        "characterThemeColors",
        "id",
        "isPinned",
        "runState",
        "sessionKind",
        "sourceSchemaVersion",
        "status",
        "taskTitle",
        "updatedAt",
        "workspaceLabel",
        "workspacePath",
      ]);
      assert.equal("provider" in (openPage?.entries[0] ?? {}), false);
      assert.equal("threadId" in (openPage?.entries[0] ?? {}), false);
      assert.throws(
        () => storage?.listSessionSummaryPage({ scope: "open", sessionIds: ["older", "same-a"], limit: 1 }),
        /at least the number of requested IDs/,
      );

      assert.deepEqual(storage?.listSessionCharacterUsage().map((entry) => entry.characterId), ["char-b", "char-a"]);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Character authoring Sessionのruntime snapshot修復は非同期resolverの解決済みSessionを返す"
  // oracle = { type = "contract", ref = "src-electron/character-authoring-service.ts#resolveCharacterAuthoringRuntimeSessionForTurn" }
  // fault = "非同期Character resolverを待たずPromise由来の未解決値をruntime Sessionへ設定する"
  // observable = "resolver完了後に返されたSessionのcharacterId・snapshot・character"
  // observation_boundary = "public-boundary"
  // scope = "session-storage-v6-character-authoring"
  // lifecycle = "permanent"
  // @end-test-value
  it("snapshot を作れない Character authoring Session も修復対象 ID を round-trip する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const session = buildNewSession({
        id: "repair-muse",
        taskTitle: "Muse の character.md 改善",
        workspaceLabel: "Muse authoring",
        workspacePath: "C:/characters/muse",
        branch: "main",
        sessionKind: "character-authoring",
        characterId: "muse",
        character: "Muse",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        characterRuntimeSnapshot: null,
        approvalMode: DEFAULT_APPROVAL_MODE,
      });

      storage.insertSession(session);
      storage.close();
      storage = new SessionStorageV6(dbPath);

      const reloaded = storage.getSession(session.id);
      assert.ok(reloaded);
      assert.equal(reloaded.characterId, "muse");
      assert.equal(reloaded.character, "Muse");
      assert.equal(reloaded.characterRuntimeSnapshot, null);

      const resolvedCharacterIds: string[] = [];
      const resolved = await resolveCharacterAuthoringRuntimeSessionForTurn(reloaded, async (characterId) => {
        resolvedCharacterIds.push(characterId);
        return await Promise.resolve({
          ...createCharacterRuntimeSnapshot(characterId, "Muse repaired"),
          description: "修復済み",
        });
      });

      assert.deepEqual(resolvedCharacterIds, ["muse"]);
      assert.equal(resolved.characterId, "muse");
      assert.equal(resolved.characterRuntimeSnapshot?.characterId, "muse");
      assert.equal(resolved.character, "Muse repaired");
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("snapshot を作れない通常 Session も stable Character ID を round-trip する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const session = buildNewSession({
        id: "default-invalid-muse",
        taskTitle: "Muse session",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "muse-id",
        character: "Muse Display",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        characterRuntimeSnapshot: null,
        approvalMode: DEFAULT_APPROVAL_MODE,
      });

      storage.insertSession(session);
      storage.close();
      storage = new SessionStorageV6(dbPath);

      const reloaded = storage.getSession(session.id);
      assert.ok(reloaded);
      assert.equal(reloaded.sessionKind, "default");
      assert.equal(reloaded.characterId, "muse-id");
      assert.equal(reloaded.character, "Muse Display");
      assert.equal(reloaded.characterRuntimeSnapshot, null);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("legacy row の owner を trim し、欠損時は表示名や snapshot から推測しない", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      insertCharacterRows(dbPath, ["muse"]);
      const sessions = [
        buildNewSession({
          id: "whitespace-runtime-owner",
          taskTitle: "Whitespace owner",
          workspaceLabel: "workspace",
          workspacePath: "C:/workspace",
          branch: "main",
          characterId: "muse",
          character: "Muse Display",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          characterRuntimeSnapshot: null,
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        {
          ...buildNewSession({
            id: "missing-runtime-owner",
            taskTitle: "Missing owner",
            workspaceLabel: "workspace",
            workspacePath: "C:/workspace",
            branch: "main",
            characterId: "muse",
            character: "Display Name",
            characterIconPath: "",
            characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
            characterRuntimeSnapshot: null,
            approvalMode: DEFAULT_APPROVAL_MODE,
          }),
          threadId: "thread-missing-owner",
        },
        {
          ...buildNewSession({
            id: "snapshot-only-owner",
            taskTitle: "Snapshot only owner",
            workspaceLabel: "workspace",
            workspacePath: "C:/workspace",
            branch: "main",
            characterId: "muse",
            character: "Snapshot Display",
            characterIconPath: "",
            characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
            characterRuntimeSnapshot: createCharacterRuntimeSnapshot("muse", "Snapshot Display"),
            approvalMode: DEFAULT_APPROVAL_MODE,
          }),
          threadId: "thread-snapshot-only",
        },
      ];
      sessions.forEach((session) => storage?.insertSession(session));
      storage.close();
      storage = null;

      const db = new DatabaseSync(dbPath);
      const updateOwner = db.prepare(`
        UPDATE sessions_v6
        SET character_id = NULL,
            runtime_policy_json = ?
        WHERE id = ?
      `);
      updateOwner.run(JSON.stringify({
        characterId: " muse ",
        characterName: "Muse Display",
      }), "whitespace-runtime-owner");
      updateOwner.run(JSON.stringify({
        characterName: "Display Name",
      }), "missing-runtime-owner");
      updateOwner.run(JSON.stringify({
        characterName: "Snapshot Display",
      }), "snapshot-only-owner");
      db.close();

      storage = new SessionStorageV6(dbPath);
      assert.equal(storage.getSession("whitespace-runtime-owner")?.characterId, "muse");

      const missingOwner = storage.getSession("missing-runtime-owner");
      assert.equal(missingOwner?.characterId, UNKNOWN_CHARACTER_OWNER_ID);
      assert.notEqual(missingOwner?.characterId, "Display Name");
      assert.equal(missingOwner?.characterRuntimeSnapshot, null);
      assert.equal(missingOwner?.threadId, "");

      const snapshotOnly = storage.getSession("snapshot-only-owner");
      assert.equal(snapshotOnly?.characterId, UNKNOWN_CHARACTER_OWNER_ID);
      assert.equal(snapshotOnly?.characterRuntimeSnapshot, null);
      assert.equal(snapshotOnly?.threadId, "");
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("obsolete field や snapshot を欠損した Character owner の fallback に使わない", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      insertCharacterRows(dbPath, ["muse"]);
      const session = buildNewSession({
        id: "obsolete-authoring-owner",
        taskTitle: "Muse authoring",
        workspaceLabel: "Muse authoring",
        workspacePath: "C:/characters/muse",
        branch: "main",
        sessionKind: "character-authoring",
        characterId: "muse",
        character: "Muse",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        characterRuntimeSnapshot: createCharacterRuntimeSnapshot("muse", "Muse"),
        approvalMode: DEFAULT_APPROVAL_MODE,
      });
      storage.insertSession(session);
      storage.close();
      storage = null;

      const db = new DatabaseSync(dbPath);
      db.prepare(`
        UPDATE sessions_v6
        SET character_id = NULL,
            runtime_policy_json = ?
        WHERE id = ?
      `).run(JSON.stringify({
        authoringCharacterId: "obsolete-owner",
        characterName: "Muse",
      }), session.id);
      db.close();

      storage = new SessionStorageV6(dbPath);
      const reloaded = storage.getSession(session.id);
      assert.ok(reloaded);
      assert.equal(reloaded.characterId, UNKNOWN_CHARACTER_OWNER_ID);
      assert.equal(reloaded.characterRuntimeSnapshot, null);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Character IDとruntime snapshot ownerが異なるSessionはV6へ保存されず、既存データも作成されない"
  // oracle = { type = "contract", ref = "src-electron/session/session-storage-v6.ts#insertSession" }
  // fault = "owner不一致のSessionを保存し、Character authoring runtimeの所有境界を壊す"
  // observable = "validation error and subsequent getSession result"
  // observation_boundary = "public-boundary"
  // scope = "session-storage-v6-character-owner-validation"
  // lifecycle = "permanent"
  // impact = "別Characterのruntime snapshotがSessionへ紐づく"
  // distinction = "異なるownerを持つSessionを実DBへinsertし、拒否とrow不在を確認する"
  // @end-test-value
  it("Character ID と runtime snapshot owner が異なる Session は保存しない", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      insertCharacterRows(dbPath, ["muse", "other"]);
      const mismatched = {
        ...buildNewSession({
          id: "mismatched-owner",
          taskTitle: "Muse authoring",
          workspaceLabel: "Muse authoring",
          workspacePath: "C:/characters/muse",
          branch: "main",
          sessionKind: "character-authoring",
          characterId: "muse",
          character: "Muse",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          characterRuntimeSnapshot: createCharacterRuntimeSnapshot("muse", "Muse"),
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        characterRuntimeSnapshot: createCharacterRuntimeSnapshot("other", "Other"),
      };

      assert.throws(() => storage?.insertSession(mismatched), /Session data cannot be saved because it is invalid/);
      assert.equal(storage.getSession(mismatched.id), null);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "既存rowのruntime snapshot owner不一致時は非同期修復後もrelational ownerとthread無効化を維持する"
  // oracle = { type = "contract", ref = "src-electron/character-authoring-service.ts#resolveCharacterAuthoringRuntimeSessionForTurn" }
  // fault = "非同期Character resolverを待たずowner不一致のPromiseをsnapshotへ保存する"
  // observable = "修復後characterRuntimeSnapshotのownerとthreadId"
  // observation_boundary = "public-boundary"
  // scope = "session-storage-v6-runtime-snapshot-owner"
  // lifecycle = "permanent"
  // @end-test-value
  it("既存 row の runtime snapshot owner が不一致なら relational owner を維持して snapshot と thread を無効化する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      insertCharacterRows(dbPath, ["muse", "other"]);
      const sessions = (["default", "character-authoring"] as const).map((sessionKind) => ({
        ...buildNewSession({
          id: `corrupted-owner-${sessionKind}`,
          taskTitle: "Muse session",
          workspaceLabel: "Muse workspace",
          workspacePath: "C:/characters/muse",
          branch: "main",
          sessionKind,
          characterId: "muse",
          character: "Muse",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          characterRuntimeSnapshot: createCharacterRuntimeSnapshot("muse", "Muse"),
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        threadId: `thread-for-other-owner-${sessionKind}`,
      }));
      sessions.forEach((session) => storage?.insertSession(session));
      storage.close();
      storage = null;

      const db = new DatabaseSync(dbPath);
      const replaceSnapshot = db.prepare(`
        UPDATE sessions_v6
        SET character_snapshot_json = ?
        WHERE id = ?
      `);
      sessions.forEach((session) => replaceSnapshot.run(
        JSON.stringify(createCharacterRuntimeSnapshot("other", "Other")),
        session.id,
      ));
      db.close();

      storage = new SessionStorageV6(dbPath);
      const summaries = new Map(storage.listSessionSummaries().map((summary) => [summary.id, summary]));
      const reloaded = sessions.map((session) => storage?.getSession(session.id));
      reloaded.forEach((session) => {
        assert.ok(session);
        assert.equal(session.characterId, "muse");
        assert.equal(session.characterRuntimeSnapshot, null);
        assert.equal(session.threadId, "");
        assert.equal(summaries.get(session.id)?.threadId, "");
      });

      const authoringSession = reloaded.find((session) => session?.sessionKind === "character-authoring");
      assert.ok(authoringSession);
      const resolvedAuthoringSession = await resolveCharacterAuthoringRuntimeSessionForTurn(
        authoringSession,
        async () => await Promise.resolve(createCharacterRuntimeSnapshot("muse", "Muse refreshed")),
      );
      assert.equal(resolvedAuthoringSession.characterRuntimeSnapshot?.characterId, "muse");
      assert.equal(resolvedAuthoringSession.threadId, "");

      reloaded.forEach((session) => storage?.upsertSession(session!));
      storage.close();
      storage = new SessionStorageV6(dbPath);
      sessions.forEach((session) => assert.equal(storage?.getSession(session.id)?.threadId, ""));
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("getLatestSessionSummaryForProvider は legacy provider 表記を正規化して最新一件だけを返す", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const createSession = (
        id: string,
        provider: string,
        model: string,
      ) => buildNewSession({
        id,
        taskTitle: id,
        workspaceLabel: id,
        workspacePath: `C:/${id}`,
        branch: "main",
        provider,
        model,
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      });
      storage.insertSession(createSession("codex-old", "codex", "gpt-old"));
      storage.insertSession(createSession("copilot-newest", "copilot", "copilot-model"));
      storage.insertSession(createSession("codex-before", "codex", "gpt-before"));
      storage.insertSession({
        ...createSession("codex-latest", "codex", "gpt-latest"),
        reasoningEffort: "xhigh",
        approvalMode: "never",
        codexSandboxMode: "danger-full-access",
        customAgentName: "reviewer",
      });

      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE sessions_v6 SET last_active_at = ? WHERE id = ?").run(100, "codex-old");
      db.prepare("UPDATE sessions_v6 SET last_active_at = ? WHERE id = ?").run(300, "copilot-newest");
      db.prepare("UPDATE sessions_v6 SET provider_id = ?, last_active_at = ? WHERE id = ?")
        .run("\tcodex\t", 200, "codex-before");
      db.prepare("UPDATE sessions_v6 SET provider_id = ?, last_active_at = ? WHERE id = ?")
        .run("\nCodex\u00a0", 200, "codex-latest");
      db.close();

      const latest = storage.getLatestSessionSummaryForProvider("codex");
      assert.equal(latest?.id, "codex-latest");
      assert.equal(latest?.provider, "codex");
      assert.equal(latest?.model, "gpt-latest");
      assert.equal(latest?.reasoningEffort, "xhigh");
      assert.equal(latest?.approvalMode, "never");
      assert.equal(latest?.codexSandboxMode, "danger-full-access");
      assert.equal(latest?.customAgentName, "reviewer");
      assert.equal(storage.getLatestSessionSummaryForProvider("missing"), null);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "V6 insertSessionは別connectionからの同一ID createを拒否し、先に保存されたSessionを保持する"
  // oracle = { type = "contract", ref = "src-electron/session/session-storage-v6.ts#insertSession" }
  // fault = "同一IDの再createで既存Sessionを上書きするか、collision errorを成功扱いする"
  // observable = "collision error and original Session taskTitle/workspacePath"
  // observation_boundary = "public-boundary"
  // scope = "session-storage-v6-session-id-collision"
  // lifecycle = "permanent"
  // impact = "既存Sessionの本文・workspaceが別createで失われる"
  // distinction = "2つのstorage connectionから同一IDをinsertし、既存rowの値を直接再読込する"
  // @end-test-value
  it("insertSession は別 connection からの同一 ID create を拒否して既存 Session を保持する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let firstStorage: SessionStorageV6 | null = null;
    let secondStorage: SessionStorageV6 | null = null;

    try {
      firstStorage = new SessionStorageV6(dbPath);
      secondStorage = new SessionStorageV6(dbPath);
      const original = buildNewSession({
        id: "collision-session",
        taskTitle: "first",
        workspaceLabel: "workspace-a",
        workspacePath: "C:/workspace-a",
        branch: "main",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      });

      firstStorage.insertSession(original);
      assert.throws(
        () => secondStorage?.insertSession({
          ...original,
          taskTitle: "second",
          workspacePath: "C:/workspace-b",
        }),
        /A Session with the same ID already exists/,
      );
      assert.equal(firstStorage.getSession(original.id)?.taskTitle, "first");
      assert.equal(firstStorage.getSession(original.id)?.workspacePath, "C:/workspace-a");
    } finally {
      secondStorage?.close();
      firstStorage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("既存の artifact_body なし schema は constructor で補完する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE session_messages_v6 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (session_id, seq),
          UNIQUE (id, session_id)
        );
      `);
      db.close();

      storage = new SessionStorageV6(dbPath);
      storage.close();
      storage = null;

      const reopenedDb = new DatabaseSync(dbPath);
      const columns = (reopenedDb.prepare("PRAGMA table_info(session_messages_v6)").all() as Array<{ name: string }>)
        .map((column) => column.name);
      reopenedDb.close();
      assert.equal(columns.includes("artifact_body"), true);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("getSession は artifact summary を返し、detail は getSessionMessageArtifact で遅延取得する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const artifact = createArtifact();
      const session = storage.upsertSession({
        ...buildNewSession({
          taskTitle: "artifact detail",
          workspaceLabel: "workspace",
          workspacePath: "C:/workspace",
          branch: "main",
          characterId: "char-a",
          character: "A",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        messages: [
          {
            role: "assistant",
            text: "done",
            artifact,
          },
        ],
      });

      const loaded = storage.getSession(session.id);
      const loadedArtifact = loaded?.messages[0]?.artifact;
      assert.ok(loadedArtifact);
      assert.equal(loadedArtifact.detailAvailable, true);
      assert.equal(loadedArtifact.operationTimeline?.[0]?.details, undefined);
      assert.deepEqual(loadedArtifact.changedFiles[0]?.diffRows, []);
      assert.deepEqual(loadedArtifact.runChecks, artifact.runChecks);

      const fullArtifact = storage.getSessionMessageArtifact(session.id, 0);
      assert.equal(fullArtifact?.operationTimeline?.[0]?.details, "large operation details");
      assert.equal(fullArtifact?.changedFiles[0]?.diffRows[0]?.rightText, "const value = true;");
      assert.deepEqual(fullArtifact?.runChecks, artifact.runChecks);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("last_active_at が cutoff より前の session id を列挙し、複数削除できる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const baseInput = {
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      };
      const oldSession = storage.upsertSession({
        ...buildNewSession({ ...baseInput, taskTitle: "old" }),
        id: "old",
        updatedAt: "2026-06-01T00:00:00.000Z",
      });
      const cutoffSession = storage.upsertSession({
        ...buildNewSession({ ...baseInput, taskTitle: "cutoff" }),
        id: "cutoff",
        updatedAt: "2026-07-01T00:00:00.000Z",
      });
      const recentSession = storage.upsertSession({
        ...buildNewSession({ ...baseInput, taskTitle: "recent" }),
        id: "recent",
        updatedAt: "2026-07-02T00:00:00.000Z",
      });

      assert.deepEqual(
        storage.listSessionIdsLastActiveBefore({
          cutoffDate: "2026-07-01",
          cutoffTimestampMs: Date.parse("2026-07-01T00:00:00.000Z"),
          cutoffIso: "2026-07-01T00:00:00.000Z",
        }),
        [oldSession.id],
      );

      storage.deleteSessions([oldSession.id, recentSession.id]);

      assert.deepEqual(storage.listSessions().map((session) => session.id), [cutoffSession.id]);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "親Sessionのdelete/replace/clear経路は関連するAuxiliary rowを一貫してcleanupする"
  // oracle = { type = "contract", ref = "src-electron/session-storage-v6.ts" }
  // fault = "親Session削除後にAuxiliary rowを孤立させるか、replace/clearで古いrowを残す"
  // observable = "auxiliary_sessions parent IDs after delete, replace, and clear"
  // observation_boundary = "public-boundary"
  // scope = "session-storage-v6 auxiliary cleanup"
  // lifecycle = "permanent"
  // @end-test-value
  it("親 Session の削除経路で auxiliary_sessions を cleanup する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const baseInput = {
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      };
      const deletedParent = storage.upsertSession({
        ...buildNewSession({ ...baseInput, taskTitle: "deleted parent" }),
        id: "deleted-parent",
      });
      const retainedParent = storage.upsertSession({
        ...buildNewSession({ ...baseInput, taskTitle: "retained parent" }),
        id: "retained-parent",
      });
      const replacedParent = storage.upsertSession({
        ...buildNewSession({ ...baseInput, taskTitle: "replaced parent" }),
        id: "replaced-parent",
      });

      insertAuxiliarySessionRows(dbPath, [
        { id: "aux-deleted", parentSessionId: deletedParent.id },
        { id: "aux-retained", parentSessionId: retainedParent.id },
        { id: "aux-replaced", parentSessionId: replacedParent.id },
      ]);

      storage.deleteSession(deletedParent.id);
      assert.deepEqual(listAuxiliarySessionParentIds(dbPath), [replacedParent.id, retainedParent.id]);

      storage.replaceSessions([{ ...retainedParent, taskTitle: "retained after replace" }]);
      assert.deepEqual(listAuxiliarySessionParentIds(dbPath), [
        retainedParent.id,
      ]);

      storage.clearSessions();
      assert.deepEqual(listAuxiliarySessionParentIds(dbPath), []);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "SessionとAuxiliaryの削除経路は関連session_turns_v6 payloadをcleanupし、保持対象を残す"
  // oracle = { type = "contract", ref = "src-electron/session-storage-v6.ts" }
  // fault = "削除した親またはAuxiliaryのturn payloadを孤立させるか、保持対象のpayloadまで削除する"
  // observable = "session_turns_v6 rows after parent delete, replace, and clear"
  // observation_boundary = "public-boundary"
  // scope = "session-storage-v6 session turn cleanup"
  // lifecycle = "permanent"
  // @end-test-value
  it("Session / Auxiliary 削除経路で session_turns_v6 payload を cleanup する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const baseInput = {
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      };
      const deletedParent = storage.upsertSession({
        ...buildNewSession({ ...baseInput, taskTitle: "deleted parent audit" }),
        id: "deleted-audit-parent",
      });
      const retainedParent = storage.upsertSession({
        ...buildNewSession({ ...baseInput, taskTitle: "retained parent audit" }),
        id: "retained-audit-parent",
      });
      const replacedParent = storage.upsertSession({
        ...buildNewSession({ ...baseInput, taskTitle: "replaced parent audit" }),
        id: "replaced-audit-parent",
      });
      insertAuxiliarySessionRows(dbPath, [
        { id: "aux-audit-deleted", parentSessionId: deletedParent.id },
        { id: "aux-audit-retained", parentSessionId: retainedParent.id },
        { id: "aux-audit-replaced", parentSessionId: replacedParent.id },
      ]);
      insertSessionTurnRows(dbPath, [
        { sessionId: deletedParent.id, summary: "audit-deleted-session" },
        { sessionId: retainedParent.id, summary: "audit-retained-session" },
        { sessionId: replacedParent.id, summary: "audit-replaced-session" },
        { auxiliarySessionId: "aux-audit-deleted", summary: "audit-deleted-auxiliary" },
        { auxiliarySessionId: "aux-audit-retained", summary: "audit-retained-auxiliary" },
        { auxiliarySessionId: "aux-audit-replaced", summary: "audit-replaced-auxiliary" },
      ]);

      storage.deleteSession(deletedParent.id);
      assert.deepEqual(listSessionTurnSummaries(dbPath), [
        "audit-replaced-auxiliary",
        "audit-replaced-session",
        "audit-retained-auxiliary",
        "audit-retained-session",
      ]);

      storage.replaceSessions([{ ...retainedParent, taskTitle: "retained audit after replace" }]);
      assert.deepEqual(listSessionTurnSummaries(dbPath), [
        "audit-retained-auxiliary",
        "audit-retained-session",
      ]);

      storage.clearSessions();
      assert.deepEqual(listSessionTurnSummaries(dbPath), []);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("artifact_body がない既存 row でも getSessionMessageArtifact は body から復元する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;
    let reopened: SessionStorageV6 | null = null;

    try {
      const artifact = createArtifact();
      storage = new SessionStorageV6(dbPath);
      const session = storage.upsertSession({
        ...buildNewSession({
          taskTitle: "legacy artifact detail",
          workspaceLabel: "workspace",
          workspacePath: "C:/workspace",
          branch: "main",
          characterId: "char-a",
          character: "A",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        messages: [{ role: "assistant", text: "done", artifact }],
      });
      storage.close();
      storage = null;

      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE session_messages_v6 SET body = ?, artifact_body = NULL WHERE session_id = ? AND seq = 0")
        .run(JSON.stringify({ role: "assistant", text: "done", artifact }), session.id);
      db.close();

      reopened = new SessionStorageV6(dbPath);
      const loadedArtifact = reopened.getSessionMessageArtifact(session.id, 0);
      assert.equal(loadedArtifact?.operationTimeline?.[0]?.details, "large operation details");
      assert.equal(loadedArtifact?.changedFiles[0]?.diffRows[0]?.rightText, "const value = true;");
    } finally {
      storage?.close();
      reopened?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("summary artifact を再保存しても既存 artifact_body の detail を保持する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const artifact = createArtifact();
      const session = storage.upsertSession({
        ...buildNewSession({
          taskTitle: "preserve artifact detail",
          workspaceLabel: "workspace",
          workspacePath: "C:/workspace",
          branch: "main",
          characterId: "char-a",
          character: "A",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        messages: [{ role: "assistant", text: "done", artifact }],
      });

      const loaded = storage.getSession(session.id);
      assert.ok(loaded);
      assert.equal(loaded.messages[0]?.artifact?.detailAvailable, true);

      storage.upsertSession({
        ...loaded,
        taskTitle: "metadata only update",
        updatedAt: "2026-07-02T15:30:00.000Z",
      });

      const preservedArtifact = storage.getSessionMessageArtifact(session.id, 0);
      assert.equal(preservedArtifact?.operationTimeline?.[0]?.details, "large operation details");
      assert.equal(preservedArtifact?.changedFiles[0]?.diffRows[0]?.rightText, "const value = true;");
      assert.deepEqual(preservedArtifact?.runChecks, artifact.runChecks);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "summary が同じでも full artifact 更新は新しい artifact_body として保存する"
  // fault = "summary 一致だけを理由に、更新された full artifact 本文を既存本文で上書きする"
  // observable = "再読込した artifact_body の更新済み詳細と差分"
  // observation_boundary = "component-behavior"
  // scope = "session-artifact-summary-deduplication"
  // oracle = { type = "contract", ref = "docs/design/v6-database-foundation.md" }
  // lifecycle = "permanent"
  // impact = "大きな artifact 本文の破損または不要な再書込みが発生する"
  // distinction = "metadata-only updateではなく、summaryが同じfull artifactの内容更新を実DBで確認する"
  // @end-test-value
  it("summary が同じ full artifact 更新は既存 artifact_body で上書きしない", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const artifact = createArtifact();
      const session = storage.upsertSession({
        ...buildNewSession({
          taskTitle: "replace artifact detail",
          workspaceLabel: "workspace",
          workspacePath: "C:/workspace",
          branch: "main",
          characterId: "char-a",
          character: "A",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        messages: [{ role: "assistant", text: "done", artifact }],
      });
      const updatedArtifact: MessageArtifact = {
        ...artifact,
        detailAvailable: true,
        operationTimeline: artifact.operationTimeline?.map((operation) => ({
          ...operation,
          details: "updated operation details",
        })),
        changedFiles: artifact.changedFiles.map((file) => ({
          ...file,
          diffRows: file.diffRows.map((row) => ({
            ...row,
            rightText: "const value = false;",
          })),
        })),
      };

      storage.upsertSession({
        ...session,
        updatedAt: "2026-07-02T15:31:00.000Z",
        messages: [{ role: "assistant", text: "done", artifact: updatedArtifact }],
      });

      const replacedArtifact = storage.getSessionMessageArtifact(session.id, 0);
      assert.equal(replacedArtifact?.operationTimeline?.[0]?.details, "updated operation details");
      assert.equal(replacedArtifact?.changedFiles[0]?.diffRows[0]?.rightText, "const value = false;");
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });
  // @test-value v2
  // kind = "invariant"
  // claim = "terminal appendは未変更の履歴message行と作成時刻を保ち、bookmarkとartifact detailを失わない"
  // oracle = { type = "contract", ref = "docs/design/database-schema.md: Session message保存" }
  // fault = "terminal全体保存が全messageを削除再挿入し、既存行ID・時刻・bookmark・artifact detailを失う"
  // observable = "session_messages_v6の既存行id/created_at/body/artifact_body、追加行、再読込bookmarkとartifact detail"
  // observation_boundary = "public-boundary"
  // scope = "session-storage-v6-terminal-message-diff"
  // lifecycle = "permanent"
  // impact = "長い履歴の無用な書込みが増え、既存会話のブックマークと詳細artifactが消える"
  // distinction = "running開始のappend専用経路でなく、terminal full Session保存時の実DB行同一性を確認する"
  // @end-test-value
  it("terminal appendで既存message行とbookmark・artifact detailを保持する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-terminal-diff-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    const storage = new SessionStorageV6(dbPath);
    try {
      const initial = storage.insertSession({
        ...buildNewSession({
          id: "terminal-diff", taskTitle: "Terminal", workspaceLabel: "workspace",
          workspacePath: "C:/workspace", branch: "main", characterId: "char-a", character: "A",
          characterIconPath: "", characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        updatedAt: "2026-09-27T00:00:00.000Z",
        messages: [
          { role: "user", text: "prompt" },
          { role: "assistant", text: "prior answer", artifact: createArtifact() },
        ],
      });
      storage.setSessionMessageBookmark(initial.id, getSessionIncarnationId(initial), 1, true);
      const db = new DatabaseSync(dbPath);
      try {
        const before = db.prepare(`
          SELECT id, seq, role, body, artifact_body, created_at
          FROM session_messages_v6 WHERE session_id = ? ORDER BY seq
        `).all(initial.id);
        const auditLogId = Number(db.prepare(`
          INSERT INTO session_turns_v6 (session_id, phase, started_at, updated_at)
          VALUES (?, 'running', ?, ?)
        `).run(initial.id, "2026-09-27T00:01:00.000Z", "2026-09-27T00:01:00.000Z").lastInsertRowid);
        storage.upsertTerminalSession({
          ...initial,
          status: "idle",
          runState: "idle",
          updatedAt: "2026-09-27T00:02:00.000Z",
          messages: [...initial.messages, { role: "assistant", text: "new answer" }],
        }, {
          auditLogId, sessionId: initial.id, phase: "completed", assistantMessageSeq: 2,
          threadId: initial.threadId, errorMessage: "", completedAt: "2026-09-27T00:02:00.000Z",
        });
        const after = db.prepare(`
          SELECT id, seq, role, body, artifact_body, created_at
          FROM session_messages_v6 WHERE session_id = ? ORDER BY seq
        `).all(initial.id);
        assert.deepEqual(after.slice(0, 2), before);
        assert.equal(after.length, 3);
        assert.equal(after[2]?.created_at, "2026-09-27T00:02:00.000Z");
        assert.equal(storage.getSession(initial.id)?.messages[1]?.isBookmarked, true);
        assert.equal(storage.getSessionMessageArtifact(initial.id, 1)?.operationTimeline?.[0]?.details, "large operation details");
      } finally {
        db.close();
      }
    } finally {
      storage.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "実行中の確定Main messageのBookmark追加と解除は古いruntime snapshotの実行中・終端保存後も保持される"
  // oracle = { type = "contract", ref = "docs/manual-test-checklist.md: MT-023D9A 実行中確定messageのBookmark" }
  // fault = "runtimeの古いmessage配列を再保存してbookmarkの追加または解除を巻き戻す"
  // observable = "upsertSessionとupsertTerminalSessionの返却値および実DB再読込のmessage bookmark値"
  // observation_boundary = "public-boundary"
  // scope = "main-running-message-bookmark"
  // lifecycle = "permanent"
  // impact = "実行中に行ったBookmark操作がturn進行または完了で消える"
  // distinction = "単独のbookmark更新testでは古いruntime snapshotによる後続保存を検出できない"
  // @end-test-value
  it("Main実行中Bookmarkは古いruntime snapshotの保存で巻き戻らない", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-main-running-bookmark-"));
    const dbPath = path.join(directory, "app.db");
    const storage = new SessionStorageV6(dbPath);
    try {
      const initial = storage.insertSession({
        ...buildNewSession({
          id: "running-bookmark-main", taskTitle: "Bookmark", workspaceLabel: "workspace",
          workspacePath: "C:/workspace", branch: "main", characterId: "mate", character: "Mate",
          characterIconPath: "", characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        status: "running", runState: "running",
        messages: [{ role: "user", text: "confirmed" }],
      });
      const owner = getSessionIncarnationId(initial);
      storage.setSessionMessageBookmark(initial.id, owner, 0, true);
      const running = storage.upsertSession({
        ...initial, messages: [...initial.messages, { role: "assistant", text: "confirmed response" }],
      });
      assert.equal(running.messages[0]?.isBookmarked, true);
      assert.equal(storage.getSession(initial.id)?.messages[0]?.isBookmarked, true);

      storage.setSessionMessageBookmark(initial.id, owner, 0, false);
      const db = new DatabaseSync(dbPath);
      try {
        const auditLogId = Number(db.prepare(`
          INSERT INTO session_turns_v6 (session_id, phase, started_at, updated_at)
          VALUES (?, 'running', ?, ?)
        `).run(initial.id, "2026-09-27T00:01:00.000Z", "2026-09-27T00:01:00.000Z").lastInsertRowid);
        const terminal = storage.upsertTerminalSession({
          ...running, status: "idle", runState: "idle", updatedAt: "2026-09-27T00:02:00.000Z",
          messages: [...running.messages, { role: "assistant", text: "final response" }],
        }, {
          auditLogId, sessionId: initial.id, phase: "completed", assistantMessageSeq: 2,
          threadId: initial.threadId, errorMessage: "", completedAt: "2026-09-27T00:02:00.000Z",
        });
        assert.equal(terminal.messages[0]?.isBookmarked, undefined);
        assert.equal(storage.getSession(initial.id)?.messages[0]?.isBookmarked, undefined);
      } finally {
        db.close();
      }
    } finally {
      storage.close();
      await removeDirectoryWithRetry(directory);
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "SessionStorageV6 runtime metadata CAS は対象metadataだけを更新し、本文とpinを保持してstale patchを拒否する"
  // oracle = { type = "contract", ref = "src-electron/session-storage-v6.ts#updateSessionRuntimeMetadataIfMatches" }
  // fault = "runtime metadata CAS がsession全体を書き戻し、本文・pin・並行metadataを上書きする"
  // observable = "getSession の更新済みruntime metadata、messages、isPinned、CAS結果"
  // observation_boundary = "public-boundary"
  // scope = "session-storage-runtime-metadata-cas"
  // lifecycle = "permanent"
  // impact = "会話本文やpinの消失、別revisionのruntime threadの誤無効化につながる"
  // distinction = "SettingsCatalogServiceのmigration flowではなく、storage層の対象列・expected metadata一致を実DBで確認する"
  // @end-test-value
  it("runtime metadata CAS は本文と pin を保持し stale patch を拒否する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-runtime-metadata-cas-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    let storage: SessionStorageV6 | null = null;
    try {
      storage = new SessionStorageV6(dbPath);
      const session = storage.insertSession({
        ...buildNewSession({
          id: "runtime-cas-session",
          taskTitle: "runtime CAS",
          workspaceLabel: "workspace",
          workspacePath: "C:/workspace",
          branch: "main",
          characterId: "char-a",
          character: "A",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        isPinned: true,
        messages: [{ role: "user", text: "keep this" }],
      });
      const expected = {
        provider: session.provider,
        catalogRevision: session.catalogRevision,
        model: session.model,
        reasoningEffort: session.reasoningEffort,
        threadId: session.threadId,
        updatedAt: session.updatedAt,
      };
      const next = {
        ...expected,
        catalogRevision: expected.catalogRevision + 1,
        model: "gpt-5.4-mini",
        reasoningEffort: "medium" as const,
        threadId: "",
        updatedAt: "2026-08-01T00:00:00.000Z",
      };
      const updated = storage.updateSessionRuntimeMetadataIfMatches({
        sessionId: session.id,
        incarnationId: getSessionIncarnationId(session),
        expected,
        next,
      });
      assert.equal(updated?.catalogRevision, next.catalogRevision);
      assert.equal(updated?.model, next.model);
      assert.equal(updated?.reasoningEffort, next.reasoningEffort);
      assert.equal(updated?.threadId, next.threadId);
      assert.equal(updated?.updatedAt, next.updatedAt);
      assert.deepEqual(storage.getSession(session.id)?.messages, session.messages);
      assert.equal(storage.getSession(session.id)?.isPinned, true);
      assert.equal(storage.updateSessionRuntimeMetadataIfMatches({
        sessionId: session.id,
        incarnationId: getSessionIncarnationId(session),
        expected,
        next: { ...next, catalogRevision: next.catalogRevision + 1 },
      }), null);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });
});

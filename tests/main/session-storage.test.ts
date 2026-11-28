import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildNewSession } from "../../src-shared/session/session-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import { SessionStorage } from "../../src-electron/session/session-storage.js";

/** 一時DBディレクトリーの削除を共有違反などに限り再試行し、他のエラーや再試行上限で停止する。 */
async function removeDirectoryWithRetry(
  targetPath: string,
  attempts = 5,
): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const isBusyError =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EBUSY";
      if (!isBusyError || index === attempts - 1) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 50 * (index + 1)));
    }
  }
}

/** タイトルとワークスペースを指定し、残りは固定値で比較用のSessionを組み立てる。 */
function createSession(
  taskTitle: string,
  workspaceLabel: string,
  characterId: string,
  character: string,
) {
  const session = buildNewSession({
    taskTitle,
    workspaceLabel,
    workspacePath: `C:/${workspaceLabel}`,
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

/** 一時DBの読み書きで、SessionのCRUD、要約の投影、破損レコードの扱いを確認する。 */
describe("SessionStorage", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "SessionStorageの同一ID createは既存Sessionを保持し、collisionを拒否する"
  // oracle = { type = "contract", ref = "src-electron/session/session-storage.ts#insertSession" }
  // fault = "同一IDの再createで既存Sessionを上書きするか、collision errorを成功扱いする"
  // observable = "collision error and original Session taskTitle/workspacePath"
  // observation_boundary = "public-boundary"
  // scope = "session-storage-session-id-collision"
  // lifecycle = "permanent"
  // impact = "既存Sessionの本文・workspaceが別createで失われる"
  // distinction = "同一IDをinsertし、collision errorと既存rowの値を確認する"
  // @end-test-value
  /** 同じIDによる新規作成は競合を返し、既存のタイトルとワークスペースを上書きしない。 */
  it("insertSession は同一 ID create を拒否して既存 Session を保持する", async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "withmate-session-storage-"),
    );
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const storage = new SessionStorage(dbPath);
      const original = createSession("first", "workspace-a", "char-a", "A");
      storage.insertSession(original);

      assert.throws(
        () =>
          storage.insertSession({
            ...original,
            taskTitle: "second",
            workspacePath: "C:/workspace-b",
          }),
        /A Session with the same ID already exists/,
      );
      assert.equal(storage.getSession(original.id)?.taskTitle, "first");
      assert.equal(
        storage.getSession(original.id)?.workspacePath,
        original.workspacePath,
      );
      storage.close();
    } finally {
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  /** 全置換後の一覧に新しい集合だけが含まれ、以前のレコードは残らない。 */
  it("replaceSessions で一覧をまとめて置き換えられる", async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "withmate-session-storage-"),
    );
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const storage = new SessionStorage(dbPath);
      const firstSession = createSession("first", "workspace-a", "char-a", "A");
      const secondSession = createSession(
        "second",
        "workspace-b",
        "char-b",
        "B",
      );

      storage.upsertSession(firstSession);
      storage.upsertSession(secondSession);

      const replacement = {
        ...secondSession,
        taskTitle: "second-updated",
        threadId: "",
      };
      storage.replaceSessions([replacement]);

      assert.deepEqual(
        storage
          .listSessions()
          .map((session) => ({ id: session.id, taskTitle: session.taskTitle })),
        [{ id: replacement.id, taskTitle: "second-updated" }],
      );

      storage.close();
    } finally {
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  /** 保存済みSessionが複数ある状態で全削除すると一覧が空になる。 */
  it("clearSessions で全 session を削除できる", async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "withmate-session-storage-"),
    );
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const storage = new SessionStorage(dbPath);
      storage.upsertSession(
        createSession("first", "workspace-a", "char-a", "A"),
      );
      storage.upsertSession(
        createSession("second", "workspace-b", "char-b", "B"),
      );

      storage.clearSessions();

      assert.deepEqual(storage.listSessions(), []);
      storage.close();
    } finally {
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  /** 最終アクティブ時刻がcutoffより前のIDを取得し、複数削除しても対象外のSessionを残す。 */
  it("last_active_at が cutoff より前の session id を列挙し、複数削除できる", async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "withmate-session-storage-"),
    );
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const storage = new SessionStorage(dbPath);
      const oldSession = storage.upsertSession(
        createSession("old", "workspace-old", "char-a", "A"),
      );
      const cutoffSession = storage.upsertSession(
        createSession("cutoff", "workspace-cutoff", "char-b", "B"),
      );
      const recentSession = storage.upsertSession(
        createSession("recent", "workspace-recent", "char-c", "C"),
      );

      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ?").run(
        100,
        oldSession.id,
      );
      db.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ?").run(
        200,
        cutoffSession.id,
      );
      db.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ?").run(
        300,
        recentSession.id,
      );
      db.close();

      assert.deepEqual(
        storage.listSessionIdsLastActiveBefore({
          cutoffDate: "2026-07-01",
          cutoffTimestampMs: 200,
          cutoffIso: "2026-07-01T00:00:00.000Z",
        }),
        [oldSession.id],
      );

      storage.deleteSessions([oldSession.id, recentSession.id]);

      assert.deepEqual(
        storage.listSessions().map((session) => session.id),
        [cutoffSession.id],
      );
      storage.close();
    } finally {
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  /** カスタムエージェント名と追加ディレクトリーが保存・再読込で維持される。 */
  it("customAgentName を保存して読み戻せる", async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "withmate-session-storage-"),
    );
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const storage = new SessionStorage(dbPath);
      const session = storage.upsertSession({
        ...createSession("agent", "workspace-agent", "char-a", "A"),
        provider: "copilot",
        customAgentName: "reviewer",
        allowedAdditionalDirectories: ["C:/shared/reference"],
      });

      const loaded = storage.getSession(session.id);
      storage.close();

      assert.ok(loaded);
      assert.equal(loaded.customAgentName, "reviewer");
      assert.deepEqual(loaded.allowedAdditionalDirectories, [
        "C:/shared/reference",
      ]);
    } finally {
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  /** 旧Provider表記を含む保存行でもCodexの最新1件を要約として取得し、不明または空のProviderではnullを返す。 */
  it("getLatestSessionSummaryForProvider は legacy provider 表記を正規化して最新一件だけを返す", async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "withmate-session-storage-"),
    );
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const storage = new SessionStorage(dbPath);
      const olderCodex = storage.upsertSession({
        ...createSession("older codex", "workspace-codex-old", "char-a", "A"),
        provider: "codex",
        model: "gpt-old",
      });
      const copilot = storage.upsertSession({
        ...createSession("copilot", "workspace-copilot", "char-b", "B"),
        provider: "copilot",
        model: "copilot-model",
      });
      const latestCodex = storage.upsertSession({
        ...createSession("latest codex", "workspace-codex-new", "char-c", "C"),
        provider: "codex",
        model: "gpt-latest",
        reasoningEffort: "xhigh",
        approvalMode: "never",
        codexSandboxMode: "danger-full-access",
        customAgentName: "reviewer",
      });

      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ?").run(
        100,
        olderCodex.id,
      );
      db.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ?").run(
        300,
        copilot.id,
      );
      db.prepare(
        "UPDATE sessions SET provider = ?, last_active_at = ? WHERE id = ?",
      ).run("\t\nCodex\u00a0", 200, latestCodex.id);
      db.close();

      const latest = storage.getLatestSessionSummaryForProvider("codex");
      assert.equal(latest?.id, latestCodex.id);
      assert.equal(latest?.provider, "codex");
      assert.equal(latest?.model, "gpt-latest");
      assert.equal(latest?.reasoningEffort, "xhigh");
      assert.equal(latest?.approvalMode, "never");
      assert.equal(latest?.codexSandboxMode, "danger-full-access");
      assert.equal(latest?.customAgentName, "reviewer");
      assert.equal(storage.getLatestSessionSummaryForProvider("missing"), null);
      assert.equal(storage.getLatestSessionSummaryForProvider("  "), null);
      storage.close();
    } finally {
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  /** 人格作成用Sessionを保存し、再読込後にも通常Sessionと区別する種別が残る。 */
  it("character-authoring sessionKind を含む session を保存して読み戻せる", async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "withmate-session-storage-"),
    );
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const storage = new SessionStorage(dbPath);
      const session = storage.upsertSession({
        ...createSession(
          "character authoring",
          "workspace-character",
          "char-a",
          "A",
        ),
        sessionKind: "character-authoring",
      });

      const loaded = storage.getSession(session.id);
      storage.close();

      assert.ok(loaded);
      assert.equal(loaded.sessionKind, "character-authoring");
    } finally {
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "legacy Session summary projectionはdetail破損時も保存metadataを返し、Role・説明・Codex runtime optionの欠落を既定値へ正規化する"
  // oracle = { type = "contract", ref = "docs/design/electron-session-store.md" }
  // fault = "detail JSONの破損で一覧取得が失敗するか、欠落metadataを不正なRole・設定へ投影する"
  // observable = "再open後のsummary全fieldとdetail破損のerror記録"
  // observation_boundary = "public-boundary"
  // scope = "session-storage-summary"
  // lifecycle = "permanent"
  // @end-test-value
  /** 詳細JSONが読めない行でも要約は正常に取得でき、欠落したメタデータには既定値が使われる。 */
  it("listSessionSummaries は detail JSON が壊れていても summary だけ返せる", async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "withmate-session-storage-"),
    );
    const dbPath = path.join(tempDirectory, "withmate.db");
    const originalConsoleError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      const storage = new SessionStorage(dbPath);
      const session = storage.upsertSession({
        ...createSession("summary", "workspace-summary", "char-a", "A"),
        allowedAdditionalDirectories: ["C:/shared/reference"],
      });
      storage.close();

      const db = new DatabaseSync(dbPath);
      db.prepare(
        "UPDATE sessions SET messages_json = ?, stream_json = ? WHERE id = ?",
      ).run("{", "{", session.id);
      db.close();

      const reopened = new SessionStorage(dbPath);
      const summaries = reopened.listSessionSummaries();
      reopened.close();

      assert.deepEqual(summaries, [
        {
          id: session.id,
          sessionRole: "standalone",
          rootSessionId: session.id,
          parentSessionId: null,
          createdBySessionId: null,
          description: "",
          taskTitle: session.taskTitle,
          status: session.status,
          updatedAt: session.updatedAt,
          isPinned: session.isPinned,
          provider: session.provider,
          catalogRevision: session.catalogRevision,
          workspaceLabel: session.workspaceLabel,
          workspacePath: session.workspacePath,
          branch: session.branch,
          sessionKind: session.sessionKind,
          accessMode: session.accessMode,
          sourceSchemaVersion: session.sourceSchemaVersion,
          characterId: session.characterId,
          character: session.character,
          characterIconPath: session.characterIconPath,
          characterThemeColors: session.characterThemeColors,
          runState: session.runState,
          approvalMode: session.approvalMode,
          codexSandboxMode: session.codexSandboxMode,
          codexSpeed: "standard",
          codexReviewer: "user",
          model: session.model,
          reasoningEffort: session.reasoningEffort,
          customAgentName: session.customAgentName,
          allowedAdditionalDirectories: ["C:/shared/reference"],
          threadId: session.threadId,
        },
      ]);
      assert.equal(errors.length, 0);
    } finally {
      console.error = originalConsoleError;
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  /** Home向けページの件数・カーソルと返却キーを確認し、ProviderやthreadIdのような詳細を投影から除く。 */
  it("listSessionSummaryPage は Home 用の bounded projection だけを返す", async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "withmate-session-storage-"),
    );
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const storage = new SessionStorage(dbPath);
      const session = storage.upsertSession({
        ...createSession("home page", "workspace-home", "char-home", "Home"),
        provider: "copilot",
        model: "hidden-model",
        threadId: "hidden-thread",
        allowedAdditionalDirectories: ["C:/hidden"],
      });
      const secondSession = storage.upsertSession(
        createSession(
          "another page",
          "workspace-another",
          "char-another",
          "Another",
        ),
      );

      const page = storage.listSessionSummaryPage({
        scope: "open",
        sessionIds: [session.id, "missing", secondSession.id, session.id],
        searchText: "",
      });
      assert.deepEqual(
        page.entries.map((entry) => entry.id).sort(),
        [session.id, secondSession.id].sort(),
      );
      assert.equal(page.entries.length, 2);
      assert.equal(page.hasMore, false);
      assert.equal(page.nextCursor, null);
      assert.deepEqual(Object.keys(page.entries[0] ?? {}).sort(), [
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
      assert.equal("provider" in (page.entries[0] ?? {}), false);
      assert.equal("threadId" in (page.entries[0] ?? {}), false);
      storage.close();
    } finally {
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  /** 一覧は破損JSONの行だけをスキップして一度記録し、正常行を引き続き返す。 */
  it("破損 JSON を含む row は listSessions で skip しつつ正常 row を返す", async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "withmate-session-storage-"),
    );
    const dbPath = path.join(tempDirectory, "withmate.db");
    const originalConsoleError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      const storage = new SessionStorage(dbPath);
      const healthy = storage.upsertSession(
        createSession("healthy", "workspace-healthy", "char-a", "A"),
      );
      const corrupted = storage.upsertSession(
        createSession("corrupted", "workspace-corrupted", "char-b", "B"),
      );
      storage.close();

      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE sessions SET messages_json = ? WHERE id = ?").run(
        "{",
        corrupted.id,
      );
      db.close();

      const reopened = new SessionStorage(dbPath);
      const sessions = reopened.listSessions();
      reopened.close();

      assert.deepEqual(
        sessions.map((session) => session.id),
        [healthy.id],
      );
      assert.equal(errors.length, 1);
      assert.equal(errors[0]?.[0], "stored session JSON parse failed");
    } finally {
      console.error = originalConsoleError;
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  /** 単一Sessionの読込では破損行を黙って捨てず、例外にして解析失敗を記録する。 */
  it("破損 JSON を含む row は getSession で throw する", async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "withmate-session-storage-"),
    );
    const dbPath = path.join(tempDirectory, "withmate.db");
    const originalConsoleError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      const storage = new SessionStorage(dbPath);
      const session = storage.upsertSession(
        createSession("broken", "workspace-broken", "char-a", "A"),
      );
      storage.close();

      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE sessions SET stream_json = ? WHERE id = ?").run(
        "{",
        session.id,
      );
      db.close();

      const reopened = new SessionStorage(dbPath);
      assert.throws(
        () => reopened.getSession(session.id),
        /stream_json が壊れている/,
      );
      reopened.close();

      assert.equal(errors.length, 1);
      assert.equal(errors[0]?.[0], "stored session JSON parse failed");
    } finally {
      console.error = originalConsoleError;
      await removeDirectoryWithRetry(tempDirectory);
    }
  });
});

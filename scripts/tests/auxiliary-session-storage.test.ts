import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { buildNewSession } from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE, type ApprovalMode } from "../../src/approval-mode.js";
import type { AuxiliarySession, AuxiliarySessionSummary } from "../../src/auxiliary-session-state.js";
import {
  DEFAULT_CODEX_SANDBOX_MODE,
  type CodexSandboxMode,
} from "../../src/codex-sandbox-mode.js";
import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import type { CompanionSession } from "../../src/companion-state.js";
import type { CharacterCatalogEntry, CharacterRuntimeSnapshot } from "../../src/character/character-catalog.js";
import {
  companionSessionToAuxiliaryParentSession,
  resolveAuxiliaryParentSession,
} from "../../src-electron/auxiliary-parent-session.js";
import { AuxiliarySessionService as AuxiliarySessionServiceImpl } from "../../src-electron/auxiliary-session-service.js";
import {
  AuxiliarySessionStorage,
  resolveLegacyAuxiliaryPreviewFromAuditEntries,
} from "../../src-electron/auxiliary-session-storage.js";
import { CompanionStorage } from "../../src-electron/companion-storage.js";
import { ensureV6Schema } from "../../src-electron/database-schema-v6.js";
import { appendSessionFilesDirectoryForSessionId, resolveSessionFilesDirectory } from "../../src-electron/session-files.js";
import { SessionStorage } from "../../src-electron/session-storage.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";

type AuxiliarySessionServiceDeps = ConstructorParameters<typeof AuxiliarySessionServiceImpl>[0];

class AuxiliarySessionService extends AuxiliarySessionServiceImpl {
  constructor(
    deps: Omit<
      AuxiliarySessionServiceDeps,
      "runProviderRuntimeOperationExclusive" | "resolveSessionLaunchSelection"
    > & Partial<
      Pick<
        AuxiliarySessionServiceDeps,
        "runProviderRuntimeOperationExclusive" | "resolveSessionLaunchSelection"
      >
    >,
  ) {
    super({
      runProviderRuntimeOperationExclusive: async (operation) => await operation(),
      resolveSessionLaunchSelection: async () => {
        throw new Error("latest-session resolver is not configured");
      },
      listActiveCharacters: (): readonly CharacterCatalogEntry[] => [{
        id: "aux-character",
        name: "Auxiliary Character",
        description: "",
        iconFilePath: "",
        theme: { main: "#6f8cff", sub: "#6fb8c7" },
        state: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        archivedAt: null,
      }],
      createCharacterRuntimeSnapshot: (characterId): CharacterRuntimeSnapshot => ({
        characterId,
        name: "Auxiliary Character",
        description: "",
        iconFilePath: "",
        theme: { main: "#6f8cff", sub: "#6fb8c7" },
        definitionMarkdown: "# Auxiliary Character",
        definitionSha256: "test",
        definitionByteSize: 20,
        snapshotAt: "2026-01-01T00:00:00.000Z",
      }),
      ...deps,
    });
  }
}

type SqliteColumnInfoRow = {
  name: string;
};

type SqliteIndexListRow = {
  name: string;
};

function buildTestModelCatalogSnapshot(revision: number): ModelCatalogSnapshot {
  return {
    revision,
    providers: [
      {
        id: "codex",
        label: "Codex",
        defaultModelId: "gpt-5.4",
        defaultReasoningEffort: "high",
        models: [
          { id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["medium", "high"] },
          { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", reasoningEfforts: ["medium"] },
        ],
      },
      {
        id: "copilot",
        label: "Copilot",
        defaultModelId: "claude-sonnet-4.5",
        defaultReasoningEffort: "medium",
        models: [
          { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5", reasoningEfforts: ["medium"] },
        ],
      },
    ],
  };
}

function buildCompanionSession(overrides: Partial<CompanionSession> = {}): CompanionSession {
  return {
    id: "companion-session-1",
    groupId: "group-1",
    taskTitle: "companion review",
    status: "active",
    repoRoot: "C:/workspace/WithMate",
    focusPath: "",
    targetBranch: "master",
    baseSnapshotRef: "master",
    baseSnapshotCommit: "abc123",
    companionBranch: "companion/test",
    worktreePath: "C:/workspace/WithMate-companion",
    selectedPaths: [],
    changedFiles: [],
    siblingWarnings: [],
    allowedAdditionalDirectories: ["C:/review-context"],
    runState: "idle",
    threadId: "companion-thread",
    provider: "codex",
    catalogRevision: 1,
    model: "gpt-5.4",
    reasoningEffort: "high",
    customAgentName: "reviewer",
    approvalMode: "on-request",
    codexSandboxMode: "workspace-write-network",
    codexSpeed: "standard",
    codexReviewer: "user",
    characterId: "companion",
    character: "Companion",
    characterRoleMarkdown: "",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    createdAt: "2026-05-25T00:00:00.000Z",
    updatedAt: "2026-05-25T00:00:00.000Z",
    messages: [{ role: "user", text: "review this" }],
    ...overrides,
  };
}

function buildAuxiliarySession(overrides: Partial<AuxiliarySession> = {}): AuxiliarySession {
  return {
    id: "auxiliary-session-1",
    parentSessionId: "session-1",
    status: "active",
    runState: "idle",
    title: "Auxiliary",
    provider: "codex",
    catalogRevision: 1,
    model: "gpt-5.4",
    reasoningEffort: "high",
    approvalMode: DEFAULT_APPROVAL_MODE,
    codexSandboxMode: "danger-full-access",
    codexSpeed: "standard",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "",
    composerDraft: "",
    messages: [],
    displayAfterMessageIndex: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    closedAt: "",
    ...overrides,
  };
}

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

test("resolveAuxiliaryParentSession は cached summary より stored full session を優先する", async () => {
  const storedSession = {
    ...buildNewSession({
      taskTitle: "main task",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "mate",
      character: "Mate",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      characterRuntimeSnapshot: {
        characterId: "mate",
        name: "Mate",
        description: "Stored snapshot",
        iconFilePath: "",
        theme: { main: "#6f8cff", sub: "#6fb8c7" },
        definitionMarkdown: "# Character\n\nStored snapshot prompt.",
        definitionSha256: "stored-character-sha",
        definitionByteSize: 36,
        snapshotAt: "2026-07-03T00:00:00.000Z",
      },
      approvalMode: DEFAULT_APPROVAL_MODE,
    }),
    id: "session-main",
  };
  const cachedSession = {
    ...storedSession,
    characterRuntimeSnapshot: null,
    messages: [],
  };

  const resolved = await resolveAuxiliaryParentSession({
    parentSessionId: storedSession.id,
    getStoredSession: (sessionId) => sessionId === storedSession.id ? storedSession : null,
    getCachedSession: (sessionId) => sessionId === cachedSession.id ? cachedSession : null,
    getCompanionSession: () => null,
  });

  assert.equal(resolved, storedSession);
  assert.equal(resolved?.characterRuntimeSnapshot?.definitionMarkdown, "# Character\n\nStored snapshot prompt.");
});

// @test-value v2
// kind = "contract"
// claim = "旧Auxiliary schemaの初期化はcreated_at列を補完し、現行の最終使用順indexだけを保持する"
// oracle = { type = "contract", ref = "docs/design/database-schema.md:5" }
// fault = "created_atなしの既存tableを初期化できないか、旧作成順indexを残して最終使用順indexを欠落させる"
// observable = "auxiliary_sessionsのcolumnsとindex names"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-schema-upgrade"
// lifecycle = "permanent"
// @end-test-value
test("AuxiliarySessionStorage は created_at なしの旧 auxiliary_sessions を初期化できる", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-legacy-schema-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  let legacyDb: DatabaseSync | null = null;
  let auxiliaryStorage: AuxiliarySessionStorage | null = null;

  try {
    legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE auxiliary_sessions (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `);
    legacyDb.close();
    legacyDb = null;

    auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
    auxiliaryStorage.close();
    auxiliaryStorage = null;

    let db = new DatabaseSync(dbPath);
    try {
      const columns = (db.prepare("PRAGMA table_info(auxiliary_sessions)").all() as SqliteColumnInfoRow[])
        .map((column) => column.name);
      assert.equal(columns.includes("created_at"), true);

      const indexes = (db.prepare("PRAGMA index_list(auxiliary_sessions)").all() as SqliteIndexListRow[])
        .map((row) => row.name);
      assert.equal(indexes.includes("idx_auxiliary_sessions_parent_updated"), true);
      db.exec(`
        CREATE INDEX idx_auxiliary_sessions_parent_created
          ON auxiliary_sessions(parent_session_id, created_at ASC)
      `);
    } finally {
      db.close();
    }

    auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
    auxiliaryStorage.close();
    auxiliaryStorage = null;

    db = new DatabaseSync(dbPath);
    try {
      const indexes = (db.prepare("PRAGMA index_list(auxiliary_sessions)").all() as SqliteIndexListRow[])
        .map((row) => row.name);
      assert.equal(indexes.includes("idx_auxiliary_sessions_parent_updated"), true);
      assert.equal(indexes.includes("idx_auxiliary_sessions_parent_created"), false);
    } finally {
      db.close();
    }
  } finally {
    legacyDb?.close();
    auxiliaryStorage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary一覧は保存済み軽量summaryからiconとpreviewを返し、transcriptとCharacter定義を返さない"
// oracle = { type = "contract", ref = "issue-710-lightweight-auxiliary-summary" }
// fault = "一覧取得のたびにpayload_jsonを再投影し、全文やsnapshot定義をsummaryへ混ぜる"
// observable = "listAuxiliarySessionsの返却summary"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-storage-summary"
// lifecycle = "permanent"
// @end-test-value
test("AuxiliarySessionStorage は軽量summaryを保存して再読込する", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-summary-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  const storage = new AuxiliarySessionStorage(dbPath);
  try {
    storage.upsertAuxiliarySession({
      id: "aux-summary",
      parentSessionId: "parent-summary",
      status: "active",
      runState: "idle",
      title: "Auxiliary",
      provider: "codex",
      catalogRevision: 1,
      model: "gpt-5.4",
      reasoningEffort: "medium",
      approvalMode: DEFAULT_APPROVAL_MODE,
      codexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE,
      codexSpeed: "standard",
      codexReviewer: "user",
      customAgentName: "",
      allowedAdditionalDirectories: [],
      threadId: "thread-1",
      composerDraft: "draft must stay out of summary",
      messages: [{ role: "assistant", text: "transcript must stay out of summary" }],
      displayAfterMessageIndex: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      closedAt: "",
      characterId: "char-1",
      characterRuntimeSnapshot: {
        characterId: "char-1",
        name: "Character 1",
        description: "",
        iconFilePath: "characters/char-1/icon.png",
        theme: { main: "#6f8cff", sub: "#6fb8c7" },
        definitionMarkdown: "# Character 1",
        definitionSha256: "char-1-sha",
        definitionByteSize: 14,
        snapshotAt: "2026-01-01T00:00:00.000Z",
      },
      characterIconPath: "characters/char-1/icon.png",
      preview: "確定応答の冒頭",
    });

    const summary = storage.listAuxiliarySessions("parent-summary")[0];
    assert.equal(summary?.preview, "確定応答の冒頭");
    assert.equal(summary?.characterIconPath, "characters/char-1/icon.png");
    assert.equal("messages" in (summary ?? {}), false);
    assert.equal("composerDraft" in (summary ?? {}), false);
    assert.equal("characterRuntimeSnapshot" in (summary ?? {}), false);
  } finally {
    storage.close();
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary session message は payload JSON と再起動後の読込で bookmark state を保持する"
// oracle = { type = "contract", ref = "docs/features/message-bookmark-filter.md: 永続化" }
// fault = "Auxiliary本文のbookmark stateをpayloadへ保存しない、または再読込時に落とす"
// observable = "upsertAuxiliarySessionとgetAuxiliarySessionが返すmessagesのisBookmarked"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-storage-message-bookmark"
// lifecycle = "permanent"
// impact = "右Paneのbookmark filterと本文の状態が再起動後に食い違う"
// distinction = "UIの表示やtypecheckでは確認できないAuxiliary payloadの永続化を実ストレージで確認する"
// @end-test-value
test("Auxiliary message は bookmark state を再読込後も保持する", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-message-bookmark-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  let storage: AuxiliarySessionStorage | null = null;
  try {
    storage = new AuxiliarySessionStorage(dbPath);
    const session = storage.upsertAuxiliarySession(buildAuxiliarySession({
      id: "aux-message-bookmark",
      parentSessionId: "parent-message-bookmark",
      messages: [
        { role: "user", text: "bookmark me", isBookmarked: true },
        { role: "assistant", text: "ordinary message" },
      ],
    }));

    assert.equal(session.messages[0]?.isBookmarked, true);
    storage.close();
    storage = new AuxiliarySessionStorage(dbPath);
    assert.equal(storage.getAuxiliarySession(session.id)?.messages[0]?.isBookmarked, true);
    assert.equal(storage.getAuxiliarySession(session.id)?.messages[1]?.isBookmarked, undefined);
  } finally {
    storage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary summaryは既存契約どおり最終使用順を維持する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: per-session persistence and lifecycle" }
// fault = "保存時刻の比較または同時刻のID tie-breakを誤り、最終使用順の一覧を返さない"
// observable = "listAuxiliarySessionsの返却ID順"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-storage-order"
// lifecycle = "permanent"
// distinction = "bookmark state保存の変更とは別に、一覧の既存order contractを実ストレージで確認する"
// @end-test-value
test("AuxiliarySessionStorage は最終使用順で一覧を返す", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-order-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  const storage = new AuxiliarySessionStorage(dbPath);
  try {
    storage.upsertAuxiliarySession(buildAuxiliarySession({
      id: "aux-created-later",
      parentSessionId: "parent-order",
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));
    storage.upsertAuxiliarySession(buildAuxiliarySession({
      id: "aux-last-used",
      parentSessionId: "parent-order",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    }));
    storage.upsertAuxiliarySession(buildAuxiliarySession({
      id: "aux-same-time-a",
      parentSessionId: "parent-order",
      createdAt: "2026-01-04T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    }));
    storage.upsertAuxiliarySession(buildAuxiliarySession({
      id: "aux-same-time-b",
      parentSessionId: "parent-order",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    }));

    assert.deepEqual(
      storage.listAuxiliarySessions("parent-order").map((summary) => summary.id),
      ["aux-last-used", "aux-same-time-b", "aux-same-time-a", "aux-created-later"],
    );
  } finally {
    storage.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

// @test-value v2
// kind = "contract"
// claim = "旧Auxiliaryのpreview backfillは最新の有効なcompleted raw itemから最終assistant blockだけを採用する"
// oracle = { type = "contract", ref = "issue-710-preview-legacy-audit-backfill" }
// fault = "中間assistant結合値、失敗turn、空または切り詰め済みの最新completed raw itemを最終応答として保存する"
// observable = "resolveLegacyAuxiliaryPreviewFromAuditEntriesの返却値"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-storage"
// lifecycle = "permanent"
// @end-test-value
test("legacy preview backfillはcompleted raw itemの最終blockだけを復元する", () => {
  assert.equal(
    resolveLegacyAuxiliaryPreviewFromAuditEntries([
      {
        phase: "completed",
        rawItemsJson: JSON.stringify([{ type: "agent_message", data: { text: "新しい確定" } }]),
      },
      {
        phase: "completed",
        rawItemsJson: JSON.stringify([{ type: "agent_message", data: { text: "古い確定" } }]),
      },
    ]),
    "新しい確定",
  );
  assert.equal(
    resolveLegacyAuxiliaryPreviewFromAuditEntries([
      {
        phase: "completed",
        rawItemsJson: JSON.stringify([{ type: "withmate.raw_items_truncated", truncated: true }]),
      },
      {
        phase: "completed",
        rawItemsJson: JSON.stringify([{ type: "agent_message", data: { text: "以前の確定" } }]),
      },
    ]),
    "以前の確定",
  );
  assert.equal(
    resolveLegacyAuxiliaryPreviewFromAuditEntries([
      {
        phase: "background-completed",
        rawItemsJson: JSON.stringify([{ type: "agent_message", data: { text: "background確定" } }]),
      },
    ]),
    "background確定",
  );
  assert.equal(
    resolveLegacyAuxiliaryPreviewFromAuditEntries([
      { phase: "failed", rawItemsJson: JSON.stringify([{ type: "agent_message", data: { text: "失敗" } }]) },
      {
        phase: "completed",
        rawItemsJson: JSON.stringify([
          { type: "agent_message", data: { text: "中間" } },
          { type: "agent_message", data: { text: "確定" } },
        ]),
      },
    ]),
    "確定",
  );
  assert.equal(
    resolveLegacyAuxiliaryPreviewFromAuditEntries([
      {
        phase: "completed",
        rawItemsJson: JSON.stringify([
          { type: "agent_message", data: { text: "確定" } },
          { type: "withmate.value_truncated", truncated: true },
        ]),
      },
    ]),
    null,
  );
  assert.equal(
    resolveLegacyAuxiliaryPreviewFromAuditEntries([
      { phase: "failed", rawItemsJson: JSON.stringify([{ type: "agent_message", data: { text: "本文" } }]) },
    ]),
    null,
  );
  assert.equal(
    resolveLegacyAuxiliaryPreviewFromAuditEntries([
      {
        phase: "completed",
        rawItemsJson: JSON.stringify([
          { type: "assistant.message", data: { content: "subagent", parentToolCallId: "tool-1" } },
          { type: "assistant.message", data: { content: "確定" , parentToolCallId: null } },
        ]),
      },
    ]),
    "確定",
  );
  assert.equal(
    resolveLegacyAuxiliaryPreviewFromAuditEntries([
      {
        phase: "completed",
        rawItemsJson: JSON.stringify([
          { type: "assistant.message", data: { content: "subagent", agentId: "agent-1", parentToolCallId: null } },
        ]),
      },
    ]),
    null,
  );
});

// @test-value v2
// kind = "contract"
// claim = "既存summary未生成行はread時に副作用を起こさず、明示maintenanceで監査由来previewを補完できる"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#preview-contract; docs/design/auxiliary-session.md#persistence" }
// fault = "通常の一覧取得でpayloadを再投影するか、明示maintenance成功後も監査由来previewを返せない"
// observable = "read後のresolver未呼出し、maintenance後のpreviewとresolver呼出回数"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-storage-migration"
// lifecycle = "permanent"
// @end-test-value
test("旧summary未生成行はreadを汚さず明示maintenanceで監査由来previewを補完する", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-preview-migration-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  let storage: AuxiliarySessionStorage | null = null;
  try {
    storage = new AuxiliarySessionStorage(dbPath);
    storage.upsertAuxiliarySession(buildAuxiliarySession({
      id: "aux-legacy-preview",
      parentSessionId: "parent-legacy-preview",
      messages: [
        { role: "user", text: "ユーザーの依頼" },
        { role: "assistant", text: "中間A" },
        { role: "assistant", text: "中間B" },
      ],
    }));
    storage.close();
    storage = null;

    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("UPDATE auxiliary_sessions SET summary_json = '' WHERE id = ?").run("aux-legacy-preview");
    } finally {
      db.close();
    }

    let resolverCalls = 0;
    storage = new AuxiliarySessionStorage(dbPath, (id) => {
      resolverCalls += 1;
      return id === "aux-legacy-preview" ? "監査で確定した最終block" : null;
    });
    const beforeReadDb = new DatabaseSync(dbPath);
    const summaryBeforeRead = (beforeReadDb.prepare("SELECT summary_json FROM auxiliary_sessions WHERE id = ?")
      .get("aux-legacy-preview") as { summary_json: string }).summary_json;
    beforeReadDb.close();
    assert.equal(storage.listAuxiliarySessions("parent-legacy-preview")[0]?.preview, "ユーザーの依頼");
    assert.equal(resolverCalls, 0);
    const afterReadDb = new DatabaseSync(dbPath);
    const summaryAfterRead = (afterReadDb.prepare("SELECT summary_json FROM auxiliary_sessions WHERE id = ?")
      .get("aux-legacy-preview") as { summary_json: string }).summary_json;
    afterReadDb.close();
    assert.equal(summaryBeforeRead, "");
    assert.equal(summaryAfterRead, summaryBeforeRead);
    assert.deepEqual(storage.backfillAuxiliarySessionSummaries({ batchSize: 1 }), {
      processed: 1,
      updated: 1,
      remaining: 0,
    });
    const migrated = storage.getAuxiliarySession("aux-legacy-preview");
    assert.equal(migrated?.preview, "監査で確定した最終block");
    assert.ok(migrated);
    storage.upsertAuxiliarySession({ ...migrated, title: "更新後" });
    assert.equal(storage.getAuxiliarySession("aux-legacy-preview")?.preview, "監査で確定した最終block");
    assert.equal(storage.listAuxiliarySessions("parent-legacy-preview")[0]?.preview, "監査で確定した最終block");
    assert.equal(resolverCalls, 1);
  } finally {
    storage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliaryの新規作成はtitleとpreviewを空にし、不正optionの再送を拒否する。作成・更新・再読込・終了は各会話のruntime option、draft、thread、preview、親境界を保つ"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#persistence" }
// fault = "既存clientRequestIdの再送で入力検証を迂回する、複数Auxiliaryやstale保存で別会話の状態を上書きする、初期titleやpreviewを誤表示する、または親境界を越えて残す"
// observable = "既存clientRequestId付き不正optionのreject、作成時のtitleとpreview、再読込・runtime upsert・stale update・close・parent filteringの公開結果"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-service"
// lifecycle = "permanent"
// @end-test-value
test("AuxiliarySessionService は親の作業 context と未指定 runtime option の既定値で active session を復元する", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-session-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  let sessionStorage: SessionStorage | null = null;
  let auxiliaryStorage: AuxiliarySessionStorage | null = null;
  let companionStorage: CompanionStorage | null = null;

  try {
    sessionStorage = new SessionStorage(dbPath);
    auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
    companionStorage = new CompanionStorage(dbPath);
    const parent = {
      ...buildNewSession({
        taskTitle: "main task",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "mate",
        character: "Mate",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
        allowedAdditionalDirectories: ["C:/shared"],
      }),
      id: "session-main",
      provider: "codex",
      model: "gpt-5.4",
      reasoningEffort: "high" as const,
      codexSandboxMode: "workspace-write-network" as const,
    };
    sessionStorage.upsertSession(parent);
    let activeModelCatalog = buildTestModelCatalogSnapshot(parent.catalogRevision);

    const service = new AuxiliarySessionService({
      getParentSession: (parentSessionId) => sessionStorage?.getSession(parentSessionId) ?? null,
      getStorage: () => auxiliaryStorage!,
      getModelCatalogSnapshot: () => activeModelCatalog,
    });

    const auxiliary = await service.createAuxiliarySession({
      parentSessionId: parent.id,
      provider: parent.provider,
      clientRequestId: "create-1",
    });
    await assert.rejects(
      service.createAuxiliarySession({
        parentSessionId: parent.id,
        provider: "copilot",
        approvalMode: "invalid" as never,
        clientRequestId: "create-1",
      }),
      /approvalMode/,
    );
    assert.equal(auxiliary.parentSessionId, parent.id);
    assert.equal(auxiliary.status, "active");
    assert.equal(auxiliary.runState, "idle");
    assert.equal(auxiliary.title, "");
    assert.equal(auxiliary.preview, "");
    assert.equal(auxiliary.provider, parent.provider);
    assert.equal(auxiliary.model, parent.model);
    assert.equal(auxiliary.reasoningEffort, parent.reasoningEffort);
    assert.equal(auxiliary.approvalMode, DEFAULT_APPROVAL_MODE);
    assert.equal(auxiliary.codexSandboxMode, DEFAULT_CODEX_SANDBOX_MODE);
    assert.equal(auxiliary.codexSpeed, "standard");
    assert.deepEqual(auxiliary.allowedAdditionalDirectories, ["C:/shared"]);
    assert.equal(auxiliary.displayAfterMessageIndex, parent.messages.length - 1);

    const sameActive = await service.createAuxiliarySession({
      parentSessionId: parent.id,
      provider: "copilot",
      clientRequestId: "create-2",
    });
    assert.notEqual(sameActive.id, auxiliary.id);
    assert.equal((await service.listAuxiliarySessions(parent.id)).length, 2);
    const untouchedSibling = await service.getAuxiliarySession(sameActive.id);
    assert.ok(untouchedSibling);

    const updated = await service.updateAuxiliarySession({
      ...auxiliary,
      composerDraft: "review this diff",
      messages: [{ role: "assistant", text: "finding" }],
    });
    assert.equal((await service.getAuxiliarySession(auxiliary.id))?.composerDraft, "review this diff");
    assert.equal((await service.listAuxiliarySessions(parent.id)).some((entry) => entry.id === updated.id), true);
    const siblingAfterUpdate = await service.getAuxiliarySession(sameActive.id);
    assert.equal(siblingAfterUpdate?.provider, untouchedSibling.provider);
    assert.equal(siblingAfterUpdate?.threadId, untouchedSibling.threadId);
    assert.equal(siblingAfterUpdate?.composerDraft, untouchedSibling.composerDraft);
    assert.deepEqual(siblingAfterUpdate?.messages, untouchedSibling.messages);

    const movedDisplayAnchor = await service.updateAuxiliarySession({
      ...updated,
      displayAfterMessageIndex: 3,
    });
    assert.equal(movedDisplayAnchor.displayAfterMessageIndex, 3);
    const staleDraftWithOldDisplayAnchor = await service.updateAuxiliarySession({
      ...updated,
      composerDraft: "stale draft with old anchor",
    });
    assert.equal(staleDraftWithOldDisplayAnchor.displayAfterMessageIndex, 3);

    const runtimeSession = await service.getAuxiliaryRuntimeSession(movedDisplayAnchor.id);
    assert.ok(runtimeSession);
    const persistedRuntime = await service.upsertAuxiliaryRuntimeSession({
      ...runtimeSession,
      messages: [...runtimeSession.messages, { role: "assistant", text: "done" }],
      updatedAt: "2026-05-24T00:00:00.000Z",
    }, { confirmedFinalAssistantText: "done" });
    assert.equal(persistedRuntime.composerDraft, "");
    assert.equal(persistedRuntime.codexSandboxMode, DEFAULT_CODEX_SANDBOX_MODE);
    assert.equal(persistedRuntime.preview, "done");
    for (const runState of ["running", "error", "idle"] as const) {
      const preserved = await service.upsertAuxiliaryRuntimeSession({
        ...runtimeSession,
        runState,
        preview: "途中で上書きしない",
        messages: [...persistedRuntime.messages, { role: "assistant", text: "中間通知" }],
        updatedAt: `2026-05-24T00:00:0${runState === "running" ? "1" : runState === "error" ? "2" : "3"}.000Z`,
      });
      assert.equal(preserved.preview, "done");
    }
    const staleDraftUpdate = await service.updateAuxiliarySession({
      ...updated,
      composerDraft: "review this diff",
    });
    assert.equal(staleDraftUpdate.composerDraft, "");
    assert.equal(staleDraftUpdate.messages.length, (await service.getAuxiliarySession(movedDisplayAnchor.id))?.messages.length);

    const migratedAuxiliary = auxiliaryStorage.upsertAuxiliarySession({
      ...staleDraftUpdate,
      catalogRevision: staleDraftUpdate.catalogRevision + 1,
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      threadId: "",
    });
    activeModelCatalog = buildTestModelCatalogSnapshot(migratedAuxiliary.catalogRevision);
    const staleRendererSave = await service.updateAuxiliarySession({
      ...staleDraftUpdate,
      catalogRevision: auxiliary.catalogRevision,
      model: auxiliary.model,
      reasoningEffort: auxiliary.reasoningEffort,
      threadId: "",
      composerDraft: "draft after catalog reset",
    });
    assert.equal(staleRendererSave.catalogRevision, migratedAuxiliary.catalogRevision);
    assert.equal(staleRendererSave.model, "gpt-5.4-mini");
    assert.equal(staleRendererSave.reasoningEffort, "medium");
    assert.equal(staleRendererSave.threadId, "");
    assert.equal(staleRendererSave.composerDraft, "draft after catalog reset");

    const sessionBeforeCredentialReset = auxiliaryStorage.upsertAuxiliarySession({
      ...staleRendererSave,
      threadId: "aux-thread-before-reset",
    });
    const sessionAfterCredentialReset = auxiliaryStorage.upsertAuxiliarySession({
      ...sessionBeforeCredentialReset,
      threadId: "",
    });
    const staleThreadRendererSave = await service.updateAuxiliarySession({
      ...sessionBeforeCredentialReset,
      composerDraft: "draft after credential reset",
    });
    assert.equal(staleThreadRendererSave.catalogRevision, sessionAfterCredentialReset.catalogRevision);
    assert.equal(staleThreadRendererSave.model, sessionAfterCredentialReset.model);
    assert.equal(staleThreadRendererSave.threadId, "");
    assert.equal(staleThreadRendererSave.composerDraft, "draft after credential reset");

    const olderCatalogAuxiliary = auxiliaryStorage.upsertAuxiliarySession({
      ...staleThreadRendererSave,
      catalogRevision: 1,
      model: "gpt-5.4",
      reasoningEffort: "high",
      threadId: "thread-before-model-change",
    });
    activeModelCatalog = buildTestModelCatalogSnapshot(3);
    const draftBeforeModelChange = await service.updateAuxiliarySession({
      ...olderCatalogAuxiliary,
      composerDraft: "draft saved before model change",
    });
    const explicitModelChange = await service.updateAuxiliarySession({
      ...draftBeforeModelChange,
      catalogRevision: 3,
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
    });
    assert.equal(explicitModelChange.catalogRevision, 3);
    assert.equal(explicitModelChange.model, "gpt-5.4-mini");
    assert.equal(explicitModelChange.reasoningEffort, "medium");
    assert.equal(explicitModelChange.threadId, "");
    assert.equal(explicitModelChange.composerDraft, "draft saved before model change");

    const userChangedModelWithDraft = auxiliaryStorage.upsertAuxiliarySession({
      ...explicitModelChange,
      composerDraft: "current draft with skill snippet",
    });
    const staleDraftAfterModelChange = await service.updateAuxiliarySession({
      ...draftBeforeModelChange,
      catalogRevision: userChangedModelWithDraft.catalogRevision,
      composerDraft: "stale draft before model change",
    });
    assert.equal(staleDraftAfterModelChange.catalogRevision, userChangedModelWithDraft.catalogRevision);
    assert.equal(staleDraftAfterModelChange.model, userChangedModelWithDraft.model);
    assert.equal(staleDraftAfterModelChange.reasoningEffort, userChangedModelWithDraft.reasoningEffort);
    assert.equal(staleDraftAfterModelChange.composerDraft, userChangedModelWithDraft.composerDraft);

    const resetMigratedAuxiliary = auxiliaryStorage.upsertAuxiliarySession({
      ...staleDraftAfterModelChange,
      catalogRevision: 2,
      model: "gpt-5.4",
      reasoningEffort: "high",
      threadId: "",
    });
    activeModelCatalog = buildTestModelCatalogSnapshot(resetMigratedAuxiliary.catalogRevision);
    const staleSaveAfterCatalogReset = await service.updateAuxiliarySession({
      ...explicitModelChange,
      catalogRevision: 5,
      model: "removed-model",
      reasoningEffort: "xhigh",
      composerDraft: "draft after catalog reset to lower revision",
    });
    assert.equal(staleSaveAfterCatalogReset.catalogRevision, resetMigratedAuxiliary.catalogRevision);
    assert.equal(staleSaveAfterCatalogReset.model, resetMigratedAuxiliary.model);
    assert.equal(staleSaveAfterCatalogReset.reasoningEffort, resetMigratedAuxiliary.reasoningEffort);
    assert.equal(staleSaveAfterCatalogReset.threadId, "");
    assert.equal(staleSaveAfterCatalogReset.composerDraft, "draft after catalog reset to lower revision");

    const userConfiguredAuxiliary = auxiliaryStorage.upsertAuxiliarySession({
      ...staleSaveAfterCatalogReset,
      approvalMode: "on-request",
      codexSandboxMode: "workspace-write-network",
      customAgentName: "reviewer",
      allowedAdditionalDirectories: ["C:/shared", "C:/review-context"],
      composerDraft: "current visible draft",
    });
    const staleDraftAfterSettingsChange = await service.updateAuxiliarySession({
      ...staleSaveAfterCatalogReset,
      composerDraft: "draft saved after settings change",
    });
    assert.equal(staleDraftAfterSettingsChange.approvalMode, userConfiguredAuxiliary.approvalMode);
    assert.equal(staleDraftAfterSettingsChange.codexSandboxMode, userConfiguredAuxiliary.codexSandboxMode);
    assert.equal(staleDraftAfterSettingsChange.customAgentName, userConfiguredAuxiliary.customAgentName);
    assert.deepEqual(staleDraftAfterSettingsChange.allowedAdditionalDirectories, userConfiguredAuxiliary.allowedAdditionalDirectories);
    assert.equal(staleDraftAfterSettingsChange.composerDraft, userConfiguredAuxiliary.composerDraft);

    auxiliaryStorage.upsertAuxiliarySession({ ...staleDraftAfterSettingsChange, runState: "running" });
    await assert.rejects(
      service.closeAuxiliarySession(auxiliary.id),
      /実行中の Auxiliary Session は終了できない/,
    );
    auxiliaryStorage.upsertAuxiliarySession(staleDraftAfterSettingsChange);

    const closed = await service.closeAuxiliarySession(auxiliary.id);
    assert.equal(closed.status, "closed");
    assert.equal(closed.composerDraft, "");
    const closedSecond = await service.closeAuxiliarySession(sameActive.id);
    assert.equal(closedSecond.status, "closed");
    assert.equal(await service.getActiveAuxiliarySession(parent.id), null);
    assert.equal((await service.listAuxiliarySessions(parent.id)).length, 2);

    sessionStorage.replaceSessions([{ ...parent, taskTitle: "renamed main task" }]);
    assert.equal((await service.listAuxiliarySessions(parent.id)).length, 2);

    const orphanedParent = { ...parent, id: "session-orphaned", taskTitle: "orphaned main task" };
    sessionStorage.upsertSession(orphanedParent);
    const orphanedAuxiliary = await service.createAuxiliarySession({
      parentSessionId: orphanedParent.id,
      provider: orphanedParent.provider,
    });
    assert.equal((await service.listAuxiliarySessions(orphanedParent.id))[0]?.id, orphanedAuxiliary.id);
    const activeCompanion = buildCompanionSession({
      id: "companion-active-parent",
      groupId: "companion-group",
    });
    const mergedCompanion = buildCompanionSession({
      id: "companion-merged-parent",
      groupId: activeCompanion.groupId,
      status: "merged",
    });
    const discardedCompanion = buildCompanionSession({
      id: "companion-discarded-parent",
      groupId: activeCompanion.groupId,
      status: "discarded",
    });
    const recoveryRequiredCompanion = buildCompanionSession({
      id: "companion-recovery-parent",
      groupId: activeCompanion.groupId,
      status: "recovery-required",
    });
    const unknownStatusCompanion = buildCompanionSession({
      id: "companion-unknown-parent",
      groupId: activeCompanion.groupId,
      status: "unknown-status" as CompanionSession["status"],
    });
    companionStorage.ensureGroup({
      id: activeCompanion.groupId,
      repoRoot: activeCompanion.repoRoot,
      displayName: "Companion Group",
      createdAt: activeCompanion.createdAt,
      updatedAt: activeCompanion.updatedAt,
    });
    companionStorage.createSession(activeCompanion);
    companionStorage.createSession(recoveryRequiredCompanion);
    companionStorage.createSession(mergedCompanion);
    companionStorage.createSession(discardedCompanion);
    companionStorage.createSession(unknownStatusCompanion);
    auxiliaryStorage.upsertAuxiliarySession({
      ...orphanedAuxiliary,
      id: "aux-companion-parent",
      parentSessionId: activeCompanion.id,
      createdAt: "2026-05-25T00:00:00.000Z",
      updatedAt: "2026-05-25T00:00:00.000Z",
    });
    auxiliaryStorage.upsertAuxiliarySession({
      ...orphanedAuxiliary,
      id: "aux-recovery-companion-parent",
      parentSessionId: recoveryRequiredCompanion.id,
      createdAt: "2026-05-25T00:00:00.000Z",
      updatedAt: "2026-05-25T00:00:00.000Z",
    });
    auxiliaryStorage.upsertAuxiliarySession({
      ...orphanedAuxiliary,
      id: "aux-merged-companion-parent",
      parentSessionId: mergedCompanion.id,
      createdAt: "2026-05-25T00:00:00.000Z",
      updatedAt: "2026-05-25T00:00:00.000Z",
    });
    auxiliaryStorage.upsertAuxiliarySession({
      ...orphanedAuxiliary,
      id: "aux-discarded-companion-parent",
      parentSessionId: discardedCompanion.id,
      createdAt: "2026-05-25T00:00:00.000Z",
      updatedAt: "2026-05-25T00:00:00.000Z",
    });
    auxiliaryStorage.upsertAuxiliarySession({
      ...orphanedAuxiliary,
      id: "aux-unknown-status-companion-parent",
      parentSessionId: unknownStatusCompanion.id,
      createdAt: "2026-05-25T00:00:00.000Z",
      updatedAt: "2026-05-25T00:00:00.000Z",
    });

    sessionStorage.replaceSessions([{ ...parent, taskTitle: "retained main task" }]);
    assert.equal((await service.listAuxiliarySessions(parent.id)).length, 2);
    assert.deepEqual(await service.listAuxiliarySessions(orphanedParent.id), []);
    assert.equal((await service.listAuxiliarySessions(activeCompanion.id))[0]?.id, "aux-companion-parent");
    assert.equal((await service.listAuxiliarySessions(recoveryRequiredCompanion.id))[0]?.id, "aux-recovery-companion-parent");
    assert.deepEqual(await service.listAuxiliarySessions(mergedCompanion.id), []);
    assert.deepEqual(await service.listAuxiliarySessions(discardedCompanion.id), []);
    assert.equal((await service.listAuxiliarySessions(unknownStatusCompanion.id))[0]?.id, "aux-unknown-status-companion-parent");

    sessionStorage.deleteSession(parent.id);
    assert.deepEqual(await service.listAuxiliarySessions(parent.id), []);
  } finally {
    companionStorage?.close();
    auxiliaryStorage?.close();
    sessionStorage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary Character選択はMainを除外し、snapshot生成失敗時に既存draft/threadを壊さない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#character-identity" }
// fault = "Main Characterを再利用する、または新規作成失敗で既存Auxiliaryの会話状態を失う"
// observable = "作成結果のcharacterIdと既存Auxiliaryのdraft/thread/messages"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-service"
// lifecycle = "permanent"
// @end-test-value
test("AuxiliarySessionService はMain除外とsnapshot失敗時の既存状態保持を保証する", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-character-selection-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  const sessionStorage = new SessionStorage(dbPath);
  const auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
  try {
    const parent = {
      ...buildNewSession({
        taskTitle: "character selection",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "main-character",
        character: "Main",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      }),
      id: "session-character-selection",
      provider: "codex",
    };
    sessionStorage.upsertSession(parent);
    let failSnapshot = false;
    const service = new AuxiliarySessionService({
      getParentSession: (id) => id === parent.id ? parent : null,
      getStorage: () => auxiliaryStorage,
      getModelCatalogSnapshot: () => buildTestModelCatalogSnapshot(parent.catalogRevision),
      listActiveCharacters: () => [
        { id: "main-character", name: "Main", description: "", iconFilePath: "", theme: { main: "#6f8cff", sub: "#6fb8c7" }, state: "active", createdAt: "", updatedAt: "", archivedAt: null },
        { id: "aux-a", name: "Aux A", description: "", iconFilePath: "", theme: { main: "#6f8cff", sub: "#6fb8c7" }, state: "active", createdAt: "", updatedAt: "", archivedAt: null },
        { id: "aux-b", name: "Aux B", description: "", iconFilePath: "", theme: { main: "#6f8cff", sub: "#6fb8c7" }, state: "active", createdAt: "", updatedAt: "", archivedAt: null },
      ],
      createCharacterRuntimeSnapshot: (characterId) => failSnapshot ? null : {
        characterId,
        name: characterId === "aux-a" ? "Aux A" : "Aux B",
        description: "",
        iconFilePath: "",
        theme: { main: "#6f8cff", sub: "#6fb8c7" },
        definitionMarkdown: "# Auxiliary",
        definitionSha256: "test",
        definitionByteSize: 11,
        snapshotAt: "2026-01-01T00:00:00.000Z",
      },
      randomCharacter: () => 0,
    });
    const first = await service.createAuxiliarySession({ parentSessionId: parent.id, provider: parent.provider, clientRequestId: "selection-1" });
    assert.notEqual(first.characterId, parent.characterId);
    const preserved = auxiliaryStorage.upsertAuxiliarySession({
      ...first,
      composerDraft: "keep me",
      threadId: "thread-existing",
      messages: [{ role: "assistant", text: "keep messages" }],
    });
    failSnapshot = true;
    await assert.rejects(
      service.createAuxiliarySession({ parentSessionId: parent.id, provider: parent.provider, clientRequestId: "selection-2" }),
      /Character snapshot を作成できない/,
    );
    const afterFailure = await service.getAuxiliarySession(preserved.id);
    assert.equal(afterFailure?.composerDraft, "keep me");
    assert.equal(afterFailure?.threadId, "thread-existing");
    assert.deepEqual(
      afterFailure?.messages.map(({ role, text }) => ({ role, text })),
      [{ role: "assistant", text: "keep messages" }],
    );
  } finally {
    auxiliaryStorage.close();
    sessionStorage.close();
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary準備待ち中も親削除は進み、commit時の親再検証でorphan作成を拒否する"
// oracle = { type = "adr", ref = "docs/adr/007-provider-runtime-selection-inheritance.md" }
// fault = "準備待ちが親削除を止める、または削除済み親のAuxiliaryを保存する"
// observable = "selection解放前の親削除完了、parent別Auxiliary一覧とcreateのreject"
// observation_boundary = "public-boundary"
// scope = "auxiliary-parent-lifecycle"
// lifecycle = "permanent"
// @end-test-value
test("Auxiliary作成と親削除は同じcoordinatorでorphanを作らない", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-parent-race-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  const sessionStorage = new SessionStorage(dbPath);
  const auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
  try {
    const parent = {
      ...buildNewSession({
        taskTitle: "race",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "main-character",
        character: "Main",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      }),
      id: "session-race",
      provider: "codex",
    };
    sessionStorage.upsertSession(parent);
    const coordinator = new (await import("../../src-electron/character-affect-turn-ownership-coordinator.js")).CharacterAffectTurnOwnershipCoordinator();
    let releaseSelection!: () => void;
    const selectionReady = new Promise<void>((resolve) => { releaseSelection = resolve; });
    let selectionEntered!: () => void;
    const selectionStarted = new Promise<void>((resolve) => { selectionEntered = resolve; });
    let resolveSelectionCalls = 0;
    const service = new AuxiliarySessionService({
      getParentSession: (id) => sessionStorage.getSession(id),
      getStorage: () => auxiliaryStorage,
      getModelCatalogSnapshot: () => buildTestModelCatalogSnapshot(parent.catalogRevision),
      resolveSessionLaunchSelection: async () => {
        resolveSelectionCalls += 1;
        selectionEntered();
        await selectionReady;
        return {
          provider: "codex",
          catalogRevision: parent.catalogRevision,
          model: "gpt-5.4",
          reasoningEffort: "high",
          approvalMode: DEFAULT_APPROVAL_MODE,
          codexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE,
          codexSpeed: "standard",
          codexReviewer: "user",
          customAgentName: "",
        };
      },
      runCharacterAffectTurnOwnershipExclusive: (operation) => coordinator.runExclusive(operation),
    });
    const create = service.createAuxiliarySession({
      parentSessionId: parent.id,
      provider: parent.provider,
      runtimeSelection: "latest-session",
      clientRequestId: "race-create",
    });
    await selectionStarted;
    const deleteParent = coordinator.runExclusive(async () => {
      sessionStorage.deleteSession(parent.id);
      auxiliaryStorage.deleteAuxiliarySessionsForParent(parent.id);
    });
    await deleteParent;
    assert.equal(resolveSelectionCalls, 1);
    releaseSelection();
    await assert.rejects(create, /親セッションが見つからない|親セッションが作成中に置き換わった/);
    assert.deepEqual(auxiliaryStorage.listAuxiliarySessions(parent.id), []);

    const reverseParent = { ...parent, id: "session-race-reverse" };
    sessionStorage.upsertSession(reverseParent);
    await coordinator.runExclusive(async () => {
      sessionStorage.deleteSession(reverseParent.id);
      auxiliaryStorage.deleteAuxiliarySessionsForParent(reverseParent.id);
    });
    await assert.rejects(
      service.createAuxiliarySession({
        parentSessionId: reverseParent.id,
        provider: reverseParent.provider,
        runtimeSelection: "latest-session",
        clientRequestId: "race-reverse",
      }),
      /親セッションが見つからない/,
    );
    assert.deepEqual(auxiliaryStorage.listAuxiliarySessions(reverseParent.id), []);
  } finally {
    auxiliaryStorage.close();
    sessionStorage.close();
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary Sessionは作成時に親のReviewerを引き継ぎ、その後の変更を自身だけへ永続化する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#context-boundary" }
// fault = "Auxiliaryが親のAuto-reviewを継承しない、再読込で消える、またはAuxiliary変更が親へ漏れる"
// observable = "作成直後と再読込後のReviewer、Auxiliary更新後も変化しない親Reviewer"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-service-storage"
// lifecycle = "permanent"
// @end-test-value
test("Auxiliary Reviewerは親から継承した後に独立して保存する", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-speed-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  let auxiliaryStorage: AuxiliarySessionStorage | null = null;
  let sessionStorage: SessionStorageV6 | null = null;

  try {
    auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
    const parent = {
      ...buildNewSession({
        id: "speed-parent",
        taskTitle: "Speed parent",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "mate",
        character: "Mate",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        codexSpeed: "fast",
        codexReviewer: "auto-review",
      }),
      provider: "codex",
    };
    sessionStorage = new SessionStorageV6(dbPath);
    sessionStorage.upsertSession(parent);
    const service = new AuxiliarySessionService({
      getParentSession: (parentSessionId) => parentSessionId === parent.id ? parent : null,
      getStorage: () => auxiliaryStorage!,
      getModelCatalogSnapshot: () => buildTestModelCatalogSnapshot(parent.catalogRevision),
    });

    const auxiliary = await service.createAuxiliarySession({
      parentSessionId: parent.id,
      provider: parent.provider,
      codexSpeed: parent.codexSpeed,
    });
    assert.equal(auxiliary.codexSpeed, "fast");
    assert.equal(auxiliary.codexReviewer, "auto-review");

    const updated = await service.updateAuxiliarySession({
      ...auxiliary,
      codexSpeed: "standard",
      codexReviewer: "user",
    });
    assert.equal(updated.codexSpeed, "standard");
    assert.equal((await service.getAuxiliarySession(auxiliary.id))?.codexSpeed, "standard");
    assert.equal(parent.codexSpeed, "fast");
    assert.equal(updated.codexReviewer, "user");
    assert.equal((await service.getAuxiliarySession(auxiliary.id))?.codexReviewer, "user");
    assert.equal(parent.codexReviewer, "auto-review");
    assert.equal(sessionStorage.getSession(parent.id)?.codexReviewer, "auto-review");
    assert.equal(sessionStorage.getSession(parent.id)?.codexSpeed, "fast");
  } finally {
    auxiliaryStorage?.close();
    sessionStorage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary Session更新は保存済みApprovalがneverの間、他項目を更新しても現在のReviewerを保持する"
// oracle = { type = "contract", ref = "docs/manual-test-checklist.md:90" }
// fault = "直接IPCまたはstale payloadがnever中のAuxiliary Reviewerを変更し、後のinteractive復帰で意図しない値が有効になる"
// observable = "never設定で他項目を更新した後のAuxiliaryと親のReviewer"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-service"
// lifecycle = "permanent"
// @end-test-value
test("Auxiliary更新は保存済みApprovalがneverの間Reviewerを保持する", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-reviewer-never-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  let auxiliaryStorage: AuxiliarySessionStorage | null = null;
  let sessionStorage: SessionStorageV6 | null = null;

  try {
    auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
    const parent = {
      ...buildNewSession({
        id: "reviewer-never-parent",
        taskTitle: "Reviewer never parent",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "mate",
        character: "Mate",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: "never",
        codexReviewer: "auto-review",
      }),
      provider: "codex",
    };
    sessionStorage = new SessionStorageV6(dbPath);
    sessionStorage.upsertSession(parent);
    const service = new AuxiliarySessionService({
      getParentSession: (parentSessionId) => parentSessionId === parent.id ? parent : null,
      getStorage: () => auxiliaryStorage!,
      getModelCatalogSnapshot: () => buildTestModelCatalogSnapshot(parent.catalogRevision),
    });
    const auxiliary = await service.createAuxiliarySession({
      parentSessionId: parent.id,
      provider: parent.provider,
      approvalMode: "never",
    });

    const updated = await service.updateAuxiliarySession({
      ...auxiliary,
      title: "Renamed Auxiliary",
      codexReviewer: "user",
    });

    assert.equal(updated.title, "Renamed Auxiliary");
    assert.equal(updated.codexReviewer, "auto-review");
    assert.equal((await service.getAuxiliarySession(auxiliary.id))?.codexReviewer, "auto-review");
    assert.equal(sessionStorage.getSession(parent.id)?.codexReviewer, "auto-review");
    assert.equal(sessionStorage.getSession(parent.id)?.approvalMode, "never");
  } finally {
    auxiliaryStorage?.close();
    sessionStorage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

// @test-value v2
// kind = "contract"
// claim = "指定parent集合のAuxiliary一覧は全statusを軽量summary列から返し、payload transcriptを再parseしない"
// oracle = { type = "contract", ref = "issue-710-lightweight-summary-read-path" }
// fault = "closedを除外する、summaryへmessagesを混ぜる、または一覧取得のたびにpayload_jsonを読み直してtranscriptを投影する"
// observable = "listAuxiliarySessionSummariesとlistActiveAuxiliarySessionSummariesの返却順・status・JSON.parse入力"
// observation_boundary = "implementation"
// scope = "auxiliary-session-storage-summary"
// lifecycle = "permanent"
// @end-test-value
test("AuxiliarySessionStorage は指定parent集合の全status summaryを返す", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-active-auxiliary-summary-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  let auxiliaryStorage: AuxiliarySessionStorage | null = null;

  try {
    auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
    auxiliaryStorage.upsertAuxiliarySession(buildAuxiliarySession({
      id: "aux-active-session-1",
      parentSessionId: "session-1",
      createdAt: "2026-07-30T00:00:00.000Z",
      messages: [{ role: "assistant", text: "full payload" }],
    }));
    auxiliaryStorage.upsertAuxiliarySession(buildAuxiliarySession({
      id: "aux-closed-session-1",
      parentSessionId: "session-1",
      status: "closed",
      createdAt: "2026-07-30T00:01:00.000Z",
      messages: [{ role: "assistant", text: "closed-payload-sentinel" }],
      closedAt: "2026-07-30T00:10:00.000Z",
    }));
    auxiliaryStorage.upsertAuxiliarySession(buildAuxiliarySession({
      id: "aux-active-session-2",
      parentSessionId: "session-2",
      createdAt: "2026-07-30T00:00:00.000Z",
    }));

    const parsedPayloads: string[] = [];
    const originalJsonParse = JSON.parse;
    JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
      parsedPayloads.push(text);
      return originalJsonParse(text, reviver);
    }) as typeof JSON.parse;
    let summaries: AuxiliarySessionSummary[];
    let allSummaries: AuxiliarySessionSummary[];
    try {
      summaries = auxiliaryStorage.listActiveAuxiliarySessionSummaries([
        "session-1",
        "session-1",
        " ",
        "unknown-session",
      ]);
      allSummaries = auxiliaryStorage.listAuxiliarySessionSummaries([
        "session-2",
        "session-1",
        "session-1",
        " ",
        "unknown-session",
      ]);
    } finally {
      JSON.parse = originalJsonParse;
    }

    assert.deepEqual(summaries.map((session) => session.id), ["aux-active-session-1"]);
    assert.equal("messages" in summaries[0]!, false);
    assert.equal("composerDraft" in summaries[0]!, false);
    assert.equal(parsedPayloads.some((payload) => payload.includes("full payload")), false);
    assert.equal(parsedPayloads.some((payload) => payload.includes("closed-payload-sentinel")), false);
    assert.deepEqual(allSummaries.map((session) => session.id), [
      "aux-active-session-1",
      "aux-closed-session-1",
      "aux-active-session-2",
    ]);
    assert.equal(allSummaries[1]?.status, "closed");
    assert.equal("messages" in allSummaries[1]!, false);
    assert.deepEqual(auxiliaryStorage.listActiveAuxiliarySessionSummaries([]), []);
    assert.deepEqual(auxiliaryStorage.listAuxiliarySessionSummaries([]), []);
  } finally {
    auxiliaryStorage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

test("AuxiliarySessionService は通常起動と同じ選択済み runtime option context で active session を作成する", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-model-selection-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  let sessionStorage: SessionStorage | null = null;
  let auxiliaryStorage: AuxiliarySessionStorage | null = null;

  try {
    sessionStorage = new SessionStorage(dbPath);
    auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
    const parent = {
      ...buildNewSession({
        taskTitle: "main task",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "mate",
        character: "Mate",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      }),
      id: "session-main",
      provider: "codex",
      model: "gpt-5.4",
      reasoningEffort: "high" as const,
      customAgentName: "parent-agent",
    };
    sessionStorage.upsertSession(parent);
    const activeModelCatalog = buildTestModelCatalogSnapshot(parent.catalogRevision);

    const service = new AuxiliarySessionService({
      getParentSession: (parentSessionId) => sessionStorage?.getSession(parentSessionId) ?? null,
      getStorage: () => auxiliaryStorage!,
      getModelCatalogSnapshot: () => activeModelCatalog,
    });

    const auxiliary = await service.createAuxiliarySession({
      parentSessionId: parent.id,
      provider: parent.provider,
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      approvalMode: "never",
      codexSandboxMode: "read-only",
      customAgentName: "last-used-agent",
    });

    assert.equal(auxiliary.provider, parent.provider);
    assert.equal(auxiliary.model, "gpt-5.4-mini");
    assert.equal(auxiliary.reasoningEffort, "medium");
    assert.equal(auxiliary.approvalMode, "never");
    assert.equal(auxiliary.codexSandboxMode, "read-only");
    assert.equal(auxiliary.customAgentName, "last-used-agent");
  } finally {
    auxiliaryStorage?.close();
    sessionStorage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliaryのlatest-session作成は再検証で同値だったresolverのruntime設定を一組で保存する"
// oracle = { type = "contract", ref = "docs/adr/007-provider-runtime-selection-inheritance.md" }
// fault = "resolverから受け取ったmodel・権限・custom agentを親または既定値で上書きして保存する"
// observable = "resolverに渡したprovider、および作成済みAuxiliaryのruntime選択"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-service"
// lifecycle = "permanent"
// @end-test-value
test("AuxiliarySessionService は latest-session 選択を Main の resolver から一組で取得する", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-latest-selection-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  let sessionStorage: SessionStorage | null = null;
  let auxiliaryStorage: AuxiliarySessionStorage | null = null;

  try {
    sessionStorage = new SessionStorage(dbPath);
    auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
    const parent = {
      ...buildNewSession({
        taskTitle: "main task",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "mate",
        character: "Mate",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      }),
      id: "session-main",
      provider: "codex",
    };
    sessionStorage.upsertSession(parent);
    const resolvedProviderIds: Array<string | null | undefined> = [];
    const service = new AuxiliarySessionService({
      getParentSession: (parentSessionId) => sessionStorage?.getSession(parentSessionId) ?? null,
      getStorage: () => auxiliaryStorage!,
      getModelCatalogSnapshot: () => buildTestModelCatalogSnapshot(parent.catalogRevision),
      resolveSessionLaunchSelection: async (providerId) => {
        resolvedProviderIds.push(providerId);
        return {
          provider: "codex",
          catalogRevision: 8,
          model: "gpt-5.4-mini",
          reasoningEffort: "medium",
          approvalMode: "never",
          codexSandboxMode: "read-only",
          customAgentName: "latest-agent",
        };
      },
    });

    const auxiliary = await service.createAuxiliarySession({
      parentSessionId: parent.id,
      provider: "codex",
      runtimeSelection: "latest-session",
    });

    assert.deepEqual(resolvedProviderIds, ["codex", "codex"]);
    assert.deepEqual(
      {
        provider: auxiliary.provider,
        catalogRevision: auxiliary.catalogRevision,
        model: auxiliary.model,
        reasoningEffort: auxiliary.reasoningEffort,
        approvalMode: auxiliary.approvalMode,
        codexSandboxMode: auxiliary.codexSandboxMode,
        customAgentName: auxiliary.customAgentName,
      },
      {
        provider: "codex",
        catalogRevision: 8,
        model: "gpt-5.4-mini",
        reasoningEffort: "medium",
        approvalMode: "never",
        codexSandboxMode: "read-only",
        customAgentName: "latest-agent",
      },
    );
  } finally {
    auxiliaryStorage?.close();
    sessionStorage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

// @test-value v2
// kind = "contract"
// claim = "latest-sessionの解決失敗または直接runtime optionの混在はAuxiliaryを保存せず拒否する"
// oracle = { type = "adr", ref = "docs/adr/007-provider-runtime-selection-inheritance.md#decision" }
// fault = "解決失敗を既定値で隠す、またはlatest-sessionへ直接optionを混ぜて不整合なruntimeを保存する"
// observable = "reject内容と親に紐づくAuxiliary保存件数"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-runtime-selection"
// lifecycle = "permanent"
// @end-test-value
test("AuxiliarySessionService は latest-session の取得失敗と runtime option 混在を保存前に拒否する", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-latest-failure-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  let sessionStorage: SessionStorage | null = null;
  let auxiliaryStorage: AuxiliarySessionStorage | null = null;

  try {
    sessionStorage = new SessionStorage(dbPath);
    auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
    const parent = {
      ...buildNewSession({
        taskTitle: "main task",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "mate",
        character: "Mate",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      }),
      id: "session-main",
      provider: "codex",
    };
    sessionStorage.upsertSession(parent);
    const service = new AuxiliarySessionService({
      getParentSession: (parentSessionId) => sessionStorage?.getSession(parentSessionId) ?? null,
      getStorage: () => auxiliaryStorage!,
      getModelCatalogSnapshot: () => buildTestModelCatalogSnapshot(parent.catalogRevision),
      resolveSessionLaunchSelection: async () => {
        throw new Error("latest selection conversion failed");
      },
    });

    await assert.rejects(
      service.createAuxiliarySession({
        parentSessionId: parent.id,
        provider: "codex",
        runtimeSelection: "latest-session",
      }),
      /latest selection conversion failed/,
    );
    assert.deepEqual(await service.listAuxiliarySessions(parent.id), []);

    await assert.rejects(
      service.createAuxiliarySession({
        parentSessionId: parent.id,
        provider: "codex",
        runtimeSelection: "latest-session",
        approvalMode: "never",
      }),
      /runtime option を直接指定できない/,
    );
    assert.deepEqual(await service.listAuxiliarySessions(parent.id), []);
  } finally {
    auxiliaryStorage?.close();
    sessionStorage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliary作成は定義済みenum外のruntime optionを保存前に拒否する"
// oracle = { type = "adr", ref = "docs/adr/007-provider-runtime-selection-inheritance.md#decision" }
// fault = "未知のruntime optionを既定値へ変換して保存し、後続turnの実行条件を変える"
// observable = "不正optionごとのrejectと保存件数0"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-runtime-validation"
// lifecycle = "permanent"
// @end-test-value
test("AuxiliarySessionService は現行 enum 外の runtime option を拒否して保存しない", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-runtime-option-fallback-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  let sessionStorage: SessionStorage | null = null;
  let auxiliaryStorage: AuxiliarySessionStorage | null = null;

  try {
    sessionStorage = new SessionStorage(dbPath);
    auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
    const parentTemplate = {
      ...buildNewSession({
        taskTitle: "main task",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "mate",
        character: "Mate",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: "on-request",
        codexSandboxMode: "workspace-write-network",
      }),
      provider: "codex",
    };
    const activeModelCatalog = buildTestModelCatalogSnapshot(parentTemplate.catalogRevision);

    const service = new AuxiliarySessionService({
      getParentSession: (parentSessionId) => sessionStorage?.getSession(parentSessionId) ?? null,
      getStorage: () => auxiliaryStorage!,
      getModelCatalogSnapshot: () => activeModelCatalog,
    });

    const malformedInputs: Array<{
      input: {
        approvalMode?: ApprovalMode;
        codexSandboxMode?: CodexSandboxMode;
      };
      expectedError: RegExp;
    }> = [
      {
        input: {
          approvalMode: "allow-all" as ApprovalMode,
        },
        expectedError: /approvalMode を解釈できない/,
      },
      {
        input: {
          approvalMode: " never " as ApprovalMode,
        },
        expectedError: /approvalMode を解釈できない/,
      },
      {
        input: {
          codexSandboxMode: " danger-full-access " as CodexSandboxMode,
        },
        expectedError: /codexSandboxMode を解釈できない/,
      },
      {
        input: {
          codexSandboxMode: 1 as unknown as CodexSandboxMode,
        },
        expectedError: /codexSandboxMode を解釈できない/,
      },
    ];

    for (const [index, malformedInput] of malformedInputs.entries()) {
      const parent = {
        ...parentTemplate,
        id: `session-main-${index}`,
      };
      sessionStorage.upsertSession(parent);

      await assert.rejects(
        service.createAuxiliarySession({
          parentSessionId: parent.id,
          provider: parent.provider,
          ...malformedInput.input,
        }),
        malformedInput.expectedError,
      );
      assert.deepEqual(await service.listAuxiliarySessions(parent.id), []);
    }
  } finally {
    auxiliaryStorage?.close();
    sessionStorage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliary作成でruntime optionを省略した場合、指定Providerのcatalog既定値を一組で保存する"
// oracle = { type = "adr", ref = "docs/adr/007-provider-runtime-selection-inheritance.md#decision" }
// fault = "Providerの既定model/reasoningを欠落させる、または別Providerの既定値を混在させる"
// observable = "作成Auxiliaryのprovider、catalogRevision、model、reasoningEffortと保存件数"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-provider-defaults"
// lifecycle = "permanent"
// @end-test-value
test("AuxiliarySessionService は選択値なしなら指定 Provider と同じ既定 runtime context で active session を作成する", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-provider-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  let sessionStorage: SessionStorage | null = null;
  let auxiliaryStorage: AuxiliarySessionStorage | null = null;

  try {
    sessionStorage = new SessionStorage(dbPath);
    auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
    const parent = {
      ...buildNewSession({
        taskTitle: "main task",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "mate",
        character: "Mate",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: "never",
      }),
      id: "session-main",
      provider: "codex",
      model: "gpt-5.4",
      reasoningEffort: "high" as const,
      codexSandboxMode: "danger-full-access" as const,
    };
    sessionStorage.upsertSession(parent);
    const activeModelCatalog = buildTestModelCatalogSnapshot(parent.catalogRevision);

    const service = new AuxiliarySessionService({
      getParentSession: (parentSessionId) => sessionStorage?.getSession(parentSessionId) ?? null,
      getStorage: () => auxiliaryStorage!,
      getModelCatalogSnapshot: () => activeModelCatalog,
    });

    const auxiliary = await service.createAuxiliarySession({
      parentSessionId: parent.id,
      provider: "copilot",
    });

    assert.equal(auxiliary.parentSessionId, parent.id);
    assert.equal(auxiliary.provider, "copilot");
    assert.equal(auxiliary.catalogRevision, activeModelCatalog.revision);
    assert.equal(auxiliary.model, "claude-sonnet-4.5");
    assert.equal(auxiliary.reasoningEffort, "medium");
    assert.equal(auxiliary.approvalMode, DEFAULT_APPROVAL_MODE);
    assert.equal(auxiliary.codexSandboxMode, DEFAULT_CODEX_SANDBOX_MODE);
    assert.equal(auxiliary.customAgentName, "");
    assert.equal(auxiliary.displayAfterMessageIndex, parent.messages.length - 1);
    assert.equal((await service.listAuxiliarySessions(parent.id)).length, 1);
  } finally {
    auxiliaryStorage?.close();
    sessionStorage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

// @test-value v2
// kind = "contract"
// claim = "保存済みAuxiliaryのparent ID・runtime境界と、Companion parentから解決したworkspace contextを維持する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md" }
// fault = "既存AuxiliaryのCompanion parent contextを欠落させる、または親外のdirectoryを許可する"
// observable = "保存済みAuxiliaryのparent ID、approval/sandbox、許可directory、解決済みworkspace・branch・thread"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-companion-parent"
// lifecycle = "permanent"
// @end-test-value
test("AuxiliarySessionService は Companion 由来の parent runtime session から実行 context を継承する", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-companion-parent-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  let auxiliaryStorage: AuxiliarySessionStorage | null = null;

  try {
    auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
    const companion = buildCompanionSession();
    const activeModelCatalog = buildTestModelCatalogSnapshot(companion.catalogRevision);
    const service = new AuxiliarySessionService({
      getParentSession: (parentSessionId) =>
        parentSessionId === companion.id
          ? companionSessionToAuxiliaryParentSession(companion)
          : null,
      getStorage: () => auxiliaryStorage!,
      getModelCatalogSnapshot: () => activeModelCatalog,
    });

    const auxiliary = auxiliaryStorage.upsertAuxiliarySession(buildAuxiliarySession({
      id: "aux-companion-restored",
      parentSessionId: companion.id,
      provider: companion.provider,
      catalogRevision: companion.catalogRevision,
      model: companion.model,
      reasoningEffort: companion.reasoningEffort,
      approvalMode: companion.approvalMode,
      codexSandboxMode: companion.codexSandboxMode,
      codexSpeed: companion.codexSpeed,
      codexReviewer: companion.codexReviewer,
      customAgentName: companion.customAgentName,
      allowedAdditionalDirectories: [...companion.allowedAdditionalDirectories],
      displayAfterMessageIndex: companion.messages.length - 1,
    }));

    assert.equal(auxiliary.parentSessionId, companion.id);
    assert.equal(auxiliary.approvalMode, companion.approvalMode);
    assert.equal(auxiliary.codexSandboxMode, companion.codexSandboxMode);
    assert.deepEqual(auxiliary.allowedAdditionalDirectories, ["C:/review-context"]);
    assert.equal(auxiliary.displayAfterMessageIndex, companion.messages.length - 1);

    const runtimeSession = await service.getAuxiliaryRuntimeSession(auxiliary.id);
    assert.ok(runtimeSession);
    assert.equal(runtimeSession.workspacePath, companion.worktreePath);
    assert.equal(runtimeSession.branch, companion.companionBranch);
    assert.equal(runtimeSession.threadId, "");
    assert.deepEqual(runtimeSession.messages, []);
    assert.ok(companionSessionToAuxiliaryParentSession({ ...companion, status: "recovery-required" }));
    assert.equal(companionSessionToAuxiliaryParentSession({ ...companion, status: "merged" }), null);
    assert.equal(companionSessionToAuxiliaryParentSession({ ...companion, status: "discarded" }), null);
    assert.equal(
      companionSessionToAuxiliaryParentSession({ ...companion, status: "unknown-status" as typeof companion.status }),
      null,
    );
  } finally {
    auxiliaryStorage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

// @test-value v2
// kind = "contract"
// claim = "起動時に実行中のAuxiliaryは再開可能なerror状態へ遷移し、履歴を保持する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#recovery" }
// fault = "前回実行中のAuxiliaryをrunningのまま放置し、次回実行で二重実行または履歴欠落を起こす"
// observable = "recoverInterruptedSessions後のrunState、status、末尾メッセージ"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-recovery"
// lifecycle = "permanent"
// @end-test-value
test("AuxiliarySessionService は起動時に running active session を復旧可能な error 状態へ戻す", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-recover-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  let sessionStorage: SessionStorage | null = null;
  let auxiliaryStorage: AuxiliarySessionStorage | null = null;

  try {
    sessionStorage = new SessionStorage(dbPath);
    auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
    const parent = {
      ...buildNewSession({
        taskTitle: "main task",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "mate",
        character: "Mate",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      }),
      id: "session-main",
    };
    sessionStorage.upsertSession(parent);

    const service = new AuxiliarySessionService({
      getParentSession: (parentSessionId) => sessionStorage?.getSession(parentSessionId) ?? null,
      getStorage: () => auxiliaryStorage!,
      getModelCatalogSnapshot: () => buildTestModelCatalogSnapshot(parent.catalogRevision),
    });
    const auxiliary = await service.createAuxiliarySession({ parentSessionId: parent.id, provider: parent.provider });
    auxiliaryStorage.upsertAuxiliarySession({
      ...auxiliary,
      runState: "running",
      messages: [{ role: "user", text: "review" }],
    });

    await service.recoverInterruptedSessions();

    const recovered = await service.getAuxiliarySession(auxiliary.id);
    assert.equal(recovered?.runState, "error");
    assert.equal(recovered?.status, "active");
    const interruptionMessage = "前回の Auxiliary 実行はアプリ終了で中断された可能性があります。必要ならもう一度送信してください。";
    assert.equal(recovered?.messages.length, 2);
    assert.equal(recovered?.messages[0]?.role, "user");
    assert.equal(recovered?.messages[0]?.text, "review");
    assert.equal(recovered?.messages[1]?.role, "assistant");
    assert.equal(recovered?.messages[1]?.text, interruptionMessage);
    assert.equal(recovered?.messages.filter((message) => message.text === interruptionMessage).length, 1);
    await service.recoverInterruptedSessions();
    assert.deepEqual((await service.getAuxiliarySession(auxiliary.id))?.messages, recovered?.messages);
  } finally {
    auxiliaryStorage?.close();
    sessionStorage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliary runtime session は親Session files directoryを追加許可し、既存の許可directoryを保持する"
// oracle = { type = "contract", ref = "docs/design/session-local-files.md#access-contract" }
// fault = "親のSession filesへアクセスできない、または既存の許可directoryを上書きする"
// observable = "追加後のallowedAdditionalDirectoriesの順序と内容"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-files-boundary"
// lifecycle = "permanent"
// @end-test-value
test("Auxiliary runtime session は parent の session files directory を追加許可できる", () => {
  const session = {
    id: "aux-1",
    allowedAdditionalDirectories: ["C:/shared"],
  };
  const withParentSessionFiles = appendSessionFilesDirectoryForSessionId("C:/user-data", session, "session-main");

  assert.equal(withParentSessionFiles.id, "aux-1");
  assert.deepEqual(withParentSessionFiles.allowedAdditionalDirectories, [
    "C:/shared",
    resolveSessionFilesDirectory("C:/user-data", "session-main"),
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliary summary maintenance command は一回の呼び出しを要求batch以内に制限し、壊れたpayloadを完了扱いにせず残件として返す"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#persistence" }
// fault = "一回のmaintenance commandが全件を処理する、または壊れた行を暗黙に消化済みとして再開位置を失う"
// observable = "各commandのprocessed上限、updated、remainingの推移"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-storage-bounded-maintenance"
// lifecycle = "permanent"
// @end-test-value
test("Auxiliary summary maintenance はbatch単位で再開でき、壊れたpayloadを残件として返す", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-bounded-maintenance-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  let storage: AuxiliarySessionStorage | null = null;
  try {
    storage = new AuxiliarySessionStorage(dbPath);
    for (const id of ["aux-a-valid", "aux-b-valid"]) {
      storage.upsertAuxiliarySession(buildAuxiliarySession({
        id,
        parentSessionId: "parent-bounded-maintenance",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }));
    }
    storage.close();
    storage = null;

    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("UPDATE auxiliary_sessions SET summary_json = '' WHERE id IN (?, ?)")
        .run("aux-a-valid", "aux-b-valid");
      db.prepare(`
        INSERT INTO auxiliary_sessions (id, parent_session_id, status, created_at, updated_at, payload_json, summary_json)
        VALUES (?, ?, 'active', ?, ?, ?, '')
      `).run(
        "aux-z-malformed",
        "parent-bounded-maintenance",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "not-json",
      );
    } finally {
      db.close();
    }

    storage = new AuxiliarySessionStorage(dbPath);
    assert.deepEqual(storage.backfillAuxiliarySessionSummaries({ batchSize: 1 }), {
      processed: 1,
      updated: 1,
      remaining: 2,
    });
    assert.deepEqual(storage.backfillAuxiliarySessionSummaries({ batchSize: 1 }), {
      processed: 1,
      updated: 1,
      remaining: 1,
    });
    assert.deepEqual(storage.backfillAuxiliarySessionSummaries({ batchSize: 1 }), {
      processed: 1,
      updated: 0,
      remaining: 1,
      error: { id: "aux-z-malformed", message: "Auxiliary session backfill payload is invalid." },
    });
  } finally {
    storage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary runtime metadata CAS は payload の本文と draft を保持し stale patch を拒否する"
// oracle = { type = "contract", ref = "docs/design/electron-session-store.md#settingscatalogservice" }
// fault = "catalog migration が auxiliary payload 全体を書き戻し、本文またはdraftを失う"
// observable = "listAllAuxiliarySessions の metadata、messages、composerDraft、CAS結果"
// observation_boundary = "public-boundary"
// scope = "auxiliary-storage-runtime-metadata-cas"
// lifecycle = "permanent"
// impact = "Auxiliaryの会話内容と入力中draftが失われる"
// distinction = "同一transactionのpayload再読込とmetadata CASを実DBで確認する"
// @end-test-value
test("Auxiliary runtime metadata CAS は payload の本文と draft を保持し stale patch を拒否する", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-runtime-metadata-cas-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  const storage = new AuxiliarySessionStorage(dbPath);
  try {
    const session: AuxiliarySession = {
      id: "aux-runtime-cas",
      parentSessionId: "parent-runtime-cas",
      status: "active",
      runState: "idle",
      title: "Auxiliary",
      provider: "codex",
      catalogRevision: 1,
      model: "gpt-5.4",
      reasoningEffort: "high",
      approvalMode: DEFAULT_APPROVAL_MODE,
      codexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE,
      codexSpeed: "standard",
      codexReviewer: "user",
      customAgentName: "",
      allowedAdditionalDirectories: [],
      threadId: "aux-thread",
      composerDraft: "draft to keep",
      messages: [{ role: "user", text: "message to keep" }],
      displayAfterMessageIndex: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      closedAt: "",
      characterId: "char-1",
      characterRuntimeSnapshot: null,
      characterIconPath: "",
      preview: "",
    };
    storage.upsertAuxiliarySession(session);
    const expected = {
      provider: session.provider,
      catalogRevision: session.catalogRevision,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      threadId: session.threadId,
      updatedAt: session.updatedAt,
    };
    const next = { ...expected, catalogRevision: 2, threadId: "" , updatedAt: "2026-08-01T00:00:00.000Z" };
    const updated = storage.updateAuxiliarySessionRuntimeMetadataIfMatches({
      auxiliarySessionId: session.id,
      parentSessionId: session.parentSessionId,
      createdAt: session.createdAt,
      expected,
      next,
    });
    assert.equal(updated?.catalogRevision, 2);
    const stored = storage.listAllAuxiliarySessions()[0];
    assert.equal(stored?.composerDraft, session.composerDraft);
    assert.deepEqual(stored?.messages.map(({ role, text }) => ({ role, text })), session.messages);
    assert.equal(storage.updateAuxiliarySessionRuntimeMetadataIfMatches({
      auxiliarySessionId: session.id,
      parentSessionId: session.parentSessionId,
      createdAt: session.createdAt,
      expected,
      next: { ...next, catalogRevision: 3 },
    }), null);
  } finally {
    storage.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliaryの非同期読取後更新は削除済み行を再作成せず、現存行の更新と終了だけを成功させる"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#persistence" }
// fault = "親削除後に保持済みpayloadを汎用UPSERTし、削除済みAuxiliaryを孤立行として復活させる"
// observable = "CAS更新結果、削除後のrow不在、現存rowの本文とclosed status"
// observation_boundary = "public-boundary"
// scope = "auxiliary-storage-existing-row-cas"
// lifecycle = "permanent"
// impact = "削除済み会話の本文・draftが永続化層へ再導入される"
// distinction = "実SQLiteのdelete→update順序とexisting-row-only transactionを観測し、単なる型・mock確認と区別する"
// @end-test-value
test("Auxiliaryの削除後更新は行を復活させず現存行の更新と終了に成功する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-existing-row-cas-"));
  const dbPath = path.join(directory, "withmate.db");
  const storage = new AuxiliarySessionStorage(dbPath);
  const parentStorage = new SessionStorage(dbPath);
  try {
    const session = buildAuxiliarySession({ id: "aux-existing-row-cas", parentSessionId: "parent-existing-row-cas" });
    parentStorage.upsertSession(buildNewSession({
      id: session.parentSessionId,
      taskTitle: "parent",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "mate",
      character: "Mate",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    }));
    storage.upsertAuxiliarySession(session);
    storage.deleteAuxiliarySessionsForParent(session.parentSessionId);
    assert.equal(storage.updateAuxiliarySessionIfMatches({
      session: { ...session, title: "must not return" },
      expectedSession: session,
    }), null);
    assert.equal(storage.getAuxiliarySession(session.id), null);

    storage.upsertAuxiliarySession(session);
    const rawDb = new DatabaseSync(dbPath);
    try {
      rawDb.prepare("DELETE FROM sessions WHERE id = ?").run(session.parentSessionId);
    } finally {
      rawDb.close();
    }
    assert.equal(storage.updateAuxiliarySessionIfMatches({
      session: { ...session, title: "parent was deleted" },
      expectedSession: session,
    }), null);
    assert.equal(storage.getAuxiliarySession(session.id)?.title, session.title);
    parentStorage.upsertSession(buildNewSession({
      id: session.parentSessionId,
      taskTitle: "parent",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "mate",
      character: "Mate",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    }));
    storage.upsertAuxiliarySession(session);
    const updated = storage.updateAuxiliarySessionIfMatches({
      session: { ...session, title: "updated", updatedAt: "2026-08-02T00:00:00.000Z" },
      expectedSession: session,
    });
    assert.equal(updated?.title, "updated");
    storage.upsertAuxiliarySession({ ...updated!, title: "same-minute-current" });
    assert.equal(storage.updateAuxiliarySessionIfMatches({
      session: { ...updated!, title: "stale payload" },
      expectedSession: updated!,
    }), null);
    storage.upsertAuxiliarySession(updated!);
    const closed = storage.updateAuxiliarySessionIfMatches({
      session: { ...updated!, status: "closed", closedAt: "2026-08-02T00:01:00.000Z", updatedAt: "2026-08-02T00:01:00.000Z" },
      expectedSession: updated!,
    });
    assert.equal(closed?.status, "closed");
    const v6Db = new DatabaseSync(dbPath);
    try {
      ensureV6Schema(v6Db);
      assert.ok(v6Db.prepare("SELECT id FROM sessions WHERE id = ?").get(session.parentSessionId));
      assert.equal(v6Db.prepare("SELECT id FROM sessions_v6 WHERE id = ?").get(session.parentSessionId), undefined);
      assert.equal(storage.updateAuxiliarySessionIfMatches({
        session: { ...closed!, title: "legacy parent must not authorize V6 update" },
        expectedSession: closed!,
      }), null);
      assert.equal(storage.getAuxiliarySession(session.id)?.title, closed?.title);
    } finally {
      v6Db.close();
    }
  } finally {
    storage.close();
    parentStorage.close();
    await removeDirectoryWithRetry(directory);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary serviceのread待機中に親・保存先が交換されても旧行を再作成しない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#persistence" }
// fault = "await中に親とstorageが交換された後、保持済みrowを新しい保存先へ書き戻す"
// observable = "更新拒否、旧storageのrow不在、新storageの同一row不変、保存先の再取得回数"
// observation_boundary = "public-boundary"
// scope = "auxiliary-service-read-write-owner-barrier"
// lifecycle = "permanent"
// impact = "削除済みAuxiliaryの本文がstorage交換後に復活する"
// distinction = "serviceの実read barrierとSQLite CASを組み合わせ、storage直呼出しだけの検証と区別する"
// @end-test-value
test("Auxiliary serviceはread待機中の親削除と保存先交換後の更新を拒否する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-service-owner-barrier-"));
  const dbPath = path.join(directory, "withmate.db");
  const storage = new AuxiliarySessionStorage(dbPath);
  const parentStorage = new SessionStorage(dbPath);
  try {
    const session = buildAuxiliarySession({ id: "aux-service-owner-barrier", parentSessionId: "parent-service-owner-barrier" });
    parentStorage.upsertSession(buildNewSession({
      id: session.parentSessionId,
      taskTitle: "parent",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "mate",
      character: "Mate",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    }));
    storage.upsertAuxiliarySession(session);
    let releaseRead!: () => void;
    const readBarrier = new Promise<void>((resolve) => { releaseRead = resolve; });
    const capturedStorage = {
      getAuxiliarySession: async () => {
        const captured = storage.getAuxiliarySession(session.id);
        await readBarrier;
        return captured;
      },
      updateAuxiliarySessionIfMatches: storage.updateAuxiliarySessionIfMatches.bind(storage),
    } as unknown as AuxiliarySessionStorage;
    let activeStorage: AuxiliarySessionStorage = capturedStorage;
    let storageRequests = 0;
    const service = new AuxiliarySessionService({
      getParentSession: () => parentStorage.getSession(session.parentSessionId),
      getStorage: () => { storageRequests += 1; return activeStorage; },
    });
    const update = service.updateAuxiliarySession({ ...session, title: "must not return" });
    activeStorage = new AuxiliarySessionStorage(path.join(directory, "replacement.db"));
    const replacementParentStorage = new SessionStorage(path.join(directory, "replacement.db"));
    replacementParentStorage.upsertSession(buildNewSession({
      id: session.parentSessionId,
      taskTitle: "replacement parent",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "mate",
      character: "Mate",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    }));
    activeStorage.upsertAuxiliarySession({ ...session, title: "replacement sentinel" });
    storage.deleteAuxiliarySessionsForParent(session.parentSessionId);
    parentStorage.deleteSession(session.parentSessionId);
    releaseRead();
    await assert.rejects(update, /削除または更新されたため/);
    assert.equal(storage.getAuxiliarySession(session.id), null);
    assert.equal(activeStorage.getAuxiliarySession(session.id)?.title, "replacement sentinel");
    assert.equal(storageRequests, 1);
    replacementParentStorage.close();
    activeStorage.close();
  } finally {
    storage.close();
    parentStorage.close();
    await removeDirectoryWithRetry(directory);
  }
});

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
import { appendSessionFilesDirectoryForSessionId, resolveSessionFilesDirectory } from "../../src-electron/session-files.js";
import { SessionStorage } from "../../src-electron/session-storage.js";

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

    const db = new DatabaseSync(dbPath);
    try {
      const columns = (db.prepare("PRAGMA table_info(auxiliary_sessions)").all() as SqliteColumnInfoRow[])
        .map((column) => column.name);
      assert.equal(columns.includes("created_at"), true);

      const indexes = (db.prepare("PRAGMA index_list(auxiliary_sessions)").all() as SqliteIndexListRow[])
        .map((row) => row.name);
      assert.equal(indexes.includes("idx_auxiliary_sessions_parent_updated"), true);
      assert.equal(indexes.includes("idx_auxiliary_sessions_parent_created"), true);
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
// claim = "既存summary未生成行だけが初回一覧時に監査由来previewで一度補完される"
// oracle = { type = "contract", ref = "issue-710-preview-legacy-migration" }
// fault = "通常の一覧取得でpayloadを再投影するか、旧assistant joinをpreviewへ保存する"
// observable = "再起動後listAuxiliarySessionsのpreviewとresolver呼出回数"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-storage-migration"
// lifecycle = "permanent"
// @end-test-value
test("旧summary未生成行は監査由来previewで初回だけ補完する", async () => {
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
    assert.equal(storage.listAuxiliarySessions("parent-legacy-preview")[0]?.preview, "監査で確定した最終block");
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
// claim = "Auxiliaryの作成・更新・再読込・終了は各会話のruntime option、draft、thread、preview、親境界を保つ"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: per-session persistence and lifecycle" }
// fault = "複数Auxiliaryの作成やstale保存で別会話の状態を上書きする、previewをstreaming中に巻き戻す、または親境界を越えて残す"
// observable = "作成・再読込・runtime upsert・stale update・close・parent filteringの公開結果"
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
    assert.equal(auxiliary.parentSessionId, parent.id);
    assert.equal(auxiliary.status, "active");
    assert.equal(auxiliary.runState, "idle");
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
    assert.equal(service.listAuxiliarySessions(parent.id).length, 2);
    const untouchedSibling = service.getAuxiliarySession(sameActive.id);
    assert.ok(untouchedSibling);

    const updated = service.updateAuxiliarySession({
      ...auxiliary,
      composerDraft: "review this diff",
      messages: [{ role: "assistant", text: "finding" }],
    });
    assert.equal(service.getAuxiliarySession(auxiliary.id)?.composerDraft, "review this diff");
    assert.equal(service.listAuxiliarySessions(parent.id).some((entry) => entry.id === updated.id), true);
    const siblingAfterUpdate = service.getAuxiliarySession(sameActive.id);
    assert.equal(siblingAfterUpdate?.provider, untouchedSibling.provider);
    assert.equal(siblingAfterUpdate?.threadId, untouchedSibling.threadId);
    assert.equal(siblingAfterUpdate?.composerDraft, untouchedSibling.composerDraft);
    assert.deepEqual(siblingAfterUpdate?.messages, untouchedSibling.messages);

    const movedDisplayAnchor = service.updateAuxiliarySession({
      ...updated,
      displayAfterMessageIndex: 3,
    });
    assert.equal(movedDisplayAnchor.displayAfterMessageIndex, 3);
    const staleDraftWithOldDisplayAnchor = service.updateAuxiliarySession({
      ...updated,
      composerDraft: "stale draft with old anchor",
    });
    assert.equal(staleDraftWithOldDisplayAnchor.displayAfterMessageIndex, 3);

    const runtimeSession = await service.getAuxiliaryRuntimeSession(movedDisplayAnchor.id);
    assert.ok(runtimeSession);
    const persistedRuntime = service.upsertAuxiliaryRuntimeSession({
      ...runtimeSession,
      messages: [...runtimeSession.messages, { role: "assistant", text: "done" }],
      updatedAt: "2026-05-24T00:00:00.000Z",
    }, { confirmedFinalAssistantText: "done" });
    assert.equal(persistedRuntime.composerDraft, "");
    assert.equal(persistedRuntime.codexSandboxMode, DEFAULT_CODEX_SANDBOX_MODE);
    assert.equal(persistedRuntime.preview, "done");
    for (const runState of ["running", "error", "idle"] as const) {
      const preserved = service.upsertAuxiliaryRuntimeSession({
        ...runtimeSession,
        runState,
        preview: "途中で上書きしない",
        messages: [...persistedRuntime.messages, { role: "assistant", text: "中間通知" }],
        updatedAt: `2026-05-24T00:00:0${runState === "running" ? "1" : runState === "error" ? "2" : "3"}.000Z`,
      });
      assert.equal(preserved.preview, "done");
    }
    const staleDraftUpdate = service.updateAuxiliarySession({
      ...updated,
      composerDraft: "review this diff",
    });
    assert.equal(staleDraftUpdate.composerDraft, "");
    assert.equal(staleDraftUpdate.messages.length, service.getAuxiliarySession(movedDisplayAnchor.id)?.messages.length);

    const migratedAuxiliary = auxiliaryStorage.upsertAuxiliarySession({
      ...staleDraftUpdate,
      catalogRevision: staleDraftUpdate.catalogRevision + 1,
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      threadId: "",
    });
    activeModelCatalog = buildTestModelCatalogSnapshot(migratedAuxiliary.catalogRevision);
    const staleRendererSave = service.updateAuxiliarySession({
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
    const staleThreadRendererSave = service.updateAuxiliarySession({
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
    const draftBeforeModelChange = service.updateAuxiliarySession({
      ...olderCatalogAuxiliary,
      composerDraft: "draft saved before model change",
    });
    const explicitModelChange = service.updateAuxiliarySession({
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
    const staleDraftAfterModelChange = service.updateAuxiliarySession({
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
    const staleSaveAfterCatalogReset = service.updateAuxiliarySession({
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
    const staleDraftAfterSettingsChange = service.updateAuxiliarySession({
      ...staleSaveAfterCatalogReset,
      composerDraft: "draft saved after settings change",
    });
    assert.equal(staleDraftAfterSettingsChange.approvalMode, userConfiguredAuxiliary.approvalMode);
    assert.equal(staleDraftAfterSettingsChange.codexSandboxMode, userConfiguredAuxiliary.codexSandboxMode);
    assert.equal(staleDraftAfterSettingsChange.customAgentName, userConfiguredAuxiliary.customAgentName);
    assert.deepEqual(staleDraftAfterSettingsChange.allowedAdditionalDirectories, userConfiguredAuxiliary.allowedAdditionalDirectories);
    assert.equal(staleDraftAfterSettingsChange.composerDraft, userConfiguredAuxiliary.composerDraft);

    auxiliaryStorage.upsertAuxiliarySession({ ...staleDraftAfterSettingsChange, runState: "running" });
    assert.throws(
      () => service.closeAuxiliarySession(auxiliary.id),
      /実行中の Auxiliary Session は終了できない/,
    );
    auxiliaryStorage.upsertAuxiliarySession(staleDraftAfterSettingsChange);

    const closed = service.closeAuxiliarySession(auxiliary.id);
    assert.equal(closed.status, "closed");
    assert.equal(closed.composerDraft, "");
    const closedSecond = service.closeAuxiliarySession(sameActive.id);
    assert.equal(closedSecond.status, "closed");
    assert.equal(service.getActiveAuxiliarySession(parent.id), null);
    assert.equal(service.listAuxiliarySessions(parent.id).length, 2);

    sessionStorage.replaceSessions([{ ...parent, taskTitle: "renamed main task" }]);
    assert.equal(service.listAuxiliarySessions(parent.id).length, 2);

    const orphanedParent = { ...parent, id: "session-orphaned", taskTitle: "orphaned main task" };
    sessionStorage.upsertSession(orphanedParent);
    const orphanedAuxiliary = await service.createAuxiliarySession({
      parentSessionId: orphanedParent.id,
      provider: orphanedParent.provider,
    });
    assert.equal(service.listAuxiliarySessions(orphanedParent.id)[0]?.id, orphanedAuxiliary.id);
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
    assert.equal(service.listAuxiliarySessions(parent.id).length, 2);
    assert.deepEqual(service.listAuxiliarySessions(orphanedParent.id), []);
    assert.equal(service.listAuxiliarySessions(activeCompanion.id)[0]?.id, "aux-companion-parent");
    assert.equal(service.listAuxiliarySessions(recoveryRequiredCompanion.id)[0]?.id, "aux-recovery-companion-parent");
    assert.deepEqual(service.listAuxiliarySessions(mergedCompanion.id), []);
    assert.deepEqual(service.listAuxiliarySessions(discardedCompanion.id), []);
    assert.equal(service.listAuxiliarySessions(unknownStatusCompanion.id)[0]?.id, "aux-unknown-status-companion-parent");

    sessionStorage.deleteSession(parent.id);
    assert.deepEqual(service.listAuxiliarySessions(parent.id), []);
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
// oracle = { type = "contract", ref = "issue-710 Character selection and persistence" }
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
    const afterFailure = service.getAuxiliarySession(preserved.id);
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
// claim = "親削除とAuxiliary作成は同じCharacter ownership coordinator境界で直列化され、orphanを作らない"
// oracle = { type = "contract", ref = "issue-710 parent delete/create race" }
// fault = "deferred create中に親削除が割り込み、親のないAuxiliaryが残る"
// observable = "作成後のparent別Auxiliary一覧と親なしcreateのreject"
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
    let resolveSelectionCalls = 0;
    const service = new AuxiliarySessionService({
      getParentSession: (id) => sessionStorage.getSession(id),
      getStorage: () => auxiliaryStorage,
      getModelCatalogSnapshot: () => buildTestModelCatalogSnapshot(parent.catalogRevision),
      resolveSessionLaunchSelection: async () => {
        resolveSelectionCalls += 1;
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    const deleteParent = coordinator.runExclusive(async () => {
      sessionStorage.deleteSession(parent.id);
      auxiliaryStorage.deleteAuxiliarySessionsForParent(parent.id);
    });
    assert.equal(resolveSelectionCalls, 1);
    releaseSelection();
    await create;
    await deleteParent;
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

// @test-value v1
// kind = "invariant"
// claim = "Auxiliary Sessionは作成時に親のReviewerを引き継ぎ、その後の変更を自身だけへ永続化する"
// oracle = { type = "contract", ref = "CODEX-AUTO-REVIEW-AR-2" }
// failure_mode = "Auxiliaryが親のAuto-reviewを継承しない、再読込で消える、またはAuxiliary変更が親へ漏れる"
// scope = "auxiliary-session-service-storage"
// lifecycle = "permanent"
// @end-test-value
test("Auxiliary Reviewerは親から継承した後に独立して保存する", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-speed-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  let auxiliaryStorage: AuxiliarySessionStorage | null = null;

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

    const updated = service.updateAuxiliarySession({
      ...auxiliary,
      codexSpeed: "standard",
      codexReviewer: "user",
    });
    assert.equal(updated.codexSpeed, "standard");
    assert.equal(service.getAuxiliarySession(auxiliary.id)?.codexSpeed, "standard");
    assert.equal(parent.codexSpeed, "fast");
    assert.equal(updated.codexReviewer, "user");
    assert.equal(service.getAuxiliarySession(auxiliary.id)?.codexReviewer, "user");
    assert.equal(parent.codexReviewer, "auto-review");
  } finally {
    auxiliaryStorage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

// @test-value v1
// kind = "invariant"
// claim = "Auxiliary Session更新は保存済みApprovalがneverの間、他項目を更新しても現在のReviewerを保持する"
// oracle = { type = "contract", ref = "CODEX-AUTO-REVIEW-AR-3" }
// failure_mode = "直接IPCまたはstale payloadがnever中のAuxiliary Reviewerを変更し、後のinteractive復帰で意図しない値が有効になる"
// scope = "auxiliary-session-service"
// lifecycle = "permanent"
// @end-test-value
test("Auxiliary更新は保存済みApprovalがneverの間Reviewerを保持する", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-reviewer-never-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  let auxiliaryStorage: AuxiliarySessionStorage | null = null;

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

    const updated = service.updateAuxiliarySession({
      ...auxiliary,
      title: "Renamed Auxiliary",
      codexReviewer: "user",
    });

    assert.equal(updated.title, "Renamed Auxiliary");
    assert.equal(updated.codexReviewer, "auto-review");
    assert.equal(service.getAuxiliarySession(auxiliary.id)?.codexReviewer, "auto-review");
  } finally {
    auxiliaryStorage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

// @test-value v2
// kind = "contract"
// claim = "active Auxiliary一覧は軽量summary列だけを読み、payload transcriptを再parseしない"
// oracle = { type = "contract", ref = "issue-710-lightweight-summary-read-path" }
// fault = "一覧取得のたびにpayload_jsonを読み直してtranscriptを投影する"
// observable = "listActiveAuxiliarySessionSummariesのJSON.parse入力"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-storage-summary"
// lifecycle = "permanent"
// @end-test-value
test("AuxiliarySessionStorage は指定した parent の active summary だけを返す", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-active-auxiliary-summary-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  let auxiliaryStorage: AuxiliarySessionStorage | null = null;

  try {
    auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
    auxiliaryStorage.upsertAuxiliarySession(buildAuxiliarySession({
      id: "aux-active-session-1",
      parentSessionId: "session-1",
      messages: [{ role: "assistant", text: "full payload" }],
    }));
    auxiliaryStorage.upsertAuxiliarySession(buildAuxiliarySession({
      id: "aux-closed-session-1",
      parentSessionId: "session-1",
      status: "closed",
      messages: [{ role: "assistant", text: "closed-payload-sentinel" }],
      closedAt: "2026-07-30T00:10:00.000Z",
    }));
    auxiliaryStorage.upsertAuxiliarySession(buildAuxiliarySession({
      id: "aux-active-session-2",
      parentSessionId: "session-2",
    }));

    const parsedPayloads: string[] = [];
    const originalJsonParse = JSON.parse;
    JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
      parsedPayloads.push(text);
      return originalJsonParse(text, reviver);
    }) as typeof JSON.parse;
    let summaries: AuxiliarySessionSummary[];
    try {
      summaries = auxiliaryStorage.listActiveAuxiliarySessionSummaries([
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
    assert.deepEqual(auxiliaryStorage.listActiveAuxiliarySessionSummaries([]), []);
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

    assert.deepEqual(resolvedProviderIds, ["codex"]);
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
    assert.deepEqual(service.listAuxiliarySessions(parent.id), []);

    await assert.rejects(
      service.createAuxiliarySession({
        parentSessionId: parent.id,
        provider: "codex",
        runtimeSelection: "latest-session",
        approvalMode: "never",
      }),
      /runtime option を直接指定できない/,
    );
    assert.deepEqual(service.listAuxiliarySessions(parent.id), []);
  } finally {
    auxiliaryStorage?.close();
    sessionStorage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

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
      assert.deepEqual(service.listAuxiliarySessions(parent.id), []);
    }
  } finally {
    auxiliaryStorage?.close();
    sessionStorage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

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
  } finally {
    auxiliaryStorage?.close();
    sessionStorage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

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

    const auxiliary = await service.createAuxiliarySession({
      parentSessionId: companion.id,
      provider: companion.provider,
      approvalMode: companion.approvalMode,
      codexSandboxMode: companion.codexSandboxMode,
    });

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

    service.recoverInterruptedSessions();

    const recovered = service.getAuxiliarySession(auxiliary.id);
    assert.equal(recovered?.runState, "error");
    assert.equal(recovered?.status, "active");
    assert.equal(recovered?.messages.at(-1)?.role, "assistant");
  } finally {
    auxiliaryStorage?.close();
    sessionStorage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

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

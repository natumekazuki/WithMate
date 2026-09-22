import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { buildNewSession } from "../../src-shared/session/session-state.js";
import { DEFAULT_APPROVAL_MODE, type ApprovalMode } from "../../src-shared/settings/approval-mode.js";
import type { AuxiliarySession, AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { AuxiliaryDraftRecord } from "../../src-shared/auxiliary/auxiliary-draft-contract.js";
import {
  DEFAULT_CODEX_SANDBOX_MODE,
  type CodexSandboxMode,
} from "../../src-shared/settings/codex-sandbox-mode.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type { CharacterCatalogEntry, CharacterRuntimeSnapshot } from "../../src-shared/character/character-catalog.js";
import {
  resolveAuxiliaryParentSession,
} from "../../src-electron/auxiliary/auxiliary-parent-session.js";
import { AuxiliarySessionService as AuxiliarySessionServiceImpl } from "../../src-electron/auxiliary/auxiliary-session-service.js";
import {
  AuxiliarySessionStorage,
  resolveLegacyAuxiliaryPreviewFromAuditEntries,
} from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import { ensureV6Schema } from "../../src-electron/storage/database-schema-v6.js";
import { appendSessionFilesDirectoryForSessionId, resolveSessionFilesDirectory } from "../../src-electron/files/session-files.js";
import { SessionStorage } from "../../src-electron/session/session-storage.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";

type AuxiliarySessionServiceDeps = ConstructorParameters<typeof AuxiliarySessionServiceImpl>[0];

class AuxiliarySessionService extends AuxiliarySessionServiceImpl {
  constructor(
    deps: Omit<
      AuxiliarySessionServiceDeps,
      "runProviderRuntimeOperationExclusive" | "resolveSessionLaunchSelection" | "listActiveCharacters" | "createCharacterRuntimeSnapshot"
    > & Partial<
      Pick<
        AuxiliarySessionServiceDeps,
        "runProviderRuntimeOperationExclusive" | "resolveSessionLaunchSelection" | "listActiveCharacters" | "createCharacterRuntimeSnapshot"
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
    codexReviewer: "user",
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

// @test-value v2
// kind = "contract"
// claim = "Auxiliaryの親Session解決はcached summaryより保存済みfull Sessionを優先する"
// oracle = { type = "contract", ref = "src-electron/auxiliary-parent-session.ts" }
// fault = "古いcached summaryを親Sessionとして採用し、保存済みruntime snapshotを失う"
// observable = "resolved parent session and character runtime snapshot"
// observation_boundary = "public-boundary"
// scope = "auxiliary parent session resolution"
// lifecycle = "permanent"
// @end-test-value
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
  });

  assert.equal(resolved, storedSession);
  assert.equal(resolved?.characterRuntimeSnapshot?.definitionMarkdown, "# Character\n\nStored snapshot prompt.");
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliary draft は独立正本としてCAS保存・consumeされ、古いrevisionの操作は新しい本文を消さない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md:1" }
// fault = "古いsave/consumeが最新draftを上書きまたは消去する"
// observable = "draft read/save/consume result and durable revision"
// observation_boundary = "public-boundary"
// scope = "auxiliary-draft-cas"
// lifecycle = "permanent"
// @end-test-value
test("Auxiliary draft storage はCAS保存と送信consumeを分離する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-draft-cas-"));
  const dbPath = path.join(directory, "app.db");
  const parentStorage = new SessionStorage(dbPath);
  parentStorage.upsertSession(buildNewSession({
    id: "session-1",
    taskTitle: "parent",
    workspaceLabel: "workspace",
    workspacePath: "C:/workspace",
    branch: "main",
    characterId: "mate",
    character: "Mate",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    approvalMode: DEFAULT_APPROVAL_MODE,
  }));
  const storage = new AuxiliarySessionStorage(dbPath);
  const session = buildAuxiliarySession({ composerDraft: "legacy" });
  try {
    storage.upsertAuxiliarySession(session);
    const initial = storage.getAuxiliaryDraft(session.id);
    assert.equal(initial?.text, "legacy");
    const saved = storage.saveAuxiliaryDraft({
      auxiliarySessionId: session.id,
      parentSessionId: session.parentSessionId,
      incarnation: initial?.incarnation ?? "",
      expectedDurableRevision: initial?.durableRevision ?? 0,
      text: "latest",
      updatedAt: "2026-07-30T00:01:00.000Z",
    });
    assert.equal(saved.outcome, "saved");
    assert.equal(saved.ack?.incarnation, initial?.incarnation);
    assert.equal(saved.ack?.durableRevision, 1);
    assert.equal("text" in (saved.ack ?? {}), false);
    const stale = storage.saveAuxiliaryDraft({
      auxiliarySessionId: session.id,
      parentSessionId: session.parentSessionId,
      incarnation: initial?.incarnation ?? "",
      expectedDurableRevision: 0,
      text: "old",
      updatedAt: "2026-07-30T00:02:00.000Z",
    });
    assert.equal(stale.outcome, "stale");
    assert.equal(storage.getAuxiliaryDraft(session.id)?.text, "latest");
    const consumed = storage.consumeAuxiliaryDraft({
      auxiliarySessionId: session.id,
      parentSessionId: session.parentSessionId,
      incarnation: initial?.incarnation ?? "",
      expectedDurableRevision: 1,
    });
    assert.equal(consumed.outcome, "consumed");
    assert.equal(consumed.ack?.incarnation, initial?.incarnation);
    assert.equal(consumed.ack?.durableRevision, 2);
    assert.equal(storage.getAuxiliaryDraft(session.id)?.text, "");
    const restored = storage.saveAuxiliaryDraft({
      auxiliarySessionId: session.id,
      parentSessionId: session.parentSessionId,
      incarnation: initial?.incarnation ?? "",
      expectedDurableRevision: 2,
      text: "latest",
      updatedAt: "2026-07-30T00:03:00.000Z",
    });
    assert.equal(restored.outcome, "saved");
    const staleRestore = storage.saveAuxiliaryDraft({
      auxiliarySessionId: session.id,
      parentSessionId: session.parentSessionId,
      incarnation: initial?.incarnation ?? "",
      expectedDurableRevision: 1,
      text: "old restore",
      updatedAt: "2026-07-30T00:04:00.000Z",
    });
    assert.equal(staleRestore.outcome, "stale");
    assert.equal(storage.getAuxiliaryDraft(session.id)?.text, "latest");
  } finally {
    storage.close();
    parentStorage.close();
    await removeDirectoryWithRetry(directory);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary draft の最終transactionは親のread-only境界とdraft rowのowner不一致を拒否する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#persistence" }
// fault = "read-only親または不整合なdraft ownerをwritableとして扱い、本文やownerを更新する"
// observable = "save/consume outcome and persisted draft record"
// observation_boundary = "public-boundary"
// scope = "auxiliary-draft-parent-boundary"
// lifecycle = "permanent"
// @end-test-value
test("Auxiliary draft はread-only親と不整合ownerを更新しない", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-draft-boundary-"));
  const dbPath = path.join(directory, "app.db");
  const parentStorage = new SessionStorage(dbPath);
  const storage = new AuxiliarySessionStorage(dbPath);
  const parent = buildNewSession({
    id: "session-1",
    taskTitle: "parent",
    workspaceLabel: "workspace",
    workspacePath: "C:/workspace",
    branch: "main",
    characterId: "mate",
    character: "Mate",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    approvalMode: DEFAULT_APPROVAL_MODE,
  });
  parentStorage.upsertSession(parent);
  const session = storage.upsertAuxiliarySession(buildAuxiliarySession({ composerDraft: "kept" }));
  const draft = storage.getAuxiliaryDraft(session.id)!;
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE sessions SET access_mode = 'legacy_readonly' WHERE id = ?").run(parent.id);
    assert.equal(storage.saveAuxiliaryDraft({
      auxiliarySessionId: session.id,
      parentSessionId: parent.id,
      incarnation: draft.incarnation,
      expectedDurableRevision: draft.durableRevision,
      text: "must not save",
      updatedAt: "2026-07-30T00:06:00.000Z",
    }).outcome, "rejected");
    assert.equal(storage.consumeAuxiliaryDraft({
      auxiliarySessionId: session.id,
      parentSessionId: parent.id,
      incarnation: draft.incarnation,
      expectedDurableRevision: draft.durableRevision,
    }).outcome, "rejected");
    db.prepare("UPDATE sessions SET access_mode = 'active' WHERE id = ?").run(parent.id);
    db.prepare("UPDATE auxiliary_session_drafts SET parent_session_id = 'other-parent' WHERE auxiliary_session_id = ?")
      .run(session.id);
    assert.equal(storage.saveAuxiliaryDraft({
      auxiliarySessionId: session.id,
      parentSessionId: parent.id,
      incarnation: draft.incarnation,
      expectedDurableRevision: draft.durableRevision,
      text: "must not reassign",
      updatedAt: "2026-07-30T00:07:00.000Z",
    }).outcome, "not-found");
    assert.equal(storage.consumeAuxiliaryDraft({
      auxiliarySessionId: session.id,
      parentSessionId: parent.id,
      incarnation: draft.incarnation,
      expectedDurableRevision: draft.durableRevision,
    }).outcome, "not-found");
    assert.deepEqual(storage.getAuxiliaryDraft(session.id), { ...draft, parentSessionId: "other-parent" });
  } finally {
    db.close();
    storage.close();
    parentStorage.close();
    await removeDirectoryWithRetry(directory);
  }
});

// @test-value v2
// kind = "contract"
// claim = "draftの最終使用時刻は旧full session保存後も一覧summaryとactive選択のrecencyへ投影される"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#persistence" }
// fault = "SQLの並び順だけdraft時刻を使い、rendererへ古いsummary.updatedAtを返して再ソートを逆転させる"
// observable = "list summary updatedAt/order and active full session id"
// observation_boundary = "public-boundary"
// scope = "auxiliary-draft-recency-projection"
// lifecycle = "permanent"
// @end-test-value
test("Auxiliary draft recency は旧full保存後も一覧とactive選択へ反映される", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-draft-recency-"));
  const dbPath = path.join(directory, "app.db");
  const parentStorage = new SessionStorage(dbPath);
  const storage = new AuxiliarySessionStorage(dbPath);
  try {
    parentStorage.upsertSession(buildNewSession({
      id: "parent-recency",
      taskTitle: "parent",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "mate",
      character: "Mate",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
    }));
    const first = buildAuxiliarySession({ id: "aux-recency-first", parentSessionId: "parent-recency", updatedAt: "2026-09-19T00:10:00.000Z" });
    const second = buildAuxiliarySession({ id: "aux-recency-second", parentSessionId: "parent-recency", updatedAt: "2026-09-19T00:20:00.000Z" });
    storage.upsertAuxiliarySession(first);
    storage.upsertAuxiliarySession(second);
    const draft = storage.getAuxiliaryDraft(first.id)!;
    assert.equal(storage.saveAuxiliaryDraft({
      auxiliarySessionId: first.id,
      parentSessionId: first.parentSessionId,
      incarnation: draft.incarnation,
      expectedDurableRevision: draft.durableRevision,
      text: "recent draft",
      updatedAt: "2026-09-19T01:00:00.000Z",
    }).outcome, "saved");
    storage.upsertAuxiliarySession({ ...first, updatedAt: "2026-09-19T00:05:00.000Z", composerDraft: "stale full value" });
    const summaries = storage.listAuxiliarySessions(first.parentSessionId);
    assert.equal(summaries[0]?.id, first.id);
    assert.equal(summaries[0]?.updatedAt, "2026-09-19T01:00:00.000Z");
    assert.equal(storage.getActiveAuxiliarySession(first.parentSessionId)?.id, first.id);
  } finally {
    storage.close();
    parentStorage.close();
    await removeDirectoryWithRetry(directory);
  }
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliary turn draft operation はconsume後の失敗だけをCAS復元し、後続saveを古い復元で上書きしない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#persistence" }
// fault = "consume後のadmission失敗でdraftを失う、または後続saveを古い復元で上書きする"
// observable = "runtime callback count, quit barrier result, and durable draft text/revision"
// observation_boundary = "public-boundary"
// scope = "auxiliary-turn-draft-operation"
// lifecycle = "permanent"
// @end-test-value
test("Auxiliary turn draft operation は失敗時復元と後続save保全を行う", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-turn-draft-"));
  const dbPath = path.join(directory, "app.db");
  const parentStorage = new SessionStorage(dbPath);
  const auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
  parentStorage.upsertSession(buildNewSession({
    id: "session-1",
    taskTitle: "parent",
    workspaceLabel: "workspace",
    workspacePath: "C:/workspace",
    branch: "main",
    characterId: "mate",
    character: "Mate",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    approvalMode: DEFAULT_APPROVAL_MODE,
  }));
  const session = auxiliaryStorage.upsertAuxiliarySession(buildAuxiliarySession({ composerDraft: "raw draft" }));
  const draft = auxiliaryStorage.getAuxiliaryDraft(session.id)!;
  const service = new AuxiliarySessionService({
    getParentSession: (id) => id === "session-1" ? parentStorage.getSession(id) : null,
    getStorage: () => auxiliaryStorage,
  });
  let runs = 0;
  try {
    await assert.rejects(service.runAuxiliaryTurnWithDraft({
      auxiliarySessionId: session.id,
      parentSessionId: session.parentSessionId,
      incarnation: draft.incarnation,
      expectedDurableRevision: draft.durableRevision,
      userMessage: "trimmed",
      run: async () => { runs += 1; throw new Error("admission failed"); },
    }), /admission failed/);
    assert.equal(runs, 1);
    assert.equal(auxiliaryStorage.getAuxiliaryDraft(session.id)?.text, "raw draft");
    assert.equal(auxiliaryStorage.getAuxiliaryDraft(session.id)?.durableRevision, draft.durableRevision + 2);

    const next = auxiliaryStorage.getAuxiliaryDraft(session.id)!;
    await assert.rejects(service.runAuxiliaryTurnWithDraft({
      auxiliarySessionId: session.id,
      parentSessionId: session.parentSessionId,
      incarnation: next.incarnation,
      expectedDurableRevision: next.durableRevision,
      userMessage: "ignored",
      run: async () => {
        const current = auxiliaryStorage.getAuxiliaryDraft(session.id)!;
        const saved = auxiliaryStorage.saveAuxiliaryDraft({
          auxiliarySessionId: session.id,
          parentSessionId: session.parentSessionId,
          incarnation: current.incarnation,
          expectedDurableRevision: current.durableRevision,
          text: "new pending",
          updatedAt: "2026-07-30T00:05:00.000Z",
        });
        assert.equal(saved.outcome, "saved");
        throw new Error("runtime failed");
      },
    }), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /draft restore failed/);
      assert.equal(error.errors[0]?.message, "runtime failed");
      return true;
    });
    assert.equal(await service.waitForPendingDraftSends(), true);
    assert.equal(auxiliaryStorage.getAuxiliaryDraft(session.id)?.text, "new pending");
    assert.equal(auxiliaryStorage.getAuxiliaryDraft(session.id)?.durableRevision, next.durableRevision + 2);
  } finally {
    auxiliaryStorage.close();
    parentStorage.close();
    await removeDirectoryWithRetry(directory);
  }
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliary送信の終了待ちは先にsettleした復元失敗も再保存まで保持し、永続済の編集・削除・再作成を上書きせず解消する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#persistence" }
// fault = "DB closeが送信runまたは失敗時復元より先に進み、再起動後にconsume済みdraftが空になる"
// observable = "pending barrier settlement, repeated quit failure after send settlement, restored SQLite draft after reopening, and unchanged later durable state"
// observation_boundary = "public-boundary"
// scope = "auxiliary-send-settlement-barrier"
// lifecycle = "permanent"
// @end-test-value
test("Auxiliary送信の終了待ちは実SQLiteのconsumeと復元保存まで待つ", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-send-settlement-"));
  const dbPath = path.join(directory, "app.db");
  const parentStorage = new SessionStorage(dbPath);
  let auxiliaryStorage: AuxiliarySessionStorage | null = new AuxiliarySessionStorage(dbPath);
  const parent = buildNewSession({
    id: "session-send-settlement",
    taskTitle: "parent",
    workspaceLabel: "workspace",
    workspacePath: "C:/workspace",
    branch: "main",
    characterId: "mate",
    character: "Mate",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    approvalMode: DEFAULT_APPROVAL_MODE,
  });
  parentStorage.upsertSession(parent);
  let heldRestore: Promise<void> | null = null;
  let notifyRestoreStarted: (() => void) | undefined;
  let failRestore = false;
  const service = new AuxiliarySessionService({
    getParentSession: (id) => id === parent.id ? parentStorage.getSession(id) : null,
    getStorage: () => {
      if (!auxiliaryStorage) throw new Error("storage closed");
      // The production Worker adapter is asynchronous; gate only its save boundary.
      const storage = auxiliaryStorage;
      return new Proxy(storage, {
        get(target, key) {
          if (key === "saveAuxiliaryDraft") return async (input: Parameters<typeof storage.saveAuxiliaryDraft>[0]) => {
            notifyRestoreStarted?.();
            if (heldRestore) await heldRestore;
            if (failRestore) throw new Error("injected restore failure");
            return storage.saveAuxiliaryDraft(input);
          };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  });
  let releaseRun!: () => void;
  let runStarted: (() => void) | null = null;
  const started = new Promise<void>((resolve) => { runStarted = resolve; });
  const runGate = new Promise<void>((resolve) => { releaseRun = resolve; });
  let releaseLookup!: () => void;
  const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
  try {
    const session = auxiliaryStorage.upsertAuxiliarySession(buildAuxiliarySession({
      id: "aux-send-settlement",
      parentSessionId: parent.id,
      composerDraft: "deferred draft",
    }));
    const initial = auxiliaryStorage.getAuxiliaryDraft(session.id)!;
    const operation = service.trackPendingDraftSend(async () => {
      await lookupGate;
      return await service.runAuxiliaryTurnWithDraft({
        auxiliarySessionId: session.id,
        parentSessionId: parent.id,
        incarnation: initial.incarnation,
        expectedDurableRevision: initial.durableRevision,
        userMessage: "deferred draft",
        run: async () => {
          runStarted?.();
          await runGate;
          throw new Error("runtime failed after admission");
        },
      });
    });
    let barrierSettled = false;
    const barrier = service.waitForPendingDraftSends().then((result) => { barrierSettled = true; return result; });
    releaseLookup();
    await started;
    assert.equal(barrierSettled, false, "quit must wait even if only the outer IPC lookup existed at the barrier");
    assert.equal(auxiliaryStorage.getAuxiliaryDraft(session.id)?.text, "");
    let releaseRestore!: () => void;
    heldRestore = new Promise<void>((resolve) => { releaseRestore = resolve; });
    const restoreStarted = new Promise<void>((resolve) => { notifyRestoreStarted = resolve; });
    releaseRun();
    await restoreStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(barrierSettled, false, "a failed run is not settled until its restoration save finishes");
    releaseRestore();
    await assert.rejects(operation, /runtime failed after admission/);
    assert.equal(await barrier, true);
    heldRestore = null;

    auxiliaryStorage.close();
    auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
    assert.equal(auxiliaryStorage.getAuxiliaryDraft(session.id)?.text, "deferred draft");

    const failedSession = auxiliaryStorage.upsertAuxiliarySession(buildAuxiliarySession({
      id: "aux-send-settlement-failed",
      parentSessionId: parent.id,
      composerDraft: "must restore",
    }));
    const failedInitial = auxiliaryStorage.getAuxiliaryDraft(failedSession.id)!;
    let releaseFailedRun!: () => void;
    const failedRun = new Promise<void>((resolve) => { releaseFailedRun = resolve; });
    let failedStarted: (() => void) | null = null;
    const failedStartedPromise = new Promise<void>((resolve) => { failedStarted = resolve; });
    let releaseFailedLookup!: () => void;
    const failedLookup = new Promise<void>((resolve) => { releaseFailedLookup = resolve; });
    const failedOperation = service.trackPendingDraftSend(async () => {
      await failedLookup;
      return service.runAuxiliaryTurnWithDraft({
        auxiliarySessionId: failedSession.id,
        parentSessionId: parent.id,
        incarnation: failedInitial.incarnation,
        expectedDurableRevision: failedInitial.durableRevision,
        userMessage: "must restore",
        run: async () => {
          failedStarted?.();
          await failedRun;
          throw new Error("runtime failed");
        },
      });
    });
    const failedBarrier = service.waitForPendingDraftSends();
    releaseFailedLookup();
    await failedStartedPromise;
    failRestore = true;
    releaseFailedRun();
    await assert.rejects(failedOperation, /draft restore failed/);
    assert.equal(await failedBarrier, false);
    assert.equal(auxiliaryStorage.getAuxiliaryDraft(failedSession.id)?.text, "");
    // Another Window can still be awaiting its ACK when this send finishes.
    // Starting the Main barrier later must not forget the failed restoration.
    assert.equal(await service.waitForPendingDraftSends(), false);
    assert.equal(await service.waitForPendingDraftSends(), false);

    failRestore = false;
    let releaseRetry!: () => void;
    heldRestore = new Promise<void>((resolve) => { releaseRetry = resolve; });
    const retryStarted = new Promise<void>((resolve) => { notifyRestoreStarted = resolve; });
    let retrySettled = false;
    const retry = service.waitForPendingDraftSends().then((result) => { retrySettled = true; return result; });
    await retryStarted;
    assert.equal(retrySettled, false);
    releaseRetry();
    assert.equal(await retry, true);
    heldRestore = null;
    assert.equal(await service.waitForPendingDraftSends(), true);
    auxiliaryStorage.close();
    auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
    assert.equal(auxiliaryStorage.getAuxiliaryDraft(failedSession.id)?.text, "must restore");

    for (const resolution of ["saved", "deleted", "recreated"] as const) {
      const laterSession = auxiliaryStorage.upsertAuxiliarySession(buildAuxiliarySession({
        id: `aux-recovery-${resolution}`,
        parentSessionId: parent.id,
        composerDraft: "old failed draft",
      }));
      const original = auxiliaryStorage.getAuxiliaryDraft(laterSession.id)!;
      failRestore = true;
      await assert.rejects(service.runAuxiliaryTurnWithDraft({
        auxiliarySessionId: laterSession.id,
        parentSessionId: parent.id,
        incarnation: original.incarnation,
        expectedDurableRevision: original.durableRevision,
        userMessage: original.text,
        run: async () => { throw new Error("runtime failed"); },
      }), /draft restore failed/);
      failRestore = false;
      if (resolution === "saved") {
        const consumed: AuxiliaryDraftRecord = auxiliaryStorage.getAuxiliaryDraft(laterSession.id)!;
        assert.equal((await service.saveAuxiliaryDraft({
          auxiliarySessionId: laterSession.id,
          parentSessionId: parent.id,
          incarnation: consumed.incarnation,
          expectedDurableRevision: consumed.durableRevision,
          text: "",
          updatedAt: "2026-09-20T00:00:00.000Z",
        })).outcome, "saved", "a deliberate empty edit also supersedes recovery");
      } else {
        auxiliaryStorage.deleteAuxiliarySessionsForParent(parent.id);
        if (resolution === "recreated") {
          auxiliaryStorage.upsertAuxiliarySession({ ...laterSession, composerDraft: "replacement" });
          assert.notEqual(auxiliaryStorage.getAuxiliaryDraft(laterSession.id)?.incarnation, original.incarnation);
        }
      }
      const expected = auxiliaryStorage.getAuxiliaryDraft(laterSession.id);
      assert.equal(await service.waitForPendingDraftSends(), true);
      assert.deepEqual(auxiliaryStorage.getAuxiliaryDraft(laterSession.id), expected);
    }
  } finally {
    auxiliaryStorage?.close();
    parentStorage.close();
    await removeDirectoryWithRetry(directory);
  }
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
    const updatedDraft = await service.getAuxiliaryDraft(auxiliary.id);
    assert.ok(updatedDraft);
    assert.equal((await service.saveAuxiliaryDraft({
      auxiliarySessionId: auxiliary.id,
      parentSessionId: auxiliary.parentSessionId,
      incarnation: updatedDraft.incarnation,
      expectedDurableRevision: updatedDraft.durableRevision,
      text: "review this diff",
      updatedAt: "2026-05-23T00:00:00.000Z",
    })).outcome, "saved");
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
      ...movedDisplayAnchor,
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
    assert.equal(persistedRuntime.composerDraft, "review this diff");
    assert.equal(persistedRuntime.codexSandboxMode, DEFAULT_CODEX_SANDBOX_MODE);
    assert.equal(persistedRuntime.preview, "done");
    for (const runState of ["running", "error", "idle"] as const) {
      const preserved = await service.upsertAuxiliaryRuntimeSession({
        ...runtimeSession,
        runState,
        messages: [...persistedRuntime.messages, { role: "assistant", text: "中間通知" }],
        updatedAt: `2026-05-24T00:00:0${runState === "running" ? "1" : runState === "error" ? "2" : "3"}.000Z`,
      });
      assert.equal(preserved.preview, "done");
    }
    const staleDraftUpdate = await service.updateAuxiliarySession({
      ...updated,
      composerDraft: "review this diff",
    });
    assert.equal(staleDraftUpdate.composerDraft, "review this diff");
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
    const resetDraft = await service.getAuxiliaryDraft(staleRendererSave.id);
    assert.ok(resetDraft);
    await service.saveAuxiliaryDraft({
      auxiliarySessionId: staleRendererSave.id,
      parentSessionId: staleRendererSave.parentSessionId,
      incarnation: resetDraft.incarnation,
      expectedDurableRevision: resetDraft.durableRevision,
      text: "draft after catalog reset",
      updatedAt: "2026-05-23T00:01:00.000Z",
    });
    assert.equal(staleRendererSave.catalogRevision, migratedAuxiliary.catalogRevision);
    assert.equal(staleRendererSave.model, "gpt-5.4-mini");
    assert.equal(staleRendererSave.reasoningEffort, "medium");
    assert.equal(staleRendererSave.threadId, "");
    assert.equal((await service.getAuxiliarySession(staleRendererSave.id))?.composerDraft, "draft after catalog reset");

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
    const credentialDraft = await service.getAuxiliaryDraft(staleThreadRendererSave.id);
    assert.ok(credentialDraft);
    await service.saveAuxiliaryDraft({
      auxiliarySessionId: staleThreadRendererSave.id,
      parentSessionId: staleThreadRendererSave.parentSessionId,
      incarnation: credentialDraft.incarnation,
      expectedDurableRevision: credentialDraft.durableRevision,
      text: "draft after credential reset",
      updatedAt: "2026-05-23T00:02:00.000Z",
    });
    assert.equal((await service.getAuxiliarySession(staleThreadRendererSave.id))?.composerDraft, "draft after credential reset");

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
    const modelDraft = await service.getAuxiliaryDraft(draftBeforeModelChange.id);
    assert.ok(modelDraft);
    await service.saveAuxiliaryDraft({
      auxiliarySessionId: draftBeforeModelChange.id,
      parentSessionId: draftBeforeModelChange.parentSessionId,
      incarnation: modelDraft.incarnation,
      expectedDurableRevision: modelDraft.durableRevision,
      text: "draft saved before model change",
      updatedAt: "2026-05-23T00:03:00.000Z",
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
    assert.equal((await service.getAuxiliarySession(explicitModelChange.id))?.composerDraft, "draft saved before model change");

    const userChangedModelWithDraft = auxiliaryStorage.upsertAuxiliarySession({
      ...explicitModelChange,
      composerDraft: "current draft with skill snippet",
    });
    const skillDraft = await service.getAuxiliaryDraft(userChangedModelWithDraft.id);
    assert.ok(skillDraft);
    await service.saveAuxiliaryDraft({
      auxiliarySessionId: userChangedModelWithDraft.id,
      parentSessionId: userChangedModelWithDraft.parentSessionId,
      incarnation: skillDraft.incarnation,
      expectedDurableRevision: skillDraft.durableRevision,
      text: "current draft with skill snippet",
      updatedAt: "2026-05-23T00:04:00.000Z",
    });
    const staleDraftAfterModelChange = await service.updateAuxiliarySession({
      ...userChangedModelWithDraft,
      catalogRevision: userChangedModelWithDraft.catalogRevision,
      composerDraft: "stale draft before model change",
    });
    assert.equal(staleDraftAfterModelChange.catalogRevision, userChangedModelWithDraft.catalogRevision);
    assert.equal(staleDraftAfterModelChange.model, userChangedModelWithDraft.model);
    assert.equal(staleDraftAfterModelChange.reasoningEffort, userChangedModelWithDraft.reasoningEffort);
    assert.equal((await service.getAuxiliarySession(staleDraftAfterModelChange.id))?.composerDraft, "current draft with skill snippet");

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
    assert.equal((await service.getAuxiliarySession(staleSaveAfterCatalogReset.id))?.composerDraft, "current draft with skill snippet");

    const userConfiguredAuxiliary = auxiliaryStorage.upsertAuxiliarySession({
      ...staleSaveAfterCatalogReset,
      approvalMode: "on-request",
      codexSandboxMode: "workspace-write-network",
      customAgentName: "reviewer",
      allowedAdditionalDirectories: ["C:/shared", "C:/review-context"],
      composerDraft: "current visible draft",
    });
    const staleDraftAfterSettingsChange = await service.updateAuxiliarySession({
      ...userConfiguredAuxiliary,
      composerDraft: "draft saved after settings change",
    });
    assert.equal(staleDraftAfterSettingsChange.approvalMode, userConfiguredAuxiliary.approvalMode);
    assert.equal(staleDraftAfterSettingsChange.codexSandboxMode, userConfiguredAuxiliary.codexSandboxMode);
    assert.equal(staleDraftAfterSettingsChange.customAgentName, userConfiguredAuxiliary.customAgentName);
    assert.deepEqual(staleDraftAfterSettingsChange.allowedAdditionalDirectories, userConfiguredAuxiliary.allowedAdditionalDirectories);
    assert.equal((await service.getAuxiliarySession(staleDraftAfterSettingsChange.id))?.composerDraft, userConfiguredAuxiliary.composerDraft);

    auxiliaryStorage.upsertAuxiliarySession({ ...staleDraftAfterSettingsChange, runState: "running" });
    await assert.rejects(
      service.closeAuxiliarySession(auxiliary.id),
      /実行中の Auxiliary Session は終了できない/,
    );
    auxiliaryStorage.upsertAuxiliarySession(staleDraftAfterSettingsChange);

    const closed = await service.closeAuxiliarySession(auxiliary.id);
    assert.equal(closed.status, "closed");
    assert.equal(closed.composerDraft, "current draft with skill snippet");
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
    sessionStorage.deleteSession(parent.id);
    assert.deepEqual(await service.listAuxiliarySessions(parent.id), []);
  } finally {
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
        approvalMode: DEFAULT_APPROVAL_MODE,
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
    const firstDraft = await service.getAuxiliaryDraft(first.id);
    assert.ok(firstDraft);
    await service.saveAuxiliaryDraft({
      auxiliarySessionId: first.id,
      parentSessionId: first.parentSessionId,
      incarnation: firstDraft.incarnation,
      expectedDurableRevision: firstDraft.durableRevision,
      text: "keep me",
      updatedAt: "2026-05-23T00:00:00.000Z",
    });
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
        approvalMode: DEFAULT_APPROVAL_MODE,
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
    const coordinator = new (await import("../../src-electron/character/character-affect-turn-ownership-coordinator.js")).CharacterAffectTurnOwnershipCoordinator();
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
        approvalMode: DEFAULT_APPROVAL_MODE,
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
// claim = "Auxiliaryのlatest-session作成は再検証で同値だったresolverのruntime設定を保存し、driftした再検証結果は拒否する"
// oracle = { type = "contract", ref = "docs/adr/007-provider-runtime-selection-inheritance.md" }
// fault = "resolverから受け取ったmodel・権限・custom agentを親または既定値で上書きして保存する"
// observable = "resolverに渡したprovider、同値選択を保存したAuxiliaryのruntime選択、およびdrift時のreject"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-runtime-selection"
// lifecycle = "permanent"
// @end-test-value
test("AuxiliarySessionService は latest-session 選択を保存し、再検証のdriftを拒否する", async () => {
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
    const expectedSelection = {
      provider: "codex",
      catalogRevision: 8,
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      approvalMode: "never",
      codexSandboxMode: "read-only",
      codexSpeed: "standard",
      codexReviewer: "user",
      customAgentName: "latest-agent",
    } as const;
    const createService = (drift: boolean) => {
      const resolvedProviderIds: Array<string | null | undefined> = [];
      let invocation = 0;
      const service = new AuxiliarySessionService({
        getParentSession: (requestedParentSessionId) => sessionStorage?.getSession(requestedParentSessionId) ?? null,
        getStorage: () => auxiliaryStorage!,
        getModelCatalogSnapshot: () => buildTestModelCatalogSnapshot(parent.catalogRevision),
        resolveSessionLaunchSelection: async (providerId) => {
          resolvedProviderIds.push(providerId);
          invocation += 1;
          if (drift && invocation === 2) {
            return {
              ...expectedSelection,
              model: "gpt-5.4",
              reasoningEffort: "high",
              approvalMode: "on-request",
              codexSandboxMode: "workspace-write",
              codexSpeed: "fast",
              codexReviewer: "auto-review",
              customAgentName: "drifted-agent",
            };
          }
          return expectedSelection;
        },
      });
      return { service, resolvedProviderIds };
    };

    const successful = createService(false);
    const auxiliary = await successful.service.createAuxiliarySession({
      parentSessionId: parent.id,
      provider: "codex",
      runtimeSelection: "latest-session",
    });
    assert.deepEqual(successful.resolvedProviderIds, ["codex", "codex"]);
    assert.equal(auxiliary.provider, expectedSelection.provider);
    assert.equal(auxiliary.catalogRevision, expectedSelection.catalogRevision);
    assert.equal(auxiliary.model, expectedSelection.model);
    assert.equal(auxiliary.reasoningEffort, expectedSelection.reasoningEffort);
    assert.equal(auxiliary.approvalMode, expectedSelection.approvalMode);
    assert.equal(auxiliary.codexSandboxMode, expectedSelection.codexSandboxMode);
    assert.equal(auxiliary.codexSpeed, expectedSelection.codexSpeed);
    assert.equal(auxiliary.codexReviewer, expectedSelection.codexReviewer);
    assert.equal(auxiliary.customAgentName, expectedSelection.customAgentName);

    const driftParent = { ...parent, id: "session-main-drift" };
    sessionStorage.upsertSession(driftParent);
    const drifted = createService(true);
    await assert.rejects(
      drifted.service.createAuxiliarySession({
        parentSessionId: driftParent.id,
        provider: "codex",
        runtimeSelection: "latest-session",
      }),
      /runtime 選択が作成中に変わったため/,
    );
    assert.deepEqual(drifted.resolvedProviderIds, ["codex", "codex"]);
    assert.deepEqual(await auxiliaryStorage.listAuxiliarySessions(driftParent.id), []);
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
// claim = "Auxiliary summary maintenance primitive は一回の呼び出しを要求batch以内に制限し、壊れたpayloadを完了扱いにせず残件として返す"
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
      db.prepare(`
        INSERT INTO auxiliary_session_drafts
          (auxiliary_session_id, parent_session_id, incarnation, durable_revision, draft_text, updated_at)
        VALUES (?, ?, ?, 0, '', ?)
      `).run(
        "aux-z-malformed",
        "parent-bounded-maintenance",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
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
// kind = "contract"
// claim = "Auxiliary draft migration はactive/closed行をatomicに移行し、不正payloadでは全体をrollbackする"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#persistence" }
// fault = "移行途中のcommitや不正draftの空文字化で入力を失い、再実行できない状態になる"
// observable = "migration例外、draft rowの有無、active/closed textとupdatedAt"
// observation_boundary = "public-boundary"
// scope = "auxiliary-draft-migration"
// lifecycle = "permanent"
// @end-test-value
test("Auxiliary draft migration はactive/closedを移行しmalformed payloadをrollbackする", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-draft-migration-"));
  const dbPath = path.join(directory, "app.db");
  const initialStorage = new AuxiliarySessionStorage(dbPath);
  const active = buildAuxiliarySession({ id: "aux-migrate-active", composerDraft: "active draft", updatedAt: "2026-09-19T01:00:00.000Z" });
  const closed = buildAuxiliarySession({ id: "aux-migrate-closed", status: "closed", composerDraft: "closed draft", updatedAt: "2026-09-19T02:00:00.000Z" });
  initialStorage.upsertAuxiliarySession(active);
  initialStorage.upsertAuxiliarySession(closed);
  initialStorage.close();
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec("DROP TABLE auxiliary_session_drafts");
    const malformed = { ...closed, composerDraft: 42 };
    raw.prepare("UPDATE auxiliary_sessions SET payload_json = ?, summary_json = '' WHERE id = ?")
      .run(JSON.stringify(malformed), closed.id);
    raw.prepare("UPDATE auxiliary_sessions SET payload_json = ?, summary_json = '' WHERE id = ?")
      .run(JSON.stringify(active), active.id);
  } finally {
    raw.close();
  }
  assert.throws(() => new AuxiliarySessionStorage(dbPath), /Auxiliary draft migration payload is invalid/);
  const verifyRollback = new DatabaseSync(dbPath);
  try {
    assert.equal((verifyRollback.prepare("SELECT COUNT(*) AS count FROM auxiliary_session_drafts").get() as { count: number }).count, 0);
    assert.equal(JSON.parse((verifyRollback.prepare("SELECT payload_json FROM auxiliary_sessions WHERE id = ?").get(active.id) as { payload_json: string }).payload_json).composerDraft, "active draft");
    assert.equal(JSON.parse((verifyRollback.prepare("SELECT payload_json FROM auxiliary_sessions WHERE id = ?").get(closed.id) as { payload_json: string }).payload_json).composerDraft, 42);
    verifyRollback.prepare("UPDATE auxiliary_sessions SET payload_json = ?, summary_json = '' WHERE id = ?")
      .run(JSON.stringify(closed), closed.id);
  } finally {
    verifyRollback.close();
  }
  const migrated = new AuxiliarySessionStorage(dbPath);
  try {
    assert.equal(migrated.getAuxiliarySession(active.id)?.composerDraft, "active draft");
    assert.equal(migrated.getAuxiliarySession(closed.id)?.composerDraft, "closed draft");
    const draftDb = new DatabaseSync(dbPath);
    try {
      const rows = (draftDb.prepare("SELECT auxiliary_session_id, updated_at FROM auxiliary_session_drafts ORDER BY auxiliary_session_id").all() as Array<{ auxiliary_session_id: string; updated_at: string }>).map((row) => ({ ...row }));
      assert.deepEqual(rows, [
        { auxiliary_session_id: active.id, updated_at: active.updatedAt },
        { auxiliary_session_id: closed.id, updated_at: closed.updatedAt },
      ]);
      for (const id of [active.id, closed.id]) {
        const payload = JSON.parse((draftDb.prepare("SELECT payload_json FROM auxiliary_sessions WHERE id = ?").get(id) as { payload_json: string }).payload_json) as Record<string, unknown>;
        assert.equal(Object.hasOwn(payload, "composerDraft"), false);
      }
    } finally {
      draftDb.close();
    }
  } finally {
    migrated.close();
    await removeDirectoryWithRetry(directory);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary runtime metadata CAS は payload の本文と draft を保持し stale patch を拒否する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#persistence" }
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
// claim = "親Sessionのdeleteはlegacy/V6どちらの正規storage経路でもAuxiliaryと独立draftを同時に除去する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#persistence" }
// fault = "親削除でAuxiliary本文だけを消し、独立draft rowを孤児として残す"
// observable = "親削除後のAuxiliary readとdraft read"
// observation_boundary = "public-boundary"
// scope = "auxiliary-draft-parent-delete"
// lifecycle = "permanent"
// @end-test-value
test("legacy/V6親削除はAuxiliary draft rowも除去する", async () => {
  for (const kind of ["legacy", "v6"] as const) {
    const directory = await mkdtemp(path.join(os.tmpdir(), `withmate-auxiliary-parent-delete-${kind}-`));
    const dbPath = path.join(directory, "app.db");
    const parentStorage = kind === "legacy" ? new SessionStorage(dbPath) : new SessionStorageV6(dbPath);
    const auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
    try {
      const parent = buildNewSession({
        id: `parent-delete-${kind}`,
        taskTitle: "parent",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "mate",
        character: "Mate",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      });
      parentStorage.upsertSession(parent);
      const auxiliary = auxiliaryStorage.upsertAuxiliarySession(buildAuxiliarySession({ parentSessionId: parent.id, composerDraft: "orphan check" }));
      assert.equal(auxiliaryStorage.getAuxiliaryDraft(auxiliary.id)?.text, "orphan check");
      parentStorage.deleteSession(parent.id);
      assert.equal(auxiliaryStorage.getAuxiliarySession(auxiliary.id), null);
      assert.equal(auxiliaryStorage.getAuxiliaryDraft(auxiliary.id), null);
    } finally {
      auxiliaryStorage.close();
      parentStorage.close();
      await removeDirectoryWithRetry(directory);
    }
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
      approvalMode: DEFAULT_APPROVAL_MODE,
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
      approvalMode: DEFAULT_APPROVAL_MODE,
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
    const draftBeforeRuntimeUpdate = storage.getAuxiliaryDraft(session.id)!;
    assert.equal(storage.saveAuxiliaryDraft({
      auxiliarySessionId: session.id,
      parentSessionId: session.parentSessionId,
      incarnation: draftBeforeRuntimeUpdate.incarnation,
      expectedDurableRevision: draftBeforeRuntimeUpdate.durableRevision,
      text: "draft-only change",
      updatedAt: "2026-08-02T00:00:30.000Z",
    }).outcome, "saved");
    const runtimeAfterDraftChange = storage.getAuxiliarySession(session.id)!;
    const runtimeUpdated = storage.updateAuxiliarySessionIfMatches({
      session: { ...runtimeAfterDraftChange, title: "runtime after draft", updatedAt: "2026-08-02T00:00:45.000Z" },
      expectedSession: updated!,
    });
    assert.equal(runtimeUpdated?.title, "runtime after draft");
    assert.equal(storage.getAuxiliaryDraft(session.id)?.text, "draft-only change");
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
// claim = "Auxiliary serviceはcaptured storage ownerへ更新し、親削除後はそのownerで更新を拒否する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#persistence" }
// fault = "await中のstorage交換で更新を新storageへretargetする、または親削除後に旧rowを更新する"
// observable = "captured old storageの更新成功、新storageのsentinel不変、親削除後の更新拒否と旧row不在"
// observation_boundary = "public-boundary"
// scope = "auxiliary-service-read-write-owner-barrier"
// lifecycle = "permanent"
// impact = "削除済みAuxiliaryの本文がstorage交換後に復活する"
// distinction = "serviceの実read barrierとSQLite CASを組み合わせ、storage直呼出しだけの検証と区別する"
// @end-test-value
test("Auxiliary serviceはcaptured ownerへ更新し親削除後の更新を拒否する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-service-owner-barrier-"));
  const dbPath = path.join(directory, "withmate.db");
  const storage = new AuxiliarySessionStorage(dbPath);
  const parentStorage = new SessionStorage(dbPath);
  try {
    const session = buildAuxiliarySession({ id: "aux-service-owner-barrier", parentSessionId: "parent-service-owner-barrier" });
    parentStorage.upsertSession(buildNewSession({
      id: session.parentSessionId,
      taskTitle: "parent",
      approvalMode: DEFAULT_APPROVAL_MODE,
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
    const replacementStorage = new AuxiliarySessionStorage(path.join(directory, "replacement.db"));
    activeStorage = replacementStorage;
    const replacementParentStorage = new SessionStorage(path.join(directory, "replacement.db"));
    try {
      replacementParentStorage.upsertSession(buildNewSession({
        id: session.parentSessionId,
        taskTitle: "replacement parent",
        approvalMode: DEFAULT_APPROVAL_MODE,
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "mate",
        character: "Mate",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      }));
      activeStorage.upsertAuxiliarySession({ ...session, title: "replacement sentinel" });
      releaseRead();
      const updated = await update;
      assert.equal(updated.title, "must not return");
      assert.equal(storage.getAuxiliarySession(session.id)?.title, "must not return");
      assert.equal(activeStorage.getAuxiliarySession(session.id)?.title, "replacement sentinel");
      assert.equal(storageRequests, 1);

      let releaseDeletionRead!: () => void;
      const deletionReadBarrier = new Promise<void>((resolve) => { releaseDeletionRead = resolve; });
      const deletionCapturedStorage = {
        getAuxiliarySession: async () => {
          const captured = storage.getAuxiliarySession(session.id);
          await deletionReadBarrier;
          return captured;
        },
        updateAuxiliarySessionIfMatches: storage.updateAuxiliarySessionIfMatches.bind(storage),
      } as unknown as AuxiliarySessionStorage;
      let deletionStorageRequests = 0;
      activeStorage = deletionCapturedStorage;
      const deletionService = new AuxiliarySessionService({
        getParentSession: () => parentStorage.getSession(session.parentSessionId),
        getStorage: () => { deletionStorageRequests += 1; return activeStorage; },
      });
      const deletionUpdate = deletionService.updateAuxiliarySession({ ...updated, title: "must reject" });
      storage.deleteAuxiliarySessionsForParent(session.parentSessionId);
      parentStorage.deleteSession(session.parentSessionId);
      releaseDeletionRead();
      await assert.rejects(deletionUpdate, /削除または更新されたため/);
      assert.equal(storage.getAuxiliarySession(session.id), null);
      assert.equal(replacementStorage.getAuxiliarySession(session.id)?.title, "replacement sentinel");
      assert.equal(deletionStorageRequests, 1);
    } finally {
      replacementParentStorage.close();
      replacementStorage.close();
    }
  } finally {
    storage.close();
    parentStorage.close();
    await removeDirectoryWithRetry(directory);
  }
});
